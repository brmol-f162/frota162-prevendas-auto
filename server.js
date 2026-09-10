// frota162-prevendas-v2/server.js
//
// Substitui a automação antiga (webhook Salesbud -> planilha -> HTML por pessoa).
// Modelo novo: pull semanal via API REST da Salesbud (OAuth2 client_credentials),
// scoring com o rubric já validado (outbound.md / inbound.md do skill pre-vendas-coach),
// entrega 1 resumo executivo por Slack DM pro Bruno, toda quarta de manhã.
//
// Time analisado (Carlos NÃO entra — saiu da empresa):
//   Outbound: Vitor, Juliana, Iquiara
//   Inbound:  Karina, Vinícius
//
// Janela: sempre os 7 dias fechados anteriores ao dia em que o cron roda
// (se roda quarta, pega quarta 00:00 -> terça 23:59 da semana anterior).

const express = require("express");
const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const SALESBUD_CLIENT_ID = process.env.SALESBUD_CLIENT_ID;
const SALESBUD_CLIENT_SECRET = process.env.SALESBUD_CLIENT_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SLACK_WEBHOOK_URL = process.env.PV_SLACK_DM_WEBHOOK_URL; // webhook novo, apontado pra DM do Bruno (não o canal antigo)
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const TIMEZONE = "America/Sao_Paulo";

const REPS = [
  { name: "Vitor Campos", email: "vitor.campos@frota162.com.br", team: "Outbound" },
  { name: "Juliana Romaris", email: "juliana.romaris@frota162.com.br", team: "Outbound" },
  { name: "Iquiara Machado", email: "iquiara@frota162.com.br", team: "Outbound" },
  { name: "Karina Pimenta", email: "karina@frota162.com.br", team: "Inbound" },
  { name: "Vinícius Martins", email: "vinicius.cardoso@frota162.com.br", team: "Inbound" },
];

// Rubric embutido literalmente — fonte: /mnt/skills/user/pre-vendas-coach/references/*.md
// Não reduzir/parafrasear: o texto exato é o que o Claude usa pra pontuar.

const OUTBOUND_RUBRIC = `
PERFIL: Outbound — Pré-Vendas
SDR liga proativamente para leads frios/base fria. Objetivo da call: qualificar e
agendar reunião com o AE (Especialista).

DIMENSÕES DE NOTA (ligações efetivas) — escala 1 a 10 (conversão proporcional
da escala antiga 1-5 × 2): 10 = melhor (antiga 5/A), 8 = antiga 4/B, 6 = antiga
3/C, 4 = antiga 2/D (pior), 2 = reservado pra casos muito fracos (antiga 1).
Use números ímpares quando a call ficar entre duas categorias — a escala de 10
pontos existe justamente pra dar essa resolução mais fina, não pra ficar presa
só nos múltiplos de 2:

1. Abertura — Chegou no decisor certo e ganhou atenção real nos primeiros
   segundos, sem soar script.
2. Qualificação — Levantou processo atual, quantidade/valor de multa e placas
   antes de propor qualquer coisa.
3. Objeção — Respondeu preço/concorrente/"sem interesse" sem desistir na
   primeira barreira, aplicando o protocolo de concorrente quando cabível.
4. Próximo Passo — Saiu da call com algo concreto: reunião marcada,
   desqualificação justificada, ou dia/hora certos de retomada.

REGRA DE DESQUALIFICAÇÃO A REAVALIAR:
- Corte de placas: raro no Outbound (listas já vêm com volume maior) — só marcar
  se aparecer explicitamente.
- Corte de multa: <5 multas/mês ou <R$1.000/mês.
- Classificar desqualificação como: "correta", "estrutural" (ex: Locadora) ou
  "oportunidade não confirmada" (desqualificou sem confirmar o número).

Para cada call, classifique em uma categoria:
- "Agendamento confirmado" (marcou reunião)
- "Qualificado sem próximo passo" (qualificou bem mas não fechou data/hora de
  retomada — isso é sempre prioridade na análise, nunca detalhe secundário)
- "Desqualificação" (aplicar a regra acima)
- "Outro" (call curta, engano, não se aplica rubric)
`.trim();

