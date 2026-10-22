/**
 * VisaoGeral.gs — agregações da tela Visão Geral.
 *
 * Tudo numa única RPC: top categorias, comparativo mês anterior, donut, série 6m,
 * orçamentos no alerta, próximas a vencer, % economia, heatmap.
 */

function getVisaoGeralExtras(ano, mes, contasIds, cartoesIds) {
  contasIds  = (contasIds  || []).map(String);
  cartoesIds = (cartoesIds || []).map(String);
  const contasSet  = new Set(contasIds);
  const cartoesSet = new Set(cartoesIds);

  const r = Utils.monthRange(ano, mes);
  const lancsAll = DB.readAll(SHEET_LANCAMENTOS);
  const categorias = listCategorias();
  const catMap = {};
  categorias.forEach(c => { catMap[c.id] = c; });

  // Lançamentos do mês corrente nas contas/cartões selecionados (ignora transferências)
  const lancsMes = lancsAll.filter(l => {
    if (l.data < r.start || l.data > r.end) return false;
    if (l.transferencia_id) return false;
    if (l.conta  && contasSet.has(String(l.conta)))  return true;
    if (l.cartao && cartoesSet.has(String(l.cartao))) return true;
    return false;
  });

  // === 1. Top categorias de despesa + donut completo ===
  const despesasPorCat = {}; // id -> total
  let totalDespesasMes = 0;
  let totalReceitasMes = 0;
  lancsMes.forEach(l => {
    const v = Number(l.valor) || 0;
    if (v >= 0) { totalReceitasMes += v; return; }
    totalDespesasMes += Math.abs(v);
    const catId = l.categoria || '__sem_cat__';
    despesasPorCat[catId] = (despesasPorCat[catId] || 0) + Math.abs(v);
  });
  const despesasPorCatArr = Object.keys(despesasPorCat).map(id => {
    const cat = catMap[id];
    return {
      id: id,
      nome: cat ? cat.nome : (id === '__sem_cat__' ? '(Sem categoria)' : id),
      total: despesasPorCat[id],
      percent: totalDespesasMes > 0 ? (despesasPorCat[id] / totalDespesasMes) * 100 : 0
    };
  }).sort((a, b) => b.total - a.total);
  const topCategorias = despesasPorCatArr.slice(0, 3);

  // === 2. Comparativo com mês anterior ===
  const prevMes = mes === 1 ? 12 : mes - 1;
  const prevAno = mes === 1 ? ano - 1 : ano;
  const rPrev = Utils.monthRange(prevAno, prevMes);
  let recPrev = 0, desPrev = 0;
  lancsAll.forEach(l => {
    if (l.data < rPrev.start || l.data > rPrev.end) return;
    if (l.transferencia_id) return;
    const inConta  = l.conta  && contasSet.has(String(l.conta));
    const inCartao = l.cartao && cartoesSet.has(String(l.cartao));
    if (!inConta && !inCartao) return;
    const v = Number(l.valor) || 0;
    if (v >= 0) recPrev += v;
    else        desPrev += Math.abs(v);
  });
  const resAtual = totalReceitasMes - totalDespesasMes;
  const resPrev  = recPrev - desPrev;
  const pct = (atual, prev) => {
    if (prev === 0) return null; // sem base de comparação
    return ((atual - prev) / Math.abs(prev)) * 100;
  };
  const comparativo = {
    receitas: { atual: totalReceitasMes, anterior: recPrev, variacao: pct(totalReceitasMes, recPrev) },
    despesas: { atual: totalDespesasMes, anterior: desPrev, variacao: pct(totalDespesasMes, desPrev) },
    resultado:{ atual: resAtual,         anterior: resPrev, variacao: pct(resAtual, resPrev) }
  };

  // === 3. Série últimos 6 meses ===
  const serie6m = [];
  for (let i = 5; i >= 0; i--) {
    const m = mes - i;
    let mm = m, aa = ano;
    while (mm <= 0) { mm += 12; aa--; }
    const rr = Utils.monthRange(aa, mm);
    let rec = 0, des = 0;
    lancsAll.forEach(l => {
      if (l.data < rr.start || l.data > rr.end) return;
      if (l.transferencia_id) return;
      const inConta  = l.conta  && contasSet.has(String(l.conta));
      const inCartao = l.cartao && cartoesSet.has(String(l.cartao));
      if (!inConta && !inCartao) return;
      const v = Number(l.valor) || 0;
      if (v >= 0) rec += v;
      else        des += Math.abs(v);
    });
    serie6m.push({
      ano: aa,
      mes: mm,
      label: String(mm).padStart(2, '0') + '/' + String(aa).slice(2),
      receitas: rec,
      despesas: des,
      resultado: rec - des
    });
  }

  // === 4. Orçamentos no alerta ===
  let orcAlerta = { total: 0, no_limite: 0, estourados: 0 };
  try {
    const orcs = getOrcamentosProgresso(ano, mes);
    orcAlerta.total = orcs.length;
    orcs.forEach(o => {
      const orcado = Number(o.orcado) || 0;
      const consumido = Number(o.consumido) || 0;
      if (orcado <= 0) return;
      const ratio = consumido / orcado;
      if (ratio >= 1) orcAlerta.estourados++;
      else if (ratio >= 0.8) orcAlerta.no_limite++;
    });
  } catch (e) {}

  // === 5. Próximas a vencer (próximos 7 dias) ===
  const hoje = Utils.today();
  const d7 = new Date(hoje + 'T00:00:00');
  d7.setDate(d7.getDate() + 7);
  const d7Str = Utils.formatDate(d7);
  const proximas = lancsAll.filter(l => {
    if (l.data < hoje || l.data > d7Str) return false;
    if (l.transferencia_id) return false;
    if ((Number(l.valor) || 0) >= 0) return false;
    if (l.status !== 'pendente' && l.status !== 'agendado') return false;
    const inConta  = l.conta  && contasSet.has(String(l.conta));
    const inCartao = l.cartao && cartoesSet.has(String(l.cartao));
    return inConta || inCartao;
  }).sort((a, b) => String(a.data).localeCompare(String(b.data)))
    .slice(0, 8)
    .map(l => ({
      id: l.id,
      data: l.data,
      descricao: l.descricao,
      valor: Number(l.valor) || 0,
      status: l.status,
      categoria: l.categoria,
      categoria_nome: (catMap[l.categoria] && catMap[l.categoria].nome) || ''
    }));

  // === 6. % economia ===
  const economia = {
    receitas: totalReceitasMes,
    despesas: totalDespesasMes,
    resultado: resAtual,
    percent: totalReceitasMes > 0 ? (resAtual / totalReceitasMes) * 100 : null
  };

  // === 7. Heatmap calendário (gasto/dia do mês corrente) ===
  const heatmap = [];
  const ini = new Date(ano, mes - 1, 1);
  const fim = new Date(ano, mes, 0);
  let maxGasto = 0;
  const gastoPorDia = {};
  lancsMes.forEach(l => {
    const v = Number(l.valor) || 0;
    if (v >= 0) return;
    gastoPorDia[l.data] = (gastoPorDia[l.data] || 0) + Math.abs(v);
    if (gastoPorDia[l.data] > maxGasto) maxGasto = gastoPorDia[l.data];
  });
  const cur = new Date(ini);
  while (cur <= fim) {
    const d = Utils.formatDate(cur);
    const gasto = gastoPorDia[d] || 0;
    heatmap.push({
      data: d,
      dia: cur.getDate(),
      dia_semana: cur.getDay(), // 0=domingo
      gasto: gasto,
      intensidade: maxGasto > 0 ? gasto / maxGasto : 0
    });
    cur.setDate(cur.getDate() + 1);
  }

  return {
    top_categorias: topCategorias,
    despesas_por_categoria: despesasPorCatArr, // pra donut
    comparativo: comparativo,
    serie_6m: serie6m,
    orcamentos_alerta: orcAlerta,
    proximas_vencer: proximas,
    economia: economia,
    heatmap: heatmap,
    total_despesas_mes: totalDespesasMes,
    total_receitas_mes: totalReceitasMes
  };
}

