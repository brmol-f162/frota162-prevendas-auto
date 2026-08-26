# Frota162 — Autogestão Pré-Vendas (automática)

Pipeline isolado do `server_v24.js` (ROI Diretoria). Captura Ligação e WhatsApp
dos 6 pré-vendas via webhook Salesbud, agrega semanalmente, pontua com Claude
usando o rubric da skill `pre-vendas-coach` (escala 1-10, **nunca** a nota
nativa da Salesbud), e publica HTML separado por canal + consolidado no Drive
e no Slack.

## Variáveis de ambiente necessárias

| Variável | Descrição |
|---|---|
| `GOOGLE_CREDENTIALS` | JSON da service account (mesma `frota162-pptx@frota162-pptx.iam.gserviceaccount.com`) |
| `ANTHROPIC_API_KEY` | Chave da API Anthropic |
| `SPREADSHEET_ID` | `1KPfZhFQhnKSUhdY7qzonuOyXvv88PuchQbfrCVZgCXI` |
| `PV_SLACK_WEBHOOK_URL` | Webhook de entrada do canal `#sales-prevendas-coach` |
| `SALESBUD_WEBHOOK_SECRET` | Opcional — só se a Salesbud fornecer um segredo de assinatura |

## Setup obrigatório na planilha (antes do primeiro deploy)

Crie 2 abas na planilha (`SPREADSHEET_ID`), com estes cabeçalhos na linha 1:

**Aba `Eventos`** (linha 1, colunas A–I):
```
dataISO | userId | nome | canal | tituloOuChat | duracaoSeg | telefoneOuChat | texto | contextoJSON
```

**Aba `Marcadores`** (linha 1, colunas A–B):
```
chave | processadoEm
```

Sem essas 2 abas com esses nomes exatos, o servidor vai dar erro ao tentar ler/escrever.

## Endpoints

- `POST /webhook/salesbud-prevendas` — registrar na Salesbud (Configurações → Integrações → Webhook)
- `POST /cron/pre-vendas-semanal` — disparado pelo Render Cron Job, segunda de manhã
- `GET /` — health check

## Não testado em produção

Este código nunca recebeu um payload real da Salesbud. Espere ajustar campos
(principalmente o formato exato do payload VoIP/WhatsApp) na primeira entrega
real — acompanhe os logs do Render procurando por `[PV] RECEBIDO`.
