/**
 * Projetos.gs — projetos / metas de economia.
 *
 * Um projeto serve a dois propósitos:
 *   1. Tag para agrupar lançamentos (valor_meta = 0).
 *   2. Meta de economia (valor_meta > 0) — exibida em Metas → Economia.
 *      Saldo atual = saldo confirmado da conta vinculada.
 */
const SHEET_PROJETOS = 'Projetos';

function listProjetos() {
  return DB.readAll(SHEET_PROJETOS);
}

function saveProjeto(data) {
  const record = normalizeProjeto_(data);
  if (data && data.id) return DB.update(SHEET_PROJETOS, data.id, record);
  return DB.insert(SHEET_PROJETOS, record);
}

function deleteProjeto(id) {
  return DB.remove(SHEET_PROJETOS, id);
}

function normalizeProjeto_(data) {
  data = data || {};
  return {
    nome: String(data.nome || '').trim(),
    valor_meta: Utils.toNumber(data.valor_meta),
    data_alvo: data.data_alvo || '',
    conta_vinculada: data.conta_vinculada || ''
  };
}

/**
 * Lista projetos com valor_meta > 0 e calcula progresso.
 */
function getMetasEconomia() {
  const projetos = listProjetos().filter(p => Number(p.valor_meta) > 0);
  if (projetos.length === 0) return [];

  const saldos = getSaldosContas();
  const hoje = new Date();

  return projetos.map(p => {
    const valorMeta = Number(p.valor_meta) || 0;
    let saldoAtual = 0;
    let nomeConta = '';
    if (p.conta_vinculada) {
      const s = saldos.find(x => String(x.id) === String(p.conta_vinculada));
      if (s) {
        saldoAtual = Number(s.confirmado) || 0;
        nomeConta = s.nome;
      }
    }
    const restante = Math.max(0, valorMeta - saldoAtual);

    let mesesRestantes = 0;
    if (p.data_alvo) {
      const s = String(p.data_alvo);
      const alvo = new Date(s + (s.length === 10 ? 'T00:00:00' : ''));
      if (!isNaN(alvo.getTime())) {
        mesesRestantes = Math.max(0,
          (alvo.getFullYear() - hoje.getFullYear()) * 12 + (alvo.getMonth() - hoje.getMonth())
        );
      }
    }
    const aplicacaoIdeal = mesesRestantes > 0 ? restante / mesesRestantes : 0;

    return {
      id: p.id,
      nome: p.nome,
      valor_meta: valorMeta,
      data_alvo: p.data_alvo,
      conta_vinculada: p.conta_vinculada,
      nome_conta: nomeConta,
      saldo_atual: saldoAtual,
      restante: restante,
      meses_restantes: mesesRestantes,
      aplicacao_mensal_ideal: aplicacaoIdeal,
      percentual: valorMeta > 0 ? Math.min(100, Math.round((saldoAtual / valorMeta) * 100)) : 0
    };
  });
}
