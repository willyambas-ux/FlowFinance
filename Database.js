/**
 * Database.gs — CRUD genérico sobre abas de uma planilha.
 * Convenção: linha 1 = cabeçalho com nomes das colunas; coluna 'id' obrigatória.
 */

const SPREADSHEET_ID_KEY = 'FLOWFINANCE_SPREADSHEET_ID';

const SHEET_TO_CACHE_KEY = {
  'Contas':       'contas',
  'Categorias':   'categorias',
  'Centros':      'centros',
  'Cartoes':      'cartoes',
  'Projetos':     'projetos',
  'Regras':       'regras',
  'Recorrencias': 'recorrencias',
  'Lancamentos':  'lancamentos',
  'Orcamentos':   'orcamentos',
  'Fechamentos':  'fechamentos',
  'Tags':         'tags',
  'Contatos':     'contatos'
};

const DB = (function () {
  function getSpreadsheet() {
    const id = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID_KEY);
    if (id) return SpreadsheetApp.openById(id);
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
    throw new Error('Nenhuma planilha vinculada. Configure FLOWFINANCE_SPREADSHEET_ID em Propriedades do Script.');
  }

  function setSpreadsheetId(id) {
    PropertiesService.getScriptProperties().setProperty(SPREADSHEET_ID_KEY, id);
  }

  function getSheet(name) {
    const sheet = getSpreadsheet().getSheetByName(name);
    if (!sheet) throw new Error('Aba não encontrada: ' + name);
    return sheet;
  }

  function getHeaders(sheetName) {
    const sheet = getSheet(sheetName);
    const cols = sheet.getLastColumn();
    if (cols === 0) return [];
    return sheet.getRange(1, 1, 1, cols).getValues()[0].map(h => String(h).trim());
  }

  function readAll(sheetName) {
    const cacheKey = SHEET_TO_CACHE_KEY[sheetName];
    if (cacheKey && typeof Cache !== 'undefined') {
      return Cache.getOrFetch(cacheKey, function () { return readAllUncached_(sheetName); });
    }
    return readAllUncached_(sheetName);
  }

  function readAllUncached_(sheetName) {
    const sheet = getSheet(sheetName);
    const rows = sheet.getLastRow();
    const cols = sheet.getLastColumn();
    if (rows < 2 || cols === 0) return [];
    const values = sheet.getRange(1, 1, rows, cols).getValues();
    const headers = values[0].map(h => String(h).trim());
    return values.slice(1).map(r => rowToObject_(r, headers));
  }

  function invalidateCache_(sheetName) {
    const key = SHEET_TO_CACHE_KEY[sheetName];
    if (key && typeof Cache !== 'undefined') Cache.invalidate(key);
  }

  function rowToObject_(row, headers) {
    const obj = {};
    for (let i = 0; i < headers.length; i++) {
      let v = row[i];
      if (v instanceof Date) v = Utils.formatDate(v);
      obj[headers[i]] = v;
    }
    return obj;
  }

  function objectToRow_(obj, headers) {
    return headers.map(h => (obj[h] !== undefined ? obj[h] : ''));
  }

  function insert(sheetName, record) {
    const sheet = getSheet(sheetName);
    const headers = getHeaders(sheetName);
    if (headers.indexOf('id') !== -1 && !record.id) record.id = Utils.uuid();
    if (headers.indexOf('criado_em') !== -1 && !record.criado_em) {
      record.criado_em = new Date().toISOString();
    }
    sheet.appendRow(objectToRow_(record, headers));
    invalidateCache_(sheetName);
    return record;
  }

  /**
   * Inserção em lote — muito mais rápido que `insert` em loop (uma escrita só).
   * Cada record recebe id/criado_em se as colunas existirem e não vieram preenchidas.
   */
  function batchInsert(sheetName, records) {
    if (!records || records.length === 0) return [];
    const sheet = getSheet(sheetName);
    const headers = getHeaders(sheetName);
    const hasId = headers.indexOf('id') !== -1;
    const hasCriadoEm = headers.indexOf('criado_em') !== -1;
    const nowISO = new Date().toISOString();

    const rows = records.map(r => {
      if (hasId && !r.id) r.id = Utils.uuid();
      if (hasCriadoEm && !r.criado_em) r.criado_em = nowISO;
      return objectToRow_(r, headers);
    });

    const startRow = sheet.getLastRow() + 1;
    sheet.getRange(startRow, 1, rows.length, headers.length).setValues(rows);
    invalidateCache_(sheetName);
    return records;
  }

  function update(sheetName, id, patch) {
    const sheet = getSheet(sheetName);
    const headers = getHeaders(sheetName);
    const idCol = headers.indexOf('id');
    if (idCol === -1) throw new Error('Aba ' + sheetName + ' sem coluna id');
    const last = sheet.getLastRow();
    if (last < 2) return null;
    const ids = sheet.getRange(2, idCol + 1, last - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(id)) {
        const r = i + 2;
        const current = rowToObject_(sheet.getRange(r, 1, 1, headers.length).getValues()[0], headers);
        const updated = Object.assign({}, current, patch, { id: current.id });
        sheet.getRange(r, 1, 1, headers.length).setValues([objectToRow_(updated, headers)]);
        invalidateCache_(sheetName);
        return updated;
      }
    }
    return null;
  }

  function remove(sheetName, id) {
    const sheet = getSheet(sheetName);
    const headers = getHeaders(sheetName);
    const idCol = headers.indexOf('id');
    if (idCol === -1) return false;
    const last = sheet.getLastRow();
    if (last < 2) return false;
    const ids = sheet.getRange(2, idCol + 1, last - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(id)) {
        sheet.deleteRow(i + 2);
        invalidateCache_(sheetName);
        return true;
      }
    }
    return false;
  }

  function findById(sheetName, id) {
    return readAll(sheetName).find(r => String(r.id) === String(id)) || null;
  }

  /**
   * Atualiza vários registros de uma vez (1 leitura + 1 escrita).
   * @param {string} sheetName
   * @param {Object} patchById - { id: {campo: valor, ...} }
   * @returns {number} quantidade de linhas alteradas
   */
  function batchUpdate(sheetName, patchById) {
    const sheet = getSheet(sheetName);
    const headers = getHeaders(sheetName);
    const idCol = headers.indexOf('id');
    if (idCol === -1) return 0;
    const last = sheet.getLastRow();
    if (last < 2) return 0;
    const range = sheet.getRange(2, 1, last - 1, headers.length);
    const values = range.getValues();
    let count = 0;
    for (let i = 0; i < values.length; i++) {
      const id = String(values[i][idCol]);
      const patch = patchById[id];
      if (!patch) continue;
      const obj = rowToObject_(values[i], headers);
      const updated = Object.assign({}, obj, patch, { id: obj.id });
      values[i] = objectToRow_(updated, headers);
      count++;
    }
    if (count > 0) {
      range.setValues(values);
      invalidateCache_(sheetName);
    }
    return count;
  }

  /** Remove várias linhas de uma vez (de baixo pra cima, pra não bagunçar índices). */
  function batchRemove(sheetName, ids) {
    const sheet = getSheet(sheetName);
    const headers = getHeaders(sheetName);
    const idCol = headers.indexOf('id');
    if (idCol === -1) return 0;
    const last = sheet.getLastRow();
    if (last < 2) return 0;
    const idSet = {};
    (ids || []).forEach(id => { idSet[String(id)] = true; });
    const allIds = sheet.getRange(2, idCol + 1, last - 1, 1).getValues();
    const rows = [];
    for (let i = 0; i < allIds.length; i++) {
      if (idSet[String(allIds[i][0])]) rows.push(i + 2);
    }
    rows.sort((a, b) => b - a).forEach(rowNum => sheet.deleteRow(rowNum));
    if (rows.length > 0) invalidateCache_(sheetName);
    return rows.length;
  }

  return {
    getSpreadsheet: getSpreadsheet,
    setSpreadsheetId: setSpreadsheetId,
    getSheet: getSheet,
    getHeaders: getHeaders,
    readAll: readAll,
    insert: insert,
    batchInsert: batchInsert,
    update: update,
    batchUpdate: batchUpdate,
    remove: remove,
    batchRemove: batchRemove,
    findById: findById
  };
})();
