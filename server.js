const crypto = require('crypto');
const express = require('express');
const { google } = require('googleapis');
const https = require('https');

const app = express();
app.use(express.text({ type: '*/*', limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));

// ═══════════════════════════════════════════════════════════════════════
// Frota162 — Autogestão Pré-Vendas (repositório isolado)
// Webhook Salesbud (Ligação + WhatsApp) → captura crua no Sheets →
// cron semanal agrega, pontua com Claude (rubric próprio, NUNCA usa
// analytics.score da Salesbud) → HTML por canal + consolidado → Drive + Slack.
// ═══════════════════════════════════════════════════════════════════════

// ─── Config fixa ─────────────────────────────────────────────────────
const PRE_VENDAS_USER_MAP = {
  '15368': 'Carlos',
  '15365': 'Vitor',
  '15366': 'Juliana',
  '15367': 'Iquiara',
  '15363': 'Karina',
  '15364': 'Vinícius',
};

const PRE_VENDAS_PERFIL = {
  'Carlos': 'Outbound', 'Vitor': 'Outbound', 'Juliana': 'Outbound', 'Iquiara': 'Outbound',
  'Karina': 'Inbound', 'Vinícius': 'Inbound',
};

const PRE_VENDAS_SLACK_ID = {
  'Carlos': 'U0ACERPFPAM', 'Vitor': 'U09RYFBB1BL', 'Juliana': 'U0B2C02PS4S',
  'Iquiara': 'U0B3688EV40', 'Karina': 'U09MUR9SRSM', 'Vinícius': 'U09AD7LPYC9',
};

const PRE_VENDAS_FOLDER_ID = {
  'Carlos': '1yD8DPb2uQGqcft7u_9e7IYOPOL5fFtkv',
  'Vitor': '1MKGQ0ubIH6OWNfUgf5IOogU2Ez_mxz_4',
  'Juliana': '1UPw-CFW3YWasXvuyvCyFF-VYU6xlkexv',
  'Iquiara': '1Jc2vOxtOub5HvCQ7B7-_JNtq75lvTE2g',
  'Karina': '1QnNnaxjlAmHAevdA0j_Rr-793QF4wimm',
  'Vinícius': '1riShFbpMIEHZnQ2tcq7onIEzYE7CKHNn',
};

const RUBRIC_OUTBOUND = ['Abertura', 'Qualificação', 'Objeção', 'Próximo Passo'];
const RUBRIC_INBOUND = ['Abertura e Contexto', 'Qualificação de Frota', 'Qualificação da Dor', 'Decisor', 'Fechamento com Escassez'];

const EVENTOS_ABA = 'Eventos';
const MARCADORES_ABA = 'Marcadores'; // substitui os arquivos .marker no Drive do outro pipeline

// ─── Clientes Google ─────────────────────────────────────────────────
function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ─── Dedup via aba própria na planilha (evita depender de Drive/marker
// files do outro pipeline). Uma linha por chave processada com sucesso.
async function jaProcessado(chave) {
  const sheets = getSheetsClient();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${MARCADORES_ABA}!A:A`,
    });
    const linhas = (res.data.values || []).flat();
    return linhas.includes(chave);
  } catch (e) {
    console.error('[PV] Erro ao checar marcador (seguindo como não processado):', e.message);
    return false;
  }
}

async function marcarProcessado(chave) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${MARCADORES_ABA}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[chave, new Date().toISOString()]] },
  });
}

// ─── Eventos crus: 1 linha por Ligação ou WhatsApp ──────────────────
// Colunas: dataISO | userId | nome | canal | tituloOuChat | duracaoSeg | telefoneOuChat | texto | contextoJSON
async function salvarEvento(linha) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${EVENTOS_ABA}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [linha] },
  });
}

async function lerEventosDaSemana(inicioISO, fimISO) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${EVENTOS_ABA}!A2:I`,
  });
  const linhas = res.data.values || [];
  return linhas.filter(l => l[0] >= inicioISO && l[0] <= fimISO);
}

// ─── HTML → texto plano (a Salesbud manda transcription em HTML) ────
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Verificação de assinatura — best effort, mesmo padrão do pipeline
// existente: se não houver secret configurado, aceita sem verificar.
function verificarAssinatura(req, rawBody) {
  const secret = process.env.SALESBUD_WEBHOOK_SECRET;
  if (!secret) return { ok: true, motivo: 'sem secret configurado' };
  const candidatos = ['x-salesbud-signature', 'x-signature', 'x-webhook-signature'];
  let header = null, valor = null;
  for (const h of candidatos) { if (req.headers[h]) { header = h; valor = req.headers[h]; break; } }
  if (!header) {
    console.log('[PV] Nenhum header de assinatura reconhecido. Headers:', JSON.stringify(req.headers));
    return { ok: true, motivo: 'header não encontrado — aceito temporariamente' };
  }
  const hash = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const valido = hash === String(valor).replace(/^sha256=/, '');
  return { ok: valido, motivo: valido ? 'ok' : 'assinatura inválida' };
}

