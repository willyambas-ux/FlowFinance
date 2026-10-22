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

function tratarMensagem_(msg) {
  const chatId = msg.chat.id;
  const usuarioId = msg.from && msg.from.id;
  const texto = String(msg.text || '').trim();

  if (texto === '/id') {
    Telegram.enviar(chatId, 'Seu ID do Telegram: <code>' + usuarioId + '</code>');
    return;
  }

  const quem = Config.nomeDoUsuario(usuarioId);
  if (!quem) {
    Telegram.enviar(chatId, 'Este bot é privado.\nSeu ID do Telegram: <code>' + usuarioId + '</code>');
    return;
  }

  if (!texto) {
    Telegram.enviar(chatId, 'Por enquanto eu entendo só texto. Fotos, áudios e arquivos chegam nas próximas fases.');
    return;
  }

  if (texto === '/start' || texto === '/ajuda') {
    Telegram.enviar(chatId, [
      'Olá, ' + Telegram.esc(quem) + '! Me mande um gasto ou recebimento em uma frase:',
      '',
      '<i>almoço 32,50 débito itaú</i>',
      '<i>mercado nordestão 187,40 crédito xp</i>',
      '<i>tênis 600 em 3x no cartão iti</i>',
      '<i>recebi 500 do freela no BB</i>',
      '',
      'Eu mostro o que entendi e você confirma com um toque.',
      '/desfazer apaga o seu último lançamento.'
    ].join('\n'));
    return;
  }

  if (texto === '/desfazer') {
    const chave = CacheService.getScriptCache().get('ultimo_' + usuarioId);
    const r = chave ? Rascunho.ler(chave) : null;
    if (r && Rascunho.desfazer(r)) Telegram.enviar(chatId, 'Pronto, desfeito.');
    else Telegram.enviar(chatId, 'Não achei um lançamento recente seu para desfazer.');
    return;
  }

  if (texto.charAt(0) === '/') {
    Telegram.enviar(chatId, 'Não conheço esse comando. Mande /ajuda.');
    return;
  }

  Telegram.digitando(chatId);
  try {
    const ctx = Contexto.carregar();
    const lido = Interpretador.interpretar(texto, quem, ctx);

    if (lido.tipo === 'nao_e_lancamento') {
      Telegram.enviar(chatId, Telegram.esc(lido.resposta || 'Não entendi como lançamento. Mande algo como: almoço 32,50 débito itaú'));
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
