/**
 * Cartoes.gs — CRUD de cartões + cálculo de fatura/ciclo + pagamento.
 *
 * Modelo:
 *  - Lançamento NO cartão tem `cartao` preenchido e `conta` vazia.
 *  - Pagamento da fatura é um lançamento normal na conta de pagamento, com `cartao` vazio.
 *  - Fatura de um cartão para (ano, mes) = lançamentos cuja data está no ciclo:
 *      início = (mes anterior, dia_fechamento + 1)
 *      fim    = (mes,           dia_fechamento)
 */
const SHEET_CARTOES = 'Cartoes';

function listCartoes() {
  return DB.readAll(SHEET_CARTOES);
}

function saveCartao(data) {
  const record = normalizeCartao_(data);
  if (data && data.id) return DB.update(SHEET_CARTOES, data.id, record);
  return DB.insert(SHEET_CARTOES, record);
}

function deleteCartao(id) {
  return DB.remove(SHEET_CARTOES, id);
}

function normalizeCartao_(data) {
  data = data || {};
  const fech = Math.max(1, Math.min(31, Number(data.dia_fechamento) || 1));
  const venc = Math.max(1, Math.min(31, Number(data.dia_vencimento) || fech));
  return {
    nome: String(data.nome || '').trim(),
    conta_pagamento: data.conta_pagamento || '',
    dia_fechamento: fech,
    dia_vencimento: venc,
    limite: Utils.toNumber(data.limite),
    bandeira: data.bandeira || '',
    icone: data.icone || 'credit_card',
    icone_url: data.icone_url || '',
    ativo: data.ativo === undefined ? true : Utils.toBool(data.ativo)
  };
}

/* ============================================================================
 * Cálculo de fatura.
 * ========================================================================== */

/**
 * Calcula o ciclo da fatura que VENCE em (ano, mes).
 *
 * Regra:
 *   - vencimento = dia_vencimento de (ano, mes)
 *   - fechamento = último dia_fechamento ANTES do vencimento
 *       · se dia_fechamento >= dia_vencimento → fechou no mês anterior
 *       · se dia_fechamento <  dia_vencimento → fechou no mesmo mês do vencimento
 *   - início = dia seguinte ao fechamento ANTERIOR (recua mais um mês de fechamento)
 *
 * Exemplo (fech 25, venc 10): fatura que vence 10/jun → ciclo 26/abr a 25/mai.
 */
function getFaturaCiclo_(cartao, ano, mes) {
  const diaFech = Math.max(1, Math.min(31, Number(cartao.dia_fechamento) || 1));
  const diaVenc = Math.max(1, Math.min(31, Number(cartao.dia_vencimento) || diaFech));

  function safeDate(y, m1, d) {
    const last = new Date(y, m1, 0).getDate();
    return new Date(y, m1 - 1, Math.min(d, last));
  }
  function recuaMes(y, m) {
    m -= 1;
    if (m <= 0) { m += 12; y -= 1; }
    return { ano: y, mes: m };
  }

  // Vencimento da fatura no mês de referência
  const venc = safeDate(ano, mes, diaVenc);

  // Fechamento: anterior ao vencimento
  let mesFech = mes, anoFech = ano;
  if (diaFech >= diaVenc) {
    const p = recuaMes(ano, mes);
    anoFech = p.ano; mesFech = p.mes;
  }
  const fim = safeDate(anoFech, mesFech, diaFech);

  // Início: dia seguinte ao fechamento anterior
  const pIni = recuaMes(anoFech, mesFech);
  const fechAnterior = safeDate(pIni.ano, pIni.mes, diaFech);
  const ini = new Date(fechAnterior.getFullYear(), fechAnterior.getMonth(), fechAnterior.getDate() + 1);

  return {
    inicio: Utils.formatDate(ini),
    fim: Utils.formatDate(fim),
    vencimento: Utils.formatDate(venc)
  };
}

/**
 * Mês de vencimento (YYYY-MM) da fatura que contém uma compra na data informada.
 * Fórmula direta, coerente com getFaturaCiclo_:
 *   - fatura fecha no primeiro dia de fechamento >= data
 *   - se dia_fechamento >= dia_vencimento, o vencimento é no mês seguinte ao fechamento
 */
