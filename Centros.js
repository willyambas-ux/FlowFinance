/**
 * Centros.gs — CRUD de centros de custo (fixa/variável/eventual).
 */
const SHEET_CENTROS = 'Centros';

function listCentros() {
  return DB.readAll(SHEET_CENTROS);
}

function saveCentro(data) {
  const record = normalizeCentro_(data);
  if (data && data.id) return DB.update(SHEET_CENTROS, data.id, record);
  return DB.insert(SHEET_CENTROS, record);
}

function deleteCentro(id) {
  return DB.remove(SHEET_CENTROS, id);
}

function normalizeCentro_(data) {
  data = data || {};
  return {
    nome: String(data.nome || '').trim(),
    tipo: data.tipo || 'fixa',
    cor: data.cor || '#4285F4'
  };
}
