/**
 * FlowFinance — entry point.
 * Backend: Google Apps Script. Banco: Google Sheets (uma aba por entidade).
 */

const APP_NAME = 'FlowFinance';
const APP_VERSION = '0.1.0';

/**
 * Duas interfaces na mesma URL:
 *   /exec                         app novo (celular primeiro): novo.html
 *   /exec?v=classico&tela=cartoes app clássico (index.html), aberto na tela pedida
 */
const TELAS_CLASSICO_ = ['visao-geral', 'lancamentos', 'cartoes', 'patrimonio', 'metas',
  'relatorios', 'importar', 'fechamento', 'cadastros', 'configuracoes'];

function doGet(e) {
  Init.ensureAllSheets();
  const p = (e && e.parameter) || {};
  let t;
  if (p.v === 'classico') {
    t = HtmlService.createTemplateFromFile('index');
    t.tela = TELAS_CLASSICO_.indexOf(p.tela) !== -1 ? p.tela : '';
  } else {
    t = HtmlService.createTemplateFromFile('novo');
  }
  return t.evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu(APP_NAME)
      .addItem('Inicializar abas', 'menuInit')
      .addItem('Abrir app web', 'menuOpenApp')
      .addToUi();
  } catch (err) {
    // sem UI (script standalone)
  }
}

function menuInit() {
  const created = Init.ensureAllSheets();
  if (typeof Cache !== 'undefined') Cache.invalidateAll();
  const msg = created.length
    ? 'Abas criadas: ' + created.join(', ')
    : 'Todas as abas já existem.';
  SpreadsheetApp.getUi().alert(msg);
}

function menuOpenApp() {
  const url = ScriptApp.getService().getUrl();
  if (!url) {
    SpreadsheetApp.getUi().alert('Implante como Web App primeiro (Implantar → Nova implantação → Web app).');
    return;
  }
  const html = '<script>window.open("' + url + '","_blank"); google.script.host.close();</script>';
  SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutput(html), 'Abrindo...');
}

function getAppInfo() {
  const ss = DB.getSpreadsheet();
  return {
    name: APP_NAME,
    version: APP_VERSION,
    user: Session.getActiveUser().getEmail(),
    spreadsheetUrl: ss.getUrl(),
    spreadsheetName: ss.getName(),
    timezone: Session.getScriptTimeZone()
  };
}

/* ============================================================================
 * Manutenção (chamado pela view Configurações)
 * ========================================================================== */

function clearAllCaches() {
  if (typeof Cache !== 'undefined') Cache.invalidateAll();
  return { ok: true };
}

function reinitializeSheets() {
  const created = Init.ensureAllSheets();
  clearAllCaches();
  return { created: created };
}

/**
 * Re-aplica regras a todos os lançamentos existentes, preenchendo campos vazios.
 * Não sobrescreve nada que já tenha valor. Retorna a contagem de atualizados.
 */
function aplicarRegrasEmTodos() {
  const todos = DB.readAll(SHEET_LANCAMENTOS);
  const campos = ['categoria', 'centro'];
  let atualizados = 0;
  todos.forEach(l => {
    const processed = aplicarRegras(l);
    let mudou = false;
    for (let i = 0; i < campos.length; i++) {
      const k = campos[i];
      if (Utils.isEmpty(l[k]) && !Utils.isEmpty(processed[k])) {
        mudou = true; break;
      }
    }
    if (mudou) {
      DB.update(SHEET_LANCAMENTOS, l.id, processed);
      atualizados++;
    }
  });
  return { atualizados: atualizados };
}

/**
 * Retorna todos os lançamentos com nomes resolvidos (não IDs) para conta, categoria, centro.
 * Usado pelo cliente para exportar CSV.
 */
function exportarLancamentosDetalhado() {
  const lancs = DB.readAll(SHEET_LANCAMENTOS);
  const contas = DB.readAll('Contas');
  const cats = DB.readAll('Categorias');
  const centros = DB.readAll('Centros');
  const cartoes = DB.readAll('Cartoes');

  const nomeDe = (lista, id) => {
    if (!id) return '';
    const x = lista.find(item => String(item.id) === String(id));
    return x ? x.nome : '';
  };

  return lancs.map(l => ({
    data: l.data || '',
    descricao: l.descricao || '',
    valor: l.valor || 0,
    conta: nomeDe(contas, l.conta),
    cartao: nomeDe(cartoes, l.cartao),
    categoria: nomeDe(cats, l.categoria),
    centro: nomeDe(centros, l.centro),
    status: l.status || '',
    parcela: (l.parcela_atual && l.parcela_total) ? l.parcela_atual + '/' + l.parcela_total : '',
    observacao: l.observacao || ''
  }));
}