const INBOUND_RUBRIC = `
PERFIL: Inbound — Pré-Vendas
Lead chegou por conta própria (site, redes sociais, WhatsApp) e demonstrou
interesse. SDR não está "abrindo porta fria" — está confirmando fit e agendando.

QUALIFICAÇÃO QUE PRECISA APARECER NA CALL (playbook oficial):
segmento da empresa, tipo de frota (própria/mista/terceirizada), volume médio
mensal de multas, frota PJ ou PF, quantidade de placas, perfil de quem fala
(Decisor / Influenciador forte / fraco), motivo do contato, se já usa solução
(concorrente), estados de atuação, aderência ao SNE.

SCRIPT OFICIAL (8 passos) — usar pra mapear onde a call quebrou:
1. Abertura (quebra-gelo e contexto)
2. Contexto geral (segmento e tipo de frota)
3. Tamanho e perfil da frota (placas, PJ/PF)
4. Dor (controle de multas hoje, volume médio mensal)
5. Concorrência (contexto, não vira dimensão de nota)
6. Decisor (quem decide, quem influencia)
7. Localização (estados de atuação, aderência ao SNE)
8. Fechamento com escassez (agenda reforçando agenda concorrida do especialista)

DIMENSÕES DE NOTA — escala 1 a 10 (conversão proporcional da escala antiga
1-5 × 2): 10 = melhor (antiga 5/A), 8 = antiga 4/B, 6 = antiga 3/C, 4 = antiga
2/D (pior), 2 = reservado pra casos muito fracos (antiga 1). Use números
ímpares quando a call ficar entre duas categorias. Deixar null quando a
dimensão não se aplicou à call. NÃO existe dimensão de Concorrência (comentar
em texto livre se aparecer, não pontuar):

1. Abertura & Contexto (passos 1-2) — quebra-gelo + segmento/tipo de frota sem
   parecer interrogatório.
2. Qualificação de Frota (passos 3 e 7) — placas, PJ/PF, estados, SNE.
3. Qualificação da Dor (passo 4) — volume/valor de multa e motivo real do
   contato.
4. Decisor (passo 6) — identificou Decisor vs. Influenciador forte/fraco.
5. Fechamento com Escassez (passo 8) — usou a escassez do especialista ao
   marcar.

REGRAS DE DESQUALIFICAÇÃO A REAVALIAR:
- Corte de placas: ≤10 placas = desqualificado direto (comum no Inbound).
- PF x PJ: frota 100% PF é sem fit por padrão (solução é pra CNPJ) — avaliar
  mesmo assim se for frota mista ou 100% PF mas grande.

Para cada call, classifique em uma categoria:
- "Agendamento confirmado"
- "Qualificado sem próximo passo" (sempre prioridade, nunca detalhe secundário)
- "Desqualificação" (aplicar as regras acima)
- "Outro"
`.trim();

// ---------------------------------------------------------------------------
// SALESBUD: TOKEN + FETCH
// ---------------------------------------------------------------------------

let cachedToken = null;
let tokenExpiresAt = 0;

