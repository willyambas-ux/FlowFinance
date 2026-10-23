/**
 * Fechamentos.gs — conciliação manual de saldo real x sistema.
 *
 * Fluxo: o usuário informa o saldo real de uma conta em uma data.
 * O sistema calcula o saldo esperado (saldo_inicial + lançamentos confirmados/conciliados até a data)
 * e mostra a diferença. Se solicitado, cria um lançamento de ajuste.
 */
const SHEET_FECHAMENTOS = 'Fechamentos';

function listFechamentos() {
  return DB.readAll(SHEET_FECHAMENTOS)
    .sort((a, b) => String(b.data).localeCompare(String(a.data)));
}

function deleteFechamento(id) {
  return DB.remove(SHEET_FECHAMENTOS, id);
}

/**
 * Saldo confirmado da conta até a data (inclusive).
 */
function getSaldoContaNaData(contaId, dataAlvo) {
  const conta = DB.findById('Contas', contaId);
  if (!conta) throw new Error('Conta não encontrada.');
  const ini = Number(conta.saldo_inicial) || 0;
  const lancs = DB.readAll(SHEET_LANCAMENTOS);
  let saldo = ini;
  lancs.forEach(l => {
    if (l.conta !== contaId) return;
    if (l.data > dataAlvo) return;
    if (Utils.statusRealizado(l.status)) {
      saldo += Number(l.valor) || 0;
    }
  });
  return saldo;
}

/**
 * Registra o fechamento e (opcionalmente) cria lançamento de ajuste pela diferença.
 * Retorna saldo_sistema, saldo_real, diferenca e ajuste_criado.
 */
function fecharPosicao(contaId, dataAlvo, saldoReal, criarAjuste) {
  if (!contaId)  throw new Error('Conta é obrigatória.');
  if (!dataAlvo) throw new Error('Data é obrigatória.');

  const saldoSistema = getSaldoContaNaData(contaId, dataAlvo);
  const real = Utils.toNumber(saldoReal);
  const diferenca = +(real - saldoSistema).toFixed(2);

  DB.insert(SHEET_FECHAMENTOS, {
    data: dataAlvo,
    conta: contaId,
    saldo_real: real
  });

  let ajusteCriado = false;
  if (criarAjuste && Math.abs(diferenca) >= 0.01) {
    saveLancamento({
      data: dataAlvo,
      descricao: 'Ajuste de fechamento',
      valor: diferenca,
      conta: contaId,
      status: 'conciliado',
      observacao: 'Ajuste automático em fechamento de posição.'
    });
    ajusteCriado = true;
  }

  return {
    saldo_sistema: saldoSistema,
    saldo_real: real,
    diferenca: diferenca,
    ajuste_criado: ajusteCriado
  };
}
