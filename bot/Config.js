/**
 * Config.js — leitura das Propriedades do Script.
 *
 * Propriedades usadas (Configurações do projeto › Propriedades do script):
 *   TELEGRAM_TOKEN     token do @BotFather
 *   ANTHROPIC_API_KEY  chave da API do Claude
 *   WEBHOOK_SECRET     segredo na URL do webhook (gerado por gerarSegredoWebhook)
 *   WEBAPP_URL         URL da implantação do bot (termina em /exec)
 *   USUARIOS           JSON {"<id do Telegram>": "<nome>"}, ex.: {"123456": "Willyam"}
 *   MODELO_IA          opcional; padrão em MODELO_PADRAO
 *
 * Nenhum segredo fica no código nem no GitHub.
 */

const MODELO_PADRAO = 'claude-haiku-5-5';

const Config = (function () {
  function props_() {
    return PropertiesService.getScriptProperties();
  }

  function get(chave, padrao) {
    const v = props_().getProperty(chave);
    return (v === null || v === '') ? (padrao === undefined ? '' : padrao) : v;
  }

  function set(chave, valor) {
    props_().setProperty(chave, valor);
  }

  /** Mapa id do Telegram -> nome. Vazio se a propriedade estiver ausente ou inválida. */
  function usuarios() {
    try {
      const raw = get('USUARIOS', '{}');
      const obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) {
      console.error('USUARIOS não é um JSON válido: ' + e);
      return {};
    }
  }

  /** Nome do usuário autorizado, ou '' se o id não estiver liberado. */
  function nomeDoUsuario(telegramId) {
    const u = usuarios();
    return u[String(telegramId)] || '';
  }

  return {
    get: get,
    set: set,
    usuarios: usuarios,
    nomeDoUsuario: nomeDoUsuario,
    token: function () { return get('TELEGRAM_TOKEN'); },
    chaveIA: function () { return get('ANTHROPIC_API_KEY'); },
    modelo: function () { return get('MODELO_IA', MODELO_PADRAO); },
    segredo: function () { return get('WEBHOOK_SECRET'); }
  };
})();