async function getSalesbudToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const resp = await fetch("https://api.salesbud.com.br/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: SALESBUD_CLIENT_ID,
      client_secret: SALESBUD_CLIENT_SECRET,
    }),
  });
  if (!resp.ok) {
    throw new Error(`[PV] Falha ao obter token Salesbud: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  console.log(`[PV] Token Salesbud renovado. Escopo: ${data.scope}`);
  return cachedToken;
}

// Rate limit da Salesbud: 120 req/min (confirmado via /v1/context). Um pré-vendas
// com 25+ calls na semana já estoura isso se buscarmos transcrição sem pausa —
// foi exatamente o que aconteceu no primeiro teste real. Dois mecanismos:
// (1) espaçamento mínimo entre requisições (gate global), (2) retry com backoff
// em cima de 429, respeitando Retry-After quando vier.
const MIN_INTERVAL_MS = 600; // ~100 req/min, com folga sob o limite de 120
let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle() {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

async function salesbudGet(path, params, attempt = 0) {
  await throttle();
  const token = await getSalesbudToken();
  const url = new URL(`https://api.salesbud.com.br${path}`);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  });

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

  if (resp.status === 401 && attempt === 0) {
    // token pode ter sido revogado antes do expires_in — força renovação e tenta 1x
    cachedToken = null;
    return salesbudGet(path, params, attempt + 1);
  }

  if (resp.status === 429) {
    if (attempt >= 5) {
      throw new Error(`[PV] Rate limit persistente em ${path} após ${attempt} tentativas — desistindo.`);
    }
    const retryAfterHeader = resp.headers.get("retry-after");
    const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 2000 * Math.pow(2, attempt);
    console.warn(`[PV] 429 em ${path} — aguardando ${waitMs}ms antes de tentar de novo (tentativa ${attempt + 1}/5).`);
    await sleep(waitMs);
    return salesbudGet(path, params, attempt + 1);
  }

  if (!resp.ok) {
    throw new Error(`[PV] Erro Salesbud ${path}: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

// Busca todas as calls de um owner_email dentro da janela, paginando até has_more=false.
// Ordenação padrão da API é ascendente por meeting_at — confirmado empiricamente.
async function listCallsInWindow(ownerEmail, meetingAfterISO, meetingBeforeISO) {
  const all = [];
  let cursor = null;
  do {
    const page = await salesbudGet("/v1/calls", {
      owner_email: ownerEmail,
      meeting_after: meetingAfterISO,
      meeting_before: meetingBeforeISO,
      limit: 50,
      cursor: cursor || undefined,
    });
    all.push(...page.data);
    cursor = page.pagination.has_more ? page.pagination.next_cursor : null;
  } while (cursor);
  return all;
}

async function getTranscript(callId) {
  const t = await salesbudGet(`/v1/calls/${callId}/transcript`, {});
  return t.data;
}

// ---------------------------------------------------------------------------
// JANELA DE DATAS: quarta 00:00 -> quarta 00:00 (America/Sao_Paulo), 7 dias fechados
// ---------------------------------------------------------------------------

function computeWeekWindow(now = new Date()) {
  // America/Sao_Paulo não observa horário de verão desde 2019 -> UTC-3 fixo.
  const OFFSET_HOURS = 3;
  const nowSP = new Date(now.getTime() - OFFSET_HOURS * 3600 * 1000);
  const midnightSP = new Date(Date.UTC(nowSP.getUTCFullYear(), nowSP.getUTCMonth(), nowSP.getUTCDate()));
  // meeting_before = hoje 00:00 em SP, convertido de volta pra UTC
  const windowEndUTC = new Date(midnightSP.getTime() + OFFSET_HOURS * 3600 * 1000);
  const windowStartUTC = new Date(windowEndUTC.getTime() - 7 * 24 * 3600 * 1000);
  return {
    meeting_after: windowStartUTC.toISOString(),
    meeting_before: windowEndUTC.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CLAUDE: SCORING POR PESSOA + SÍNTESE DA EQUIPE
// ---------------------------------------------------------------------------

async function callClaude(system, userText, maxTokens = 4000) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!resp.ok) {
    throw new Error(`[PV] Erro Claude API: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

function formatUtterances(transcript) {
  if (!transcript || !transcript.utterances) return "(transcrição indisponível)";
  return transcript.utterances.map((u) => `${u.speaker}: ${u.text}`).join("\n");
}

async function scoreRepWeek(rep, calls, transcriptsById) {
  const rubric = rep.team === "Outbound" ? OUTBOUND_RUBRIC : INBOUND_RUBRIC;

  const callsBlock = calls
    .map((c, i) => {
      const tr = transcriptsById[c.id];
      return `
### Call ${i + 1} (id: ${c.id})
Título: ${c.title}
Data/hora: ${c.meeting_at}
Duração: ${c.duration_seconds}s
Status: ${c.status} | No-show: ${c.no_show}

Transcrição (${rep.name} é um dos dois falantes — identifique pelo conteúdo,
não pela letra A/B, que não é fixa):
${formatUtterances(tr)}
`.trim();
    })
    .join("\n\n---\n\n");

  const system = `Você é o Bruno Mol, Head of Sales da Frota162, avaliando calls de pré-vendas do time ${rep.team} pelo rubric oficial da empresa. Use SOMENTE o rubric abaixo — nunca invente dimensão nova, nunca use rubric de AE (Abertura/Dor/ROI/Negociação/Fechamento de venda são de call de fechamento, não se aplicam aqui).

${rubric}

Para CADA call, produza:
1. Categoria e nota por dimensão (ou null se não se aplicou).
2. "Observação" — o que aconteceu, factual.
3. "Sugestão de Ação" — estratégica, específica da Frota162, aplicável pelo
   próprio pré-vendas sem precisar do Bruno.
4. "Frases que Podem Ser Aprimoradas" — para CADA ponto fraco relevante da
   call (não invente se a call foi limpa), traga:
   - **Trecho literal**: cite a fala exata do pré-vendas, entre aspas, copiada
     da transcrição (nunca parafraseie a fala real — se não tiver certeza da
     frase exata, não cite).
   - **O que houve de errado**: o que essa fala perdeu ou fez mal (conecte
     com a dimensão do rubric).
   - **Frase ideal**: reescreva exatamente o que o pré-vendas deveria ter
     dito naquele momento daquela call específica (não um exemplo genérico).
   Sem limite de quantidade — se a call teve 4 momentos ruins, traga os 4;
   se teve 1, traga só 1.

Seja direto e crítico — este material vai ser usado numa call de treino, não é elogio.`;

  const userText = `Pré-vendas: ${rep.name} (${rep.team})
Calls da semana (${calls.length} no total):

${callsBlock}

Responda em markdown. Para cada call: cabeçalho com categoria e notas por
dimensão, "Observação", "Sugestão de Ação", e a seção "Frases que Podem Ser
Aprimoradas" (trecho literal / o que houve de errado / frase ideal) sempre que
houver ponto fraco. Antes de tudo, liste as 2-3 observações mais importantes
da semana pra esse pré-vendas (priorize sempre "Qualificado sem próximo passo"
quando existir).`;

  return callClaude(system, userText, 6000);
}

// Gera só o CABEÇALHO do time (não substitui o diagnóstico individual, que
// vai inteiro na mensagem depois, com as citações literais).
async function synthesizeTeam(teamName, repSummaries) {
  const system = `Você escreve o cabeçalho executivo semanal de pré-vendas da Frota162 pro Bruno Mol (Head of Sales) abrir a call de treino de quinta-feira com o time ${teamName}. Seja direto, sem preâmbulo, sem elogio genérico. Priorize sempre: (1) calls qualificadas sem próximo passo, (2) padrão que se repete entre mais de uma pessoa, (3) 1-2 ações concretas pra pauta de treino. Formato Slack (mrkdwn): *negrito* com asterisco simples, não markdown de cabeçalho (#). Isto é só o topo da mensagem — o diagnóstico individual completo de cada pessoa (com trechos literais) vem logo abaixo, então não repita detalhe de call específica aqui.`;

  const userText = `Análises individuais da semana, time ${teamName}:\n\n${repSummaries
    .map((r) => `## ${r.name}\n${r.summary}`)
    .join("\n\n")}\n\nEscreva só o cabeçalho executivo do time ${teamName} — máximo ~120 palavras.`;

  return callClaude(system, userText, 800);
}

// ---------------------------------------------------------------------------
// SLACK
// ---------------------------------------------------------------------------

async function sendSlackDM(text) {
  if (!SLACK_WEBHOOK_URL) {
    console.warn("[PV] PV_SLACK_DM_WEBHOOK_URL não configurado — pulando envio.");
    return;
  }
  const resp = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!resp.ok) {
    throw new Error(`[PV] Erro ao postar no Slack: ${resp.status} ${await resp.text()}`);
  }
}

// ---------------------------------------------------------------------------
// PIPELINE PRINCIPAL
// ---------------------------------------------------------------------------

async function rodarCicloSemanal() {
  const { meeting_after, meeting_before } = computeWeekWindow();
  console.log(`[PV] Janela: ${meeting_after} -> ${meeting_before}`);

  const outboundSummaries = [];
  const inboundSummaries = [];
  let totalCalls = 0;

  for (const rep of REPS) {
    console.log(`[PV] Buscando calls de ${rep.name}...`);
    const calls = await listCallsInWindow(rep.email, meeting_after, meeting_before);
    const completed = calls.filter((c) => c.status === "completed" && !c.no_show);
    totalCalls += completed.length;

    if (completed.length === 0) {
      const bucket = rep.team === "Outbound" ? outboundSummaries : inboundSummaries;
      bucket.push({ name: rep.name, summary: "Nenhuma call completa registrada nesta semana." });
      continue;
    }

    console.log(`[PV] ${rep.name}: ${completed.length} calls completas. Buscando transcrições...`);
    const transcriptsById = {};
    for (const c of completed) {
      if (c.transcript && c.transcript.available) {
        try {
          transcriptsById[c.id] = await getTranscript(c.id);
        } catch (e) {
          console.error(`[PV] Falha ao buscar transcrição de ${c.id}:`, e.message);
        }
      }
    }

    console.log(`[PV] ${rep.name}: pontuando com Claude...`);
    const summary = await scoreRepWeek(rep, completed, transcriptsById);
    const bucket = rep.team === "Outbound" ? outboundSummaries : inboundSummaries;
    bucket.push({ name: rep.name, summary });
  }

  console.log("[PV] Gerando cabeçalho executivo por time...");
  const outboundHeadline = await synthesizeTeam("Outbound", outboundSummaries);
  const inboundHeadline = await synthesizeTeam("Inbound", inboundSummaries);

  const dataInicio = new Date(meeting_after).toLocaleDateString("pt-BR", { timeZone: TIMEZONE });
  const dataFim = new Date(new Date(meeting_before).getTime() - 1).toLocaleDateString("pt-BR", { timeZone: TIMEZONE });

  // Diagnóstico completo (com trechos literais/antes-depois) vai inteiro na
  // mensagem — não só a síntese. É isso que sustenta a pauta de treino.
  function montarBlocoTime(nomeTime, headline, summaries) {
    const detalhePorPessoa = summaries
      .map((r) => `*${r.name}*\n${r.summary}`)
      .join("\n\n" + "-".repeat(20) + "\n\n");
    return `*${nomeTime.toUpperCase()}*\n${headline}\n\n${detalhePorPessoa}`;
  }

  const mensagem = `*Resumo semanal Pré-Vendas — ${dataInicio} a ${dataFim}* (${totalCalls} calls analisadas)

${montarBlocoTime("Outbound", outboundHeadline, outboundSummaries)}

${"=".repeat(30)}

${montarBlocoTime("Inbound", inboundHeadline, inboundSummaries)}`;

  await sendSlackDM(mensagem);
  console.log("[PV] Ciclo semanal concluído com sucesso.");
}

// ---------------------------------------------------------------------------
// ROTAS
// ---------------------------------------------------------------------------

app.get("/", (req, res) => res.json({ status: "ok", service: "frota162-prevendas-v2" }));

app.post("/cron/pre-vendas-semanal", async (req, res) => {
  // responde rápido pro cron-job.org não dar timeout, roda o pipeline em background
  res.json({ status: "iniciado" });
  try {
    await rodarCicloSemanal();
  } catch (e) {
    console.error("[PV] Erro no ciclo semanal:", e);
  }
});

// endpoint auxiliar pra testar sem esperar quarta-feira
app.get("/debug/janela", (req, res) => res.json(computeWeekWindow()));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[PV] Servidor rodando na porta ${PORT}`));