function competenciaFaturaPorData_(cartao, dataStr) {
  const F = Math.max(1, Math.min(31, Number(cartao.dia_fechamento) || 1));
  const V = Math.max(1, Math.min(31, Number(cartao.dia_vencimento) || F));
  const s = String(dataStr || '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  let ano = Number(m[1]), mes = Number(m[2]); const dia = Number(m[3]);

  // Mês de fechamento da fatura
  let fechAno = ano, fechMes = mes;
  if (dia > F) { fechMes++; if (fechMes > 12) { fechMes = 1; fechAno++; } }

  // Mês de vencimento
  let vAno = fechAno, vMes = fechMes;
  if (F >= V) { vMes++; if (vMes > 12) { vMes = 1; vAno++; } }

  return vAno + '-' + String(vMes).padStart(2, '0');
}

/** Competência (YYYY-MM do vencimento) de um lançamento: manual se definida, senão por data. */
function faturaCompetenciaDe_(lanc, cartao) {
  if (lanc.fatura_competencia) return String(lanc.fatura_competencia).slice(0, 7);
  return competenciaFaturaPorData_(cartao, lanc.data);
}

/** Exposto pro frontend pré-preencher o campo "Fatura" ao escolher cartão/data. */
function sugerirFaturaCompetencia(cartaoId, dataStr) {
  const cartao = DB.findById(SHEET_CARTOES, cartaoId);
  if (!cartao) return '';
  return competenciaFaturaPorData_(cartao, dataStr);
}

/** Soma/subtrai N meses a um "YYYY-MM". */
function _addMesesYYYYMM_(yymm, delta) {
  const m = String(yymm || '').match(/^(\d{4})-(\d{2})/);
  if (!m) return yymm;
  let ano = Number(m[1]), mes = Number(m[2]) + Number(delta);
  while (mes > 12) { mes -= 12; ano++; }
  while (mes < 1)  { mes += 12; ano--; }
  return ano + '-' + String(mes).padStart(2, '0');
}

/**
 * Move um lançamento de cartão pra fatura anterior (-1) ou próxima (+1),
 * gravando a competência manual. Retorna a nova competência (YYYY-MM).
 */
function moverFaturaCompetencia(lancId, delta) {
  const lanc = DB.findById(SHEET_LANCAMENTOS, lancId);
  if (!lanc) throw new Error('Lançamento não encontrado.');
  if (!lanc.cartao) throw new Error('Só lançamentos de cartão têm fatura.');
  const cartao = DB.findById(SHEET_CARTOES, lanc.cartao);
  if (!cartao) throw new Error('Cartão não encontrado.');

  const atual = faturaCompetenciaDe_(lanc, cartao);
  const nova = _addMesesYYYYMM_(atual, delta);
  DB.update(SHEET_LANCAMENTOS, lancId, { fatura_competencia: nova });
  return { ok: true, competencia: nova };
}

/** Define a competência exata de um lançamento de cartão (YYYY-MM). */
function setFaturaCompetencia(lancId, yymm) {
  const lanc = DB.findById(SHEET_LANCAMENTOS, lancId);
  if (!lanc) throw new Error('Lançamento não encontrado.');
  const v = String(yymm || '').slice(0, 7);
  DB.update(SHEET_LANCAMENTOS, lancId, { fatura_competencia: v });
  return { ok: true, competencia: v };
}

function getFatura(cartaoId, ano, mes) {
  const cartao = DB.findById(SHEET_CARTOES, cartaoId);
  if (!cartao) throw new Error('Cartão não encontrado');

  const ciclo = getFaturaCiclo_(cartao, ano, mes);
  const yymm = ano + '-' + String(mes).padStart(2, '0');
  const todos = DB.readAll(SHEET_LANCAMENTOS).filter(l => l.cartao === cartaoId);

  // Compras da fatura: filtra por COMPETÊNCIA (vencimento). Exclui pagamentos (transferência).
  const lancs = todos
    .filter(l => !l.transferencia_id && faturaCompetenciaDe_(l, cartao) === yymm)
    .sort((a, b) => String(a.data).localeCompare(String(b.data)));

  const total = lancs.reduce((s, l) => s + (Number(l.valor) || 0), 0);

  // Detecta pagamento: perna de crédito (transferência, valor > 0) marcada com esta
  // competência OU lançada no mês de vencimento.
  let totalPago = 0;
  todos.forEach(l => {
    if (!l.transferencia_id) return;
    const v = Number(l.valor) || 0;
    if (v <= 0) return;
    const comp = l.fatura_competencia ? String(l.fatura_competencia).slice(0, 7) : '';
    if (comp === yymm || (!comp && String(l.data).slice(0, 7) === yymm)) totalPago += v;
  });

  // Status: paga (tem pagamento) | fechada (passou do fechamento, sem pagar) | aberta
  const hoje = Utils.today();
  let status = 'aberta';
  if (totalPago > 0.01) status = 'paga';
  else if (hoje > ciclo.fim) status = 'fechada';

  return {
    cartao: cartao,
    ciclo: ciclo,
    competencia: yymm,
    lancamentos: lancs,
    total: total,
    total_pago: totalPago,
    status: status
  };
}

/**
 * Calcula uso (somatório de lançamentos no ciclo atual) e disponível.
 */
/**
 * Saldo agregado de TODOS os cartões (devedor — geralmente negativo).
 * Análogo a getSaldosContas, pra usar na sidebar de Movimentações.
 */
/**
 * Saldos dos cartões. Quando ano/mes são passados:
 *  - `fatura_mes`  = total do ciclo da fatura que vence em ano/mes (gastos − pagamentos do ciclo)
 *  - `saldo_devedor` = saldo devedor total acumulado (todos os lançamentos do cartão)
 *  - `confirmado`/`projetado` mantidos pra retrocompat (e pra somar em totais_passivos)
 *
 * `ate` (string ISO) também aceito como compat — limita o "projetado" até essa data.
 */
function getSaldosCartoes(ano, mes) {
  // Compat: se chamado com string única (ate), interpreta como data limite
  let limite = null;
  if (typeof ano === 'string' && !mes) { limite = ano; ano = null; }
  if (ano && mes) limite = Utils.formatDate(new Date(ano, mes, 0)); // fim do mês

  const cartoes = listCartoes().filter(c =>
    Utils.toBool(c.ativo) || c.ativo === '' || c.ativo === undefined
  );
  const lancs = DB.readAll(SHEET_LANCAMENTOS);

  const yymm = (ano && mes) ? (ano + '-' + String(mes).padStart(2, '0')) : null;

  return cartoes.map(c => {
    let confirmado = 0, projetado = 0;
    let faturaMes = 0, saldoDevedor = 0;

    lancs.forEach(l => {
      if (l.cartao !== c.id) return;
      const v = Number(l.valor) || 0;
      saldoDevedor += v;
      if (!limite || l.data <= limite) projetado += v;
      if (Utils.statusRealizado(l.status)) confirmado += v;
      // Fatura do mês = COMPRAS (exclui pagamentos/transferência) cuja competência é ano/mes
      if (yymm && !l.transferencia_id && faturaCompetenciaDe_(l, c) === yymm) faturaMes += v;
    });

    return {
      id: c.id,
      nome: c.nome,
      tipo: 'cartao',
      bandeira: c.bandeira || '',
      icone: c.icone || 'credit_card',
      icone_url: c.icone_url || '',
      limite: Number(c.limite) || 0,
      confirmado: confirmado,
      projetado: projetado,
      fatura_mes: faturaMes,
      saldo_devedor: saldoDevedor,
      _isCartao: true
    };
  });
}

function getCartaoResumo(cartaoId) {
  const cartao = DB.findById(SHEET_CARTOES, cartaoId);
  if (!cartao) throw new Error('Cartão não encontrado');
  const lancs = DB.readAll(SHEET_LANCAMENTOS).filter(l => l.cartao === cartaoId);
  // saldo = soma sinalizada (compras negativas + pagamentos positivos).
  // utilizado = max(0, -saldo) — pagamentos liberam limite.
  const saldo = lancs.reduce((s, l) => s + (Number(l.valor) || 0), 0);
  const utilizado = Math.max(0, -saldo);
  const limite = Number(cartao.limite) || 0;
  return {
    limite: limite,
    utilizado: utilizado,
    disponivel: Math.max(0, limite - utilizado)
  };
}

/**
 * Painel de resumo do cartão para o topo da aba Cartões.
 * @param {string} cartaoId
 * @param {number} ano, mes - fatura "central" (a que está sendo vista). Default = mês atual.
 * @param {number} atras, frente - quantas faturas pra trás/frente incluir na série.
 * Retorna: resumo (limite/devedor/disponível), fatura central, comprometido futuro e a série pro gráfico.
 */
function getCartaoPainel(cartaoId, ano, mes, atras, frente) {
  const cartao = DB.findById(SHEET_CARTOES, cartaoId);
  if (!cartao) throw new Error('Cartão não encontrado');
  atras  = (atras  === undefined) ? 3 : Number(atras);
  frente = (frente === undefined) ? 6 : Number(frente);
  if (!ano || !mes) { const h = new Date(); ano = h.getFullYear(); mes = h.getMonth() + 1; }

  const todos = DB.readAll(SHEET_LANCAMENTOS).filter(l => l.cartao === cartaoId);

  // Saldo devedor total e limite
  const saldo = todos.reduce((s, l) => s + (Number(l.valor) || 0), 0);
  const utilizado = Math.max(0, -saldo);
  const limite = Number(cartao.limite) || 0;
  const yymmCentral = ano + '-' + String(mes).padStart(2, '0');
  const hoje = Utils.today();

  // Série de faturas (atras → frente)
  const serie = [];
  let comprometidoFuturo = 0;
  let faturaCentral = null;
  for (let off = -atras; off <= frente; off++) {
    let m = mes + off, a = ano;
    while (m > 12) { m -= 12; a++; }
    while (m < 1)  { m += 12; a--; }
    const yymm = a + '-' + String(m).padStart(2, '0');

    let total = 0, qtd = 0, pago = 0;
    todos.forEach(l => {
      const comp = faturaCompetenciaDe_(l, cartao);
      if (comp !== yymm) return;
      const v = Number(l.valor) || 0;
      if (l.transferencia_id) { if (v > 0) pago += v; return; } // pagamento/crédito
      total += v;
      qtd++;
    });

    let ciclo = null;
    try { ciclo = getFaturaCiclo_(cartao, a, m); } catch (e) {}
    const venc = ciclo ? ciclo.vencimento : (yymm + '-01');
    let status = 'aberta';
    if (pago > 0.01) status = 'paga';
    else if (ciclo && hoje > ciclo.fim) status = 'fechada';

    const item = {
      ano: a, mes: m, competencia: yymm,
      vencimento: venc,
      total: Math.abs(total),
      qtd: qtd,
      status: status,
      central: yymm === yymmCentral
    };
    serie.push(item);
    if (off > 0) comprometidoFuturo += Math.abs(total);
    if (item.central) faturaCentral = item;
  }

  return {
    limite: limite,
    utilizado: utilizado,
    disponivel: Math.max(0, limite - utilizado),
    saldo_devedor: saldo,
    comprometido_futuro: comprometidoFuturo,
    fatura_central: faturaCentral,
    serie: serie
  };
}

/**
 * Paga a fatura: cria DUAS pernas linkadas por transferencia_id.
 *   - Saída na conta de pagamento (despesa real, valor negativo).
 *   - Entrada no cartão (positiva, reduz saldo devedor).
 * Lançamentos originais (compras) permanecem no histórico do cartão.
 */
function pagarFatura(cartaoId, ano, mes, dataPagamento, status, contaPagamentoOverride) {
  const fatura = getFatura(cartaoId, ano, mes);
  if (Math.abs(fatura.total) < 0.01) throw new Error('Fatura sem valor para pagar.');

  const cartao = fatura.cartao;
  const contaDebito = String(contaPagamentoOverride || cartao.conta_pagamento || '').trim();
  if (!contaDebito) throw new Error('Selecione a conta a debitar (ou configure conta_pagamento no cartão).');

  const meses = ['janeiro','fevereiro','março','abril','maio','junho',
                 'julho','agosto','setembro','outubro','novembro','dezembro'];
  const desc = 'Pagamento fatura ' + cartao.nome + ' — ' + meses[mes - 1] + '/' + ano;
  const dataPgto = dataPagamento || fatura.ciclo.vencimento;
  const st = status || 'pendente';
  const tid = Utils.uuid();

  // Perna 1: saída na conta debitada (fatura.total é negativo)
  saveLancamento({
    data: dataPgto,
    descricao: desc,
    valor: fatura.total,
    conta: contaDebito,
    status: st,
    transferencia_id: tid
  });

  // Perna 2: entrada no cartão (positiva). Marca a competência da fatura paga
  // pra detecção exata do status "paga" (mesmo se a data do pagamento for de outro mês).
  saveLancamento({
    data: dataPgto,
    descricao: desc + ' (crédito no cartão)',
    valor: -fatura.total,
    cartao: cartao.id,
    status: st,
    transferencia_id: tid,
    fatura_competencia: ano + '-' + String(mes).padStart(2, '0')
  });

  return { transferencia_id: tid, total_pago: Math.abs(fatura.total), conta_debitada: contaDebito };
}
