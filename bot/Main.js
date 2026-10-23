/**
 * FlowFinance Bot — recebe mensagens do Telegram e cria lançamentos no FlowFinance.
 *
 * Fluxo: Telegram -> doPost -> confere segredo e usuário -> IA interpreta ->
 * rascunho com botões -> você confirma -> FF.saveLancamento grava na planilha.
 */

function doGet() {
  return ContentService.createTextOutput('FlowFinance Bot ativo.');
}

function doPost(e) {
  try {
    // 1. Só aceita chamadas com o segredo configurado no webhook
    const segredo = Config.segredo();
    if (!segredo || !e || !e.parameter || e.parameter.secret !== segredo) {
      return ok_();
    }

    // Notificação de compra vinda do MacroDroid (celular Android)
    if (e.parameter.origem === 'notificacao') {
      const dados = Object.assign({}, e.parameter);
      try {
        const tipo = String(e.postData && e.postData.type || '');
        if (tipo.indexOf('json') !== -1) Object.assign(dados, JSON.parse(e.postData.contents));
      } catch (err) { /* corpo em formulário já está em e.parameter */ }
      const trava = LockService.getScriptLock();
      if (!trava.tryLock(25000)) return ok_();
      try { Notificacoes.processar(dados); } finally { trava.releaseLock(); }
      return ok_();
    }

    const update = JSON.parse(e.postData.contents);

    // 2. Uma atualização por vez, e cada update_id só uma vez
    //    (o Telegram pode reenviar a mesma mensagem)
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) return ok_();
    try {
      const cache = CacheService.getScriptCache();
      const marca = 'upd_' + update.update_id;
      if (cache.get(marca)) return ok_();
      cache.put(marca, '1', 21600);

      if (update.callback_query) tratarBotao_(update.callback_query);
      else if (update.message) tratarMensagem_(update.message);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    console.error('doPost: ' + (err && err.stack ? err.stack : err));
  }
  return ok_();
}

/**
 * Resposta ao Telegram. Precisa ser HtmlService: com ContentService o Apps Script
 * responde "302 Found" (redirecionamento), o Telegram entende como falha e fica
 * reenviando a mesma atualização, travando a fila.
 */
function ok_() {
  return HtmlService.createHtmlOutput('ok');
}

const COMANDOS_CONSULTA = {
  '/resumo': { tipo: 'resumo' },
  '/saldos': { tipo: 'saldo' },
  '/contas': { tipo: 'vencimentos', dias: 7 },
  '/faturas': { tipo: 'fatura' },
  '/orcamentos': { tipo: 'orcamentos' }
};

