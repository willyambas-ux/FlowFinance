/**
 * Contas.gs — CRUD de contas (bancárias / caixa / investimento / etc).
 * API top-level exposta ao frontend via google.script.run.
 */
const SHEET_CONTAS = 'Contas';

const CONTA_TIPO_ORDEM_ = {
  corrente: 1, poupanca: 2, vale: 3, dinheiro: 4,
  investimento: 5, emprestimo: 6, outra: 7
};

function listContas() {
  return DB.readAll(SHEET_CONTAS).sort((a, b) => {
    const ta = CONTA_TIPO_ORDEM_[a.tipo] || 99;
    const tb = CONTA_TIPO_ORDEM_[b.tipo] || 99;
    if (ta !== tb) return ta - tb;
    return String(a.nome || '').localeCompare(
      String(b.nome || ''), 'pt-BR', { numeric: true, sensitivity: 'base' }
    );
  });
}

function saveConta(data) {
  const record = normalizeConta_(data);
  if (data && data.id) return DB.update(SHEET_CONTAS, data.id, record);
  return DB.insert(SHEET_CONTAS, record);
}

function deleteConta(id) {
  return DB.remove(SHEET_CONTAS, id);
}

function normalizeConta_(data) {
  data = data || {};
  return {
    nome: String(data.nome || '').trim(),
    tipo: data.tipo || 'corrente',
    saldo_inicial: Utils.toNumber(data.saldo_inicial),
    data_saldo_inicial: data.data_saldo_inicial || Utils.today(),
    icone: data.icone || 'account_balance',
    icone_url: data.icone_url || '',
    moeda: data.moeda || 'BRL',
    banco: String(data.banco || '').trim(),
    agencia: String(data.agencia || '').trim(),
    numero: String(data.numero || '').trim(),
    limite: Utils.toNumber(data.limite),
    contato: String(data.contato || '').trim(),
    telefone: String(data.telefone || '').trim(),
    ativo: data.ativo === undefined ? true : Utils.toBool(data.ativo)
  };
}