function postSlack(msg, webhookUrl) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text: msg });
    const url = new URL(webhookUrl || process.env.PV_SLACK_WEBHOOK_URL);
    const req = https.request({
      hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`Slack respondeu ${res.statusCode}: ${data.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Slack timeout')); });
    req.write(body); req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════
// WEBHOOK — captura Ligação (VoIP) e WhatsApp dos pré-vendas
// ═══════════════════════════════════════════════════════════════════════
app.post('/webhook/salesbud-prevendas', (req, res) => {
  res.json({ ok: true, status: 'processing' });

  (async () => {
    try {
      const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      const verificacao = verificarAssinatura(req, rawBody);
      if (!verificacao.ok) { console.log('[PV] Webhook rejeitado -', verificacao.motivo); return; }

      const payload = JSON.parse(rawBody);
      const userId = String(payload.userId || '');

      console.log(`[PV] RECEBIDO — userId:${userId} id:${payload.id || payload.chatId} tipo:${payload.recordProvider || (payload.chatJid ? 'whatsapp' : 'reuniao')}`);

      const nome = PRE_VENDAS_USER_MAP[userId];
      if (!nome) { console.log('[PV] userId não é pré-vendas mapeado, ignorando:', userId); return; }

      let canal, chave, dataISO, tituloOuChat, duracaoSeg, telefoneOuChat, texto, contextoJSON;

      if (payload.chatJid !== undefined) {
        // Payload WhatsApp (doc Salesbud: chatJid, messagesText, messageDate)
        canal = 'whatsapp';
        chave = `pv_wpp_${payload.chatId}_${payload.messageDate}`;
        dataISO = payload.messageDate || '';
        tituloOuChat = payload.chatName || '';
        duracaoSeg = 0;
        telefoneOuChat = (payload.phoneNumbers || []).join(', ');
        texto = payload.messagesText || '';
        contextoJSON = JSON.stringify({ clientMessagesText: payload.clientMessagesText || '', isGroup: !!payload.isGroup });
      } else if (payload.recordProvider === 'VOIP' || payload.phoneNumber !== undefined) {
        // Payload VoIP (doc Salesbud: phoneNumber, recordProvider, meetingAt)
        canal = 'ligacao';
        chave = `pv_call_${payload.id}`;
        dataISO = (payload.meetingAt || '').slice(0, 10);
        tituloOuChat = payload.title || '';
        duracaoSeg = payload.duration || 0;
        telefoneOuChat = payload.phoneNumber || '';
        texto = stripHtml(payload.transcription || '');
        contextoJSON = JSON.stringify(payload.context || {});
      } else {
        console.log('[PV] Payload não é Ligação nem WhatsApp (provavelmente Reunião), ignorando.');
        return;
      }

      if (!texto || texto.length < 20) { console.log('[PV] Texto vazio/curto demais, ignorando:', chave); return; }
      if (!dataISO) { console.log('[PV] Sem data, ignorando:', chave); return; }

      if (await jaProcessado(chave)) { console.log('[PV] Já capturado, pulando:', chave); return; }

      await salvarEvento([dataISO, userId, nome, canal, tituloOuChat, duracaoSeg, telefoneOuChat, texto, contextoJSON]);
      await marcarProcessado(chave);
      console.log(`[PV] CAPTURADO — nome:${nome} canal:${canal} data:${dataISO} tamanho_texto:${texto.length}`);

    } catch (err) {
      console.error('[PV] Erro na captura:', err.message);
    }
  })();
});

// ═══════════════════════════════════════════════════════════════════════
// CLAUDE — pontuação por rubric (NUNCA usa analytics.score da Salesbud)
// ═══════════════════════════════════════════════════════════════════════
function pvMontarSystemPrompt(perfil, canal) {
  const dims = perfil === 'Outbound' ? RUBRIC_OUTBOUND : RUBRIC_INBOUND;
  const nomeCanal = canal === 'ligacao' ? 'ligações telefônicas' : 'conversas de WhatsApp';
  return `Você aplica o rubric de coaching de pré-vendas da Frota162 (skill pre-vendas-coach) sobre transcrições de ${nomeCanal}.
Perfil do pré-vendas: ${perfil}. Dimensões a pontuar, escala 1 a 10 (nunca 1 a 5): ${dims.join(', ')}.
IMPORTANTE: você recebe apenas o texto da conversa. NUNCA existe nota pré-calculada de nenhum fornecedor — toda pontuação é sua, com base no conteúdo real.
Para cada interação fornecida (separadas por "---"), avalie se foi "efetiva" (chegou em responsável certo com dado real de frota/dor capturado) ou não.
Identifique a melhor interação do canal nesta semana: contato, resumo do que foi qualificado, se fechou com dia/hora específicos.
Identifique até 3 prioridades de coaching (pontos fortes a reforçar ou fracos a corrigir), sempre citando o contato/exemplo real.
Identifique achados operacionais: mesmo contato discado várias vezes sem sucesso, transcrição cortada antes do fim, reclamação do contato sobre origem/abordagem, etc. Só inclua se houver evidência real no texto.
Retorne SOMENTE JSON válido, sem markdown, sem texto fora do JSON, neste formato exato:
{"total":0,"efetivas":0,"dimensoes":{${dims.map(d => `"${d}":0`).join(',')}},"melhor_interacao":{"contato":"","resumo":"","fechou":false},"prioridades":["",""],"achados_operacionais":[]}`;
}

function pvChamarClaude(systemPrompt, conteudo) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 3000,
      system: systemPrompt,
      messages: [{ role: 'user', content: conteudo }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.type === 'error' || !p.content || !p.content[0]) {
            return reject(new Error('Claude API error: ' + (p.error?.message || JSON.stringify(p).slice(0, 200))));
          }
          const t = p.content[0].text.replace(/```json/gi, '').replace(/```/g, '').trim();
          resolve(JSON.parse(t));
        } catch (e) { reject(new Error('Claude parse: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(180000, () => { req.destroy(); reject(new Error('Claude timeout')); });
    req.write(body); req.end();
  });
}

async function pvAnalisarCanal(perfil, canal, eventos) {
  const vazio = () => ({ total: 0, efetivas: 0, dimensoes: {}, melhor_interacao: null, prioridades: [], achados_operacionais: [] });
  if (!eventos.length) return vazio();

  const conteudo = eventos.map(e => `--- ${e[4] || '(sem título)'} (${e[0]}, ${e[5]}s) ---\n${e[7]}`).join('\n\n');
  const systemPrompt = pvMontarSystemPrompt(perfil, canal);

  let lastErr;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const r = await pvChamarClaude(systemPrompt, conteudo);
      r.total = r.total || eventos.length; // garante consistência mesmo se o Claude não contar certo
      return r;
    } catch (e) {
      lastErr = e;
      console.log(`[PV] pvAnalisarCanal tentativa ${tentativa} falhou (${perfil}/${canal}):`, e.message);
      if (tentativa < 3) await new Promise(r => setTimeout(r, 5000 * tentativa));
    }
  }
  console.error('[PV] Falhou após 3 tentativas, retornando vazio:', lastErr?.message);
  return vazio();
}

// ─── Consolidado ponderado pelo volume de cada canal ─────────────────
function pvConsolidar(dims) {
  const listas = dims.filter(d => d && d.n > 0);
  if (!listas.length) return {};
  const todasChaves = new Set();
  listas.forEach(l => Object.keys(l.valores).forEach(k => todasChaves.add(k)));
  const out = {};
  for (const chave of todasChaves) {
    let somaPeso = 0, somaPonderada = 0;
    for (const l of listas) {
      if (l.valores[chave] != null) { somaPonderada += l.valores[chave] * l.n; somaPeso += l.n; }
    }
    out[chave] = somaPeso > 0 ? (somaPonderada / somaPeso).toFixed(1) : '—';
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// HTML — separado por canal (Ligação / WhatsApp) + consolidado final
// CSS idêntico ao usado nos relatórios manuais do Ciclo 6, pra manter
// identidade visual entre o que é feito manualmente e o automático.
// ═══════════════════════════════════════════════════════════════════════
const CSS_BASE = `
@import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap');
:root{--laranja:#E8401C;--dark:#1A1A1A;--bg:#F7F5F3;--cinza:#6b6b6b;--verde:#2e7d32;--linha:#e3ded9;}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Montserrat',sans-serif;background:var(--bg);color:var(--dark);line-height:1.5;padding:32px 18px;}
.wrap{max-width:960px;margin:0 auto;}
header{border-left:6px solid var(--laranja);padding:6px 0 6px 18px;margin-bottom:8px;}
header h1{font-size:26px;font-weight:800;}
header .sub{color:var(--cinza);font-weight:500;font-size:13px;margin-top:2px;}
.fonte{font-size:11px;color:var(--cinza);margin:10px 0 24px 18px;}
.canal-header{background:var(--dark);color:#fff;padding:10px 18px;border-radius:8px 8px 0 0;font-size:14px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;margin-top:34px;}
.canal-header.wpp{background:#2e7d32;}
h2{font-size:16px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;margin:20px 0 12px;padding-bottom:6px;border-bottom:2px solid var(--linha);}
.kpis{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;}
.kpi{background:#fff;border:1px solid var(--linha);border-radius:10px;padding:14px 16px;}
.kpi .n{font-size:24px;font-weight:800;color:var(--laranja);}
.kpi .l{font-size:11px;color:var(--cinza);font-weight:600;text-transform:uppercase;}
.medias{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;}
.med{background:#fff;border:1px solid var(--linha);border-radius:8px;padding:8px 12px;font-size:13px;font-weight:600;}
.med span{color:var(--laranja);font-weight:800;}
.med.consolidado span{color:var(--verde);}
.prio{background:#fff;border:1px solid var(--linha);border-left:5px solid var(--laranja);border-radius:8px;padding:14px 18px;margin-bottom:10px;}
.prio p{font-size:14px;margin-bottom:8px;}
.prio b{color:var(--laranja);}
.aviso{background:#fff4e5;border:1px solid #f0d9a8;border-radius:8px;padding:12px 16px;font-size:12.5px;color:#7a5a12;margin-bottom:14px;}
.aviso b{color:#b8860b;}
.melhor{background:#eaf6ea;border:1px solid #bfe3bf;border-radius:8px;padding:12px 16px;font-size:13px;margin-bottom:14px;}
.tag{display:inline-block;font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px;text-transform:uppercase;background:#e6f4ea;color:var(--verde);}
footer{margin-top:34px;padding-top:14px;border-top:2px solid var(--linha);font-size:11px;color:var(--cinza);}
footer b{color:var(--laranja);}
.gerado-auto{font-size:10px;color:var(--cinza);font-style:italic;margin-top:4px;}
`;

function pvRenderCanalSecao(titulo, classe, dims, r) {
  const medPontos = Object.entries(r.dimensoes || {}).map(([k, v]) =>
    `<div class="med">${k} <span>${v}</span></div>`).join('');
  const prioridades = (r.prioridades || []).map(p => `<p>${p}</p>`).join('');
  const achados = (r.achados_operacionais || []).length
    ? `<div class="aviso"><b>Achados operacionais</b>${r.achados_operacionais.map(a => `<p>${a}</p>`).join('')}</div>` : '';
  const melhor = r.melhor_interacao
    ? `<div class="melhor"><b>${r.melhor_interacao.contato || 'Contato não identificado'}</b> — ${r.melhor_interacao.resumo || ''} ${r.melhor_interacao.fechou ? '<span class="tag">Fechou</span>' : ''}</div>`
    : '<p style="font-size:12px;color:var(--cinza);">Sem interação de destaque nesta semana.</p>';

  return `
<div class="canal-header ${classe}">${titulo}</div>
<div class="kpis">
  <div class="kpi"><div class="n">${r.total || 0}</div><div class="l">Interações</div></div>
  <div class="kpi"><div class="n">${r.efetivas || 0}</div><div class="l">Efetivas</div></div>
</div>
<div class="medias">${medPontos || '<span style="font-size:12px;color:var(--cinza);">Sem dado suficiente</span>'}</div>
<h2>Melhor interação</h2>
${melhor}
${prioridades ? `<h2>Prioridades</h2><div class="prio">${prioridades}</div>` : ''}
${achados}
`;
}

function pvGerarHTML(nome, perfil, semanaIni, semanaFim, resLig, resWpp) {
  const consolidado = pvConsolidar([
    { n: resLig.total || 0, valores: resLig.dimensoes || {} },
    { n: resWpp.total || 0, valores: resWpp.dimensoes || {} },
  ]);
  const medConsolidado = Object.entries(consolidado).map(([k, v]) =>
    `<div class="med consolidado">${k} <span>${v}</span></div>`).join('');

  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Autogestão — ${nome} — ${semanaFim}</title>
<style>${CSS_BASE}</style></head>
<body><div class="wrap">
<header><h1>Autogestão Pré-Vendas · ${nome}</h1><div class="sub">Perfil ${perfil} · Semana ${semanaIni}–${semanaFim}</div></header>
<div class="fonte">Base: eventos capturados via webhook Salesbud (Ligação + WhatsApp). Pontuação sempre calculada pelo rubric Frota162 via Claude — nunca a nota nativa da Salesbud.</div>
${pvRenderCanalSecao('Ligações', '', RUBRIC_OUTBOUND, resLig)}
${pvRenderCanalSecao('WhatsApp', 'wpp', RUBRIC_OUTBOUND, resWpp)}
<h2>Consolidado da semana</h2>
<div class="medias">${medConsolidado || '<span style="font-size:12px;color:var(--cinza);">Sem dado suficiente em nenhum canal</span>'}</div>
<footer>Autogestão Pré-Vendas — <b>Frota162</b> · ${semanaIni}–${semanaFim}<div class="gerado-auto">Gerado automaticamente — verificar antes de tratar como definitivo nas primeiras semanas.</div></footer>
</div></body></html>`;
}

// ═══════════════════════════════════════════════════════════════════════
// CRON — segunda de manhã, agrega a semana anterior por pessoa e canal
// ═══════════════════════════════════════════════════════════════════════
app.post('/cron/pre-vendas-semanal', (req, res) => {
  res.json({ ok: true, status: 'processing' });

  (async () => {
    try {
      const hoje = new Date();
      const diasDesdeSegunda = (hoje.getDay() + 6) % 7;
      const segundaAtual = new Date(hoje); segundaAtual.setDate(hoje.getDate() - diasDesdeSegunda);
      const segundaPassada = new Date(segundaAtual); segundaPassada.setDate(segundaAtual.getDate() - 7);
      const sextaPassada = new Date(segundaPassada); sextaPassada.setDate(segundaPassada.getDate() + 4);
      const inicioISO = segundaPassada.toISOString().slice(0, 10);
      const fimISO = sextaPassada.toISOString().slice(0, 10);

      console.log(`[PV] Cron semanal iniciado — janela ${inicioISO} a ${fimISO}`);

      const eventos = await lerEventosDaSemana(inicioISO, fimISO);
      const drive = getDriveClient();
      const mencoes = [];

      for (const nome of Object.keys(PRE_VENDAS_PERFIL)) {
        const perfil = PRE_VENDAS_PERFIL[nome];
        const doNome = eventos.filter(e => e[2] === nome);
        const ligacoes = doNome.filter(e => e[3] === 'ligacao');
        const whatsapps = doNome.filter(e => e[3] === 'whatsapp');

        console.log(`[PV] ${nome}: ${ligacoes.length} ligações, ${whatsapps.length} whatsapps na semana`);

        const [resLig, resWpp] = await Promise.all([
          pvAnalisarCanal(perfil, 'ligacao', ligacoes),
          pvAnalisarCanal(perfil, 'whatsapp', whatsapps),
        ]);

        const html = pvGerarHTML(nome, perfil, inicioISO, fimISO, resLig, resWpp);
        const nomeArq = `${fimISO} | ${nome} (auto).html`;

        const uploaded = await drive.files.create({
          supportsAllDrives: true,
          requestBody: { name: nomeArq, parents: [PRE_VENDAS_FOLDER_ID[nome]], mimeType: 'text/html' },
          media: { mimeType: 'text/html', body: html },
          fields: 'id,webViewLink',
        });
        await drive.permissions.create({ fileId: uploaded.data.id, supportsAllDrives: true, requestBody: { role: 'writer', type: 'anyone' } });

        mencoes.push(`• <@${PRE_VENDAS_SLACK_ID[nome]}> ${nome}: <https://drive.google.com/drive/folders/${PRE_VENDAS_FOLDER_ID[nome]}|pasta>`);
      }

      await postSlack(`📊 *Autogestão Pré-Vendas — ciclo automático (${inicioISO}–${fimISO})*\n\n${mencoes.join('\n')}\n\n_Gerado automaticamente. Verifique com atenção nas primeiras semanas._`);
      console.log('[PV] Cron semanal concluído com sucesso.');

    } catch (err) {
      console.error('[PV] Erro no cron semanal:', err.message);
      await postSlack(`:warning: Falha no ciclo automático de pré-vendas: ${err.message}`).catch(() => {});
    }
  })();
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'Frota162 Pré-Vendas Auto v1' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Frota162 Pré-Vendas Auto rodando na porta ${PORT}`));
