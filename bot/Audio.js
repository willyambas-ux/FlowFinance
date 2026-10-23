/**
 * Audio.js — transcreve mensagens de voz do Telegram com o Whisper da Groq.
 *
 * Propriedade necessária: GROQ_API_KEY (console.groq.com › API Keys).
 * Opcional: MODELO_AUDIO (padrão whisper-large-v3-turbo).
 */
const Audio = (function () {
  const URL_GROQ = 'https://api.groq.com/openai/v1/audio/transcriptions';
  const MODELO_AUDIO_PADRAO = 'whisper-large-v3-turbo';
  const LIMITE_BYTES = 20 * 1024 * 1024;

  /** Baixa o arquivo de voz do Telegram como Blob. */
  function baixar_(fileId) {
    const blob = Telegram.baixar(fileId, LIMITE_BYTES, 'áudio');
    // Mensagens de voz vêm como .oga (Ogg/Opus); a Groq reconhece pela extensão .ogg
    return blob.setName(String(blob.getName()).replace(/\.oga$/i, '.ogg') || 'voz.ogg');
  }

  /** Devolve o texto falado (string, pode ser vazia). */
  function transcrever(fileId) {
    const chave = Config.get('GROQ_API_KEY');
    if (!chave) {
      throw new Error('falta configurar GROQ_API_KEY nas Propriedades do script do bot');
    }
    const audio = baixar_(fileId);
    const resp = UrlFetchApp.fetch(URL_GROQ, {
      method: 'post',
      headers: { Authorization: 'Bearer ' + chave },
      payload: {
        file: audio,
        model: Config.get('MODELO_AUDIO', MODELO_AUDIO_PADRAO),
        language: 'pt',
        response_format: 'json',
        temperature: '0',
        // Ajuda o reconhecimento de termos comuns nas mensagens
        prompt: 'Lançamento financeiro em português do Brasil: valores em reais, débito, crédito, pix, cartão, parcelas.'
      },
      muteHttpExceptions: true
    });
    const status = resp.getResponseCode();
    let corpo;
    try { corpo = JSON.parse(resp.getContentText()); } catch (e) { corpo = {}; }
    if (status !== 200) {
      const msg = corpo && corpo.error ? corpo.error.message : resp.getContentText().slice(0, 200);
      throw new Error('transcrição respondeu ' + status + ': ' + msg);
    }
    return String(corpo.text || '').trim();
  }

  return { transcrever: transcrever };
})();
