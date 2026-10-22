/**
 * Telegram.js — chamadas à Bot API do Telegram.
 */
const Telegram = (function () {
  function chamar(metodo, params) {
    const token = Config.token();
    if (!token) throw new Error('TELEGRAM_TOKEN não configurado.');
    const resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + metodo, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(params || {}),
      muteHttpExceptions: true
    });
    let corpo;
    try { corpo = JSON.parse(resp.getContentText()); }
    catch (e) { corpo = { ok: false, description: resp.getContentText() }; }
    if (!corpo.ok) {
      // "message is not modified" não é erro real (mesmo texto e botões)
      const desc = String(corpo.description || '');
      if (desc.indexOf('message is not modified') === -1) {
        console.error('Telegram ' + metodo + ' falhou: ' + desc);
      }
    }
    return corpo;
  }

  function enviar(chatId, texto, botoes) {
    const params = {
      chat_id: chatId,
      text: texto,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };
    if (botoes) params.reply_markup = { inline_keyboard: botoes };
    return chamar('sendMessage', params);
  }

  function editar(chatId, messageId, texto, botoes) {
    const params = {
      chat_id: chatId,
      message_id: messageId,
      text: texto,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: botoes || [] }
    };
    return chamar('editMessageText', params);
  }

  function responderBotao(callbackId, aviso) {
    const params = { callback_query_id: callbackId };
    if (aviso) params.text = aviso;
    return chamar('answerCallbackQuery', params);
  }

  function digitando(chatId) {
    return chamar('sendChatAction', { chat_id: chatId, action: 'typing' });
  }

  /** Escapa texto para parse_mode HTML. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  return {
    chamar: chamar,
    enviar: enviar,
    editar: editar,
    responderBotao: responderBotao,
    digitando: digitando,
    esc: esc
  };
})();
