/**
 * Categorias.gs — CRUD de categorias (hierárquicas, com tipo receita/despesa/transferência).
 */
const SHEET_CATEGORIAS = 'Categorias';

function listCategorias() {
  return DB.readAll(SHEET_CATEGORIAS);
}

function saveCategoria(data) {
  const record = normalizeCategoria_(data);
  if (data && data.id) return DB.update(SHEET_CATEGORIAS, data.id, record);
  return DB.insert(SHEET_CATEGORIAS, record);
}

function deleteCategoria(id) {
  return DB.remove(SHEET_CATEGORIAS, id);
}

function normalizeCategoria_(data) {
  data = data || {};
  return {
    nome: String(data.nome || '').trim(),
    pai: data.pai || '',
    tipo: data.tipo || 'despesa',
    icone: data.icone || 'label'
  };
}