/**
 * Agregações ANUAIS para a aba Anual da Visão Geral.
 * Retorna totais, comparativo com ano anterior, média mensal, top categorias
 * e heatmap 365 dias.
 */
function getVisaoGeralAnualExtras(ano, contasIds, cartoesIds) {
  contasIds  = (contasIds  || []).map(String);
  cartoesIds = (cartoesIds || []).map(String);
  const contasSet  = new Set(contasIds);
  const cartoesSet = new Set(cartoesIds);

  const inicio = ano + '-01-01';
  const fim    = ano + '-12-31';
  const lancsAll = DB.readAll(SHEET_LANCAMENTOS);
  const categorias = listCategorias();
  const catMap = {};
  categorias.forEach(c => { catMap[c.id] = c; });

  function filtrarPorRange_(ini, end) {
    return lancsAll.filter(l => {
      if (l.data < ini || l.data > end) return false;
      if (l.transferencia_id) return false;
      if (l.conta  && contasSet.has(String(l.conta)))   return true;
      if (l.cartao && cartoesSet.has(String(l.cartao))) return true;
      return false;
    });
  }

  const lancsAno = filtrarPorRange_(inicio, fim);

  // === Totais do ano ===
  let receitas = 0, despesas = 0;
  const despesasPorCat = {};
  const mesesComLanc = new Set();
  const gastoPorDia = {};
  let maxGasto = 0;

  lancsAno.forEach(l => {
    const v = Number(l.valor) || 0;
    mesesComLanc.add(String(l.data).slice(0, 7));
    if (v >= 0) {
      receitas += v;
    } else {
      const abs = Math.abs(v);
      despesas += abs;
      const catId = l.categoria || '__sem_cat__';
      despesasPorCat[catId] = (despesasPorCat[catId] || 0) + abs;
      gastoPorDia[l.data] = (gastoPorDia[l.data] || 0) + abs;
      if (gastoPorDia[l.data] > maxGasto) maxGasto = gastoPorDia[l.data];
    }
  });
  const resultado = receitas - despesas;

  // === Ano anterior pra comparativo ===
  const anoPrev = Number(ano) - 1;
  const lancsAnoPrev = filtrarPorRange_(anoPrev + '-01-01', anoPrev + '-12-31');
  let recPrev = 0, desPrev = 0;
  lancsAnoPrev.forEach(l => {
    const v = Number(l.valor) || 0;
    if (v >= 0) recPrev += v;
    else        desPrev += Math.abs(v);
  });
  const resPrev = recPrev - desPrev;
  const pct = (a, b) => b === 0 ? null : ((a - b) / Math.abs(b)) * 100;

  // === Top categorias ===
  const topCats = Object.keys(despesasPorCat).map(id => {
    const cat = catMap[id];
    return {
      id: id,
      nome: cat ? cat.nome : (id === '__sem_cat__' ? '(Sem categoria)' : id),
      total: despesasPorCat[id],
      percent: despesas > 0 ? (despesasPorCat[id] / despesas) * 100 : 0
    };
  }).sort((a, b) => b.total - a.total).slice(0, 10);

  // === Média mensal (considera só meses com movimento) ===
  const nMeses = Math.max(1, mesesComLanc.size);

  // === Heatmap 365 dias ===
  const heatmap = [];
  const ini = new Date(Number(ano), 0, 1);
  const end = new Date(Number(ano), 11, 31);
  const cur = new Date(ini);
  while (cur <= end) {
    const d = Utils.formatDate(cur);
    const gasto = gastoPorDia[d] || 0;
    heatmap.push({
      data: d,
      dia: cur.getDate(),
      mes: cur.getMonth(),
      dia_semana: cur.getDay(),
      gasto: gasto,
      intensidade: maxGasto > 0 ? gasto / maxGasto : 0
    });
    cur.setDate(cur.getDate() + 1);
  }

  return {
    ano: Number(ano),
    totais: {
      receitas: receitas,
      despesas: despesas,
      resultado: resultado,
      percent: receitas > 0 ? (resultado / receitas) * 100 : null
    },
    media_mensal: {
      receitas:  receitas  / nMeses,
      despesas:  despesas  / nMeses,
      resultado: resultado / nMeses,
      n_meses: nMeses
    },
    comparativo: {
      receitas:  { atual: receitas,  anterior: recPrev, variacao: pct(receitas, recPrev) },
      despesas:  { atual: despesas,  anterior: desPrev, variacao: pct(despesas, desPrev) },
      resultado: { atual: resultado, anterior: resPrev, variacao: pct(resultado, resPrev) }
    },
    top_categorias: topCats,
    heatmap: heatmap,
    max_gasto_dia: maxGasto
  };
}
