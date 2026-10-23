/**
 * Setup.js — funções para rodar À MÃO no editor do Apps Script (menu "Executar").
 * Os resultados aparecem no "Registro de execução".
 *
 * Ordem na primeira vez:
 *   1. gerarSegredoWebhook
 *   2. (preencher TELEGRAM_TOKEN, ANTHROPIC_API_KEY e USUARIOS nas Propriedades do script)
 *   3. verificarConfig
 *   4. testarIA
 *   5. Implantar como app da Web e colar a URL em WEBAPP_URL
 *   6. configurarWebhook
 *   7. configurarComandos (menu "/" no Telegram)
 *   Áudio: crie GROQ_API_KEY e rode testarChaveAudio
 */

function gerarSegredoWebhook() {
  if (Config.segredo()) {
    console.log('WEBHOOK_SECRET já existe. Nada foi alterado.');
    return;
  }
  Config.set('WEBHOOK_SECRET', Utilities.getUuid().replace(/-/g, ''));
  console.log('WEBHOOK_SECRET criado.');
}

function verificarConfig() {
  const linhas = [];
  ['TELEGRAM_TOKEN', 'ANTHROPIC_API_KEY', 'WEBHOOK_SECRET', 'USUARIOS', 'WEBAPP_URL'].forEach(k => {
    linhas.push((Config.get(k) ? 'OK      ' : 'FALTA   ') + k);
  });

  linhas.push((Config.get('GROQ_API_KEY') ? 'OK      ' : 'FALTA   ') + 'GROQ_API_KEY (só para áudio)');

  const usuarios = Config.usuarios();
  linhas.push('Usuários liberados: ' + (Object.keys(usuarios).length
    ? Object.keys(usuarios).map(id => usuarios[id] + ' (' + id + ')').join(', ')
    : 'nenhum'));

  try {
    const me = Telegram.chamar('getMe', {});
    linhas.push(me.ok ? 'Telegram OK: @' + me.result.username : 'Telegram ERRO: ' + me.description);
  } catch (e) { linhas.push('Telegram ERRO: ' + e.message); }

  try {
    FF.reinitializeSheets(); // garante a coluna "quem" em Lancamentos
    const ctx = Contexto.carregar();
    linhas.push('Planilha OK: ' + ctx.contas.length + ' contas, ' + ctx.cartoes.length + ' cartões, ' + ctx.categorias.length + ' categorias');
  } catch (e) {
    linhas.push('Planilha ERRO: ' + e.message);
    linhas.push('  Dica: no projeto FlowFinance, crie a propriedade FLOWFINANCE_SPREADSHEET_ID com o ID da planilha.');
  }

  console.log(linhas.join('\n'));
}

/** Testa a IA sem passar pelo Telegram. Troque a frase à vontade. */
function testarIA() {
  const frases = [
    'mercado nordestão 187,40 no crédito xp',
    'paguei 150 no posto',
    'recebi 500 do freela no BB ontem',
    'tênis 600 em 3x no cartão iti',
    'quanto gastei em mercado este mês?',
    'qual o saldo do BB?',
    'o que vence esta semana?'
  ];
  const ctx = Contexto.carregar();
  frases.forEach(f => {
    const r = Interpretador.interpretar(f, 'Teste', ctx);
    console.log(f + '\n' + JSON.stringify(r, null, 2));
  });
}

/** Testa as consultas sem passar pelo Telegram nem pela IA. */
function testarConsultas() {
  const ctx = Contexto.carregar();
  Consultas.TIPOS.forEach(tipo => {
    console.log('--- ' + tipo + '\n' + Consultas.responder({ tipo: tipo }, ctx).replace(/<[^>]+>/g, ''));
  });
}

/** Confere se a chave da Groq (transcrição de áudio) é aceita. */
function testarChaveAudio() {
  const chave = Config.get('GROQ_API_KEY');
  if (!chave) { console.log('Falta GROQ_API_KEY.'); return; }
  const resp = UrlFetchApp.fetch('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: 'Bearer ' + chave }, muteHttpExceptions: true
  });
  console.log(resp.getResponseCode() === 200 ? 'Chave da Groq OK.' : 'Chave da Groq com problema: ' + resp.getContentText().slice(0, 200));
}

/** Mostra os comandos no menu "/" do Telegram. Rode uma vez. */
function configurarComandos() {
  const r = Telegram.chamar('setMyCommands', {
    commands: [
      { command: 'resumo', description: 'Resumo do mês até agora' },
      { command: 'saldos', description: 'Saldos das contas' },
      { command: 'contas', description: 'Contas a pagar nos próximos 7 dias' },
      { command: 'faturas', description: 'Faturas dos cartões' },
      { command: 'orcamentos', description: 'Situação dos orçamentos' },
      { command: 'desfazer', description: 'Apaga o seu último lançamento' },
      { command: 'ajuda', description: 'Exemplos do que posso fazer' }
    ]
  });
  console.log(r.ok ? 'Comandos configurados.' : 'Erro: ' + r.description);
}

function configurarWebhook() {
  const url = Config.get('WEBAPP_URL');
  const segredo = Config.segredo();
  if (!url || !segredo) {
    console.log('Preencha WEBAPP_URL e rode gerarSegredoWebhook antes.');
    return;
  }
  const r = Telegram.chamar('setWebhook', {
    url: url + '?secret=' + segredo,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
    max_connections: 1
  });
  console.log(r.ok ? 'Webhook configurado.' : 'Erro: ' + r.description);
}

function infoWebhook() {
  const r = Telegram.chamar('getWebhookInfo', {});
  if (r.ok && r.result) {
    // Não imprime a URL inteira: ela contém o segredo
    const info = Object.assign({}, r.result);
    if (info.url) info.url = info.url.split('?')[0] + '?secret=***';
    console.log(JSON.stringify(info, null, 2));
  } else {
    console.log(JSON.stringify(r));
  }
}

function removerWebhook() {
  console.log(JSON.stringify(Telegram.chamar('deleteWebhook', { drop_pending_updates: true })));
}