function tratarMensagem_(msg) {
  const chatId = msg.chat.id;
  const usuarioId = msg.from && msg.from.id;
  let texto = String(msg.text || '').trim();
  // Em grupos o Telegram manda "/resumo@nome_do_bot"
  const cmd = texto.charAt(0) === '/' ? texto.split(/\s+/)[0].split('@')[0].toLowerCase() : '';

  if (cmd === '/id') {
    Telegram.enviar(chatId, 'Seu ID do Telegram: <code>' + usuarioId + '</code>');
    return;
  }

  const quem = Config.nomeDoUsuario(usuarioId);
  if (!quem) {
    Telegram.enviar(chatId, 'Este bot é privado.\nSeu ID do Telegram: <code>' + usuarioId + '</code>');
    return;
  }

  // Áudio: transcreve e segue como se fosse texto
  const voz = msg.voice || msg.audio;
  if (!texto && voz) {
    Telegram.digitando(chatId);
    try {
      texto = Audio.transcrever(voz.file_id);
    } catch (err) {
      console.error('audio: ' + (err && err.stack ? err.stack : err));
      Telegram.enviar(chatId, 'Não consegui ouvir o áudio: ' + Telegram.esc(String(err.message || err)));
      return;
    }
    if (!texto) {
      Telegram.enviar(chatId, 'Não entendi o áudio. Pode repetir ou escrever?');
      return;
    }
    Telegram.enviar(chatId, 'Ouvi: <i>' + Telegram.esc(texto) + '</i>');
    processarTexto_(chatId, usuarioId, quem, texto);
    return;
  }

  // Foto (ou PDF/imagem como arquivo) de cupom, nota ou comprovante
  if (msg.photo || msg.document) {
    if (Cupom.processar(msg, chatId, usuarioId, quem)) return;
    Telegram.enviar(chatId, 'Esse tipo de arquivo eu ainda não leio. Mande a foto do cupom ou um PDF.');
    return;
  }

  if (!texto) {
    Telegram.enviar(chatId, 'Eu entendo texto, áudio e foto de cupom ou comprovante.');
    return;
  }

  if (cmd === '/start' || cmd === '/ajuda') {
    Telegram.enviar(chatId, [
      'Olá, ' + Telegram.esc(quem) + '! Me mande um gasto ou recebimento em uma frase, escrita ou em áudio:',
      '',
      '<i>almoço 32,50 débito itaú</i>',
      '<i>mercado nordestão 187,40 crédito xp</i>',
      '<i>tênis 600 em 3x no cartão iti</i>',
      '<i>recebi 500 do freela no BB</i>',
      '',
      'Ou mande a <b>foto do cupom</b> ou do comprovante (Pix, maquininha). Na legenda, se quiser, diga o pagamento: <i>xp</i>, <i>itaú</i>.',
      'Cupom comprido (mercado): mande em várias fotos de uma vez (álbum), de cima para baixo. Esqueceu uma parte? Responda ao rascunho com a foto que faltou.',
      '',
      'Também respondo perguntas:',
      '<i>quanto gastei em mercado este mês?</i>',
      '<i>qual o saldo do BB?</i>',
      '<i>o que vence esta semana?</i>',
      '',
      '/resumo o mês até agora · /saldos das contas · /contas a pagar em 7 dias · /faturas dos cartões · /orcamentos',
      '/preco arroz mostra onde você pagou menos (vem dos itens dos cupons).',
      '/desfazer apaga o seu último lançamento.'
    ].join('\n'));
    return;
  }

  if (cmd === '/desfazer') {
    const chave = CacheService.getScriptCache().get('ultimo_' + usuarioId);
    const r = chave ? Rascunho.ler(chave) : null;
    if (r && Rascunho.desfazer(r)) Telegram.enviar(chatId, 'Pronto, desfeito.');
    else Telegram.enviar(chatId, 'Não achei um lançamento recente seu para desfazer.');
    return;
  }

  if (cmd === '/preco' || cmd === '/precos') {
    Telegram.digitando(chatId);
    responderConsulta_(chatId, { tipo: 'precos', termo: texto.split(/\s+/).slice(1).join(' ') });
    return;
  }

  if (COMANDOS_CONSULTA[cmd]) {
    Telegram.digitando(chatId);
    responderConsulta_(chatId, COMANDOS_CONSULTA[cmd]);
    return;
  }

  if (cmd) {
    Telegram.enviar(chatId, 'Não conheço esse comando. Mande /ajuda.');
    return;
  }

  // Link da NFC-e (QR lido pela câmera) ou chave de 44 dígitos
  if (Cupom.processarTexto(texto, chatId, usuarioId, quem)) return;

  processarTexto_(chatId, usuarioId, quem, texto);
}

/** Texto livre (digitado ou transcrito): lançamento, consulta ou conversa. */
function processarTexto_(chatId, usuarioId, quem, texto) {
  Telegram.digitando(chatId);
  try {
    const ctx = Contexto.carregar();
    const lido = Interpretador.interpretar(texto, quem, ctx);

    if (lido.tipo === 'consulta') {
      responderConsulta_(chatId, lido.consulta, ctx);
      return;
    }
    if (lido.tipo === 'nao_e_lancamento') {
      Telegram.enviar(chatId, Telegram.esc(lido.resposta || 'Não entendi. Mande um gasto, como "almoço 32,50 débito itaú", ou uma pergunta, como "quanto gastei este mês?".'));
      return;
    }

    const r = Rascunho.criar(Object.assign({}, lido, {
      chatId: chatId,
      usuarioId: usuarioId,
      quem: quem,
      textoOriginal: texto
    }));
    Rascunho.mostrarNovo(r, ctx);
  } catch (err) {
    console.error('interpretar: ' + (err && err.stack ? err.stack : err));
    Telegram.enviar(chatId, 'Não consegui processar agora: ' + Telegram.esc(String(err.message || err)));
  }
}

function responderConsulta_(chatId, consulta, ctx) {
  try {
    Telegram.enviar(chatId, Consultas.responder(consulta, ctx));
  } catch (err) {
    console.error('consulta: ' + (err && err.stack ? err.stack : err));
    Telegram.enviar(chatId, 'Não consegui consultar agora: ' + Telegram.esc(String(err.message || err)));
  }
}

function tratarBotao_(cb) {
  let aviso = '';
  try {
    if (!Config.nomeDoUsuario(cb.from.id)) aviso = 'Bot privado.';
    else aviso = Rascunho.tratarBotao(cb.data, cb.from.id);
  } catch (err) {
    console.error('botão: ' + (err && err.stack ? err.stack : err));
    aviso = 'Erro: ' + String(err.message || err).slice(0, 150);
  }
  Telegram.responderBotao(cb.id, aviso);
}
