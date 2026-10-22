/**
 * Patrimonio.gs — balanço patrimonial (snapshot do PL em uma data).
 *
 * Ativos:  saldos positivos de contas + saldo positivo (raro) em cartões.
 * Passivos: saldos negativos de contas + saldo devedor em cartões.
 * PL = Ativos − Passivos.
 *
 * Cartões: saldo = sum(lançamentos com cartao=X). Compras são negativas,
 * pagamentos (pernas de transferência) são positivos — net = devedor.
 */

function getBalancoPatrimonial(dataAlvo) {
  dataAlvo = dataAlvo || Utils.today();
  const contas = listContas();
  const cartoes = listCartoes();
  const lancs = DB.readAll(SHEET_LANCAMENTOS);

  const saldosContas = contas.map(c => {
    let saldo = Number(c.saldo_inicial) || 0;
    lancs.forEach(l => {
      if (l.conta !== c.id) return;
      if (l.data > dataAlvo) return;
      if (l.status === 'confirmado' || l.status === 'conciliado') {
        saldo += Number(l.valor) || 0;
      }
    });
    return {
      id: c.id, nome: c.nome, tipo: c.tipo,
      icone: c.icone || '', saldo: saldo
    };
  });

  const saldosCartoes = cartoes.map(c => {
    let saldo = 0;
    lancs.forEach(l => {
      if (l.cartao !== c.id) return;
      if (l.data > dataAlvo) return;
      saldo += Number(l.valor) || 0;
    });
    return {
      id: c.id, nome: c.nome, bandeira: c.bandeira || '', saldo: saldo
    };
  });

  let ativos = 0, passivos = 0;
  saldosContas.forEach(s => {
    if (s.saldo > 0) ativos += s.saldo;
    else passivos += Math.abs(s.saldo);
  });
  saldosCartoes.forEach(s => {
    if (s.saldo > 0) ativos += s.saldo;
    else passivos += Math.abs(s.saldo);
  });

  return {
    data: dataAlvo,
    ativos: ativos,
    passivos: passivos,
    patrimonio_liquido: ativos - passivos,
    contas: saldosContas.sort((a, b) => b.saldo - a.saldo),
    cartoes: saldosCartoes.sort((a, b) => a.saldo - b.saldo)
  };
}
