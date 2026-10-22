/**
 * Relatorios.gs — agregações para os relatórios do app.
 * Funções top-level expostas: getTotaisPorCategoria, getTotaisPorCentro, getEvolucaoMensal.
 */

function getTotaisPorCategoria(ano, mes) {
  const lancs = listLancamentos({ ano: ano, mes: mes }).filter(l => !l.transferencia_id);
  const cats = listCategorias();
  const map = {};

  lancs.forEach(l => {
    const key = l.categoria || '_sem';
    map[key] = (map[key] || 0) + Math.abs(Number(l.valor) || 0);
  });

  return Object.keys(map).map(key => {
    const cat = cats.find(c => String(c.id) === String(key));
    return {
      id: key,
      nome: cat ? cat.nome : 'Sem categoria',
      total: map[key]
    };
  }).sort((a, b) => b.total - a.total);
}

function getTotaisPorCentro(ano, mes) {
  const lancs = listLancamentos({ ano: ano, mes: mes }).filter(l => !l.transferencia_id);
  const centros = listCentros();
  const map = {};

  lancs.forEach(l => {
    const key = l.centro || '_sem';
    map[key] = (map[key] || 0) + Math.abs(Number(l.valor) || 0);
  });

  return Object.keys(map).map(key => {
    const c = centros.find(x => String(x.id) === String(key));
    return {
      id: key,
      nome: c ? c.nome : 'Sem centro',
      cor: c && c.cor ? c.cor : null,
      total: map[key]
    };
  }).sort((a, b) => b.total - a.total);
}

/**
 * Evolução mensal de receitas/despesas nos últimos N meses (default 6).
 * Retorna: { labels: ['mai/2026',...], receitas: [...], despesas: [...] }
 */
function getEvolucaoMensal(meses) {
  meses = Math.max(2, Math.min(24, Number(meses) || 6));
  const hoje = new Date();
  const labels = [];
  const receitas = [];
  const despesas = [];
  const nomes = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];

  for (let i = meses - 1; i >= 0; i--) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    const ano = d.getFullYear();
    const mes = d.getMonth() + 1;
    labels.push(nomes[mes - 1] + '/' + String(ano).slice(2));

    const lancs = listLancamentos({ ano: ano, mes: mes }).filter(l => !l.transferencia_id);
    let r = 0, dsp = 0;
    lancs.forEach(l => {
      const v = Number(l.valor) || 0;
      if (v >= 0) r += v;
      else dsp += Math.abs(v);
    });
    receitas.push(Math.round(r * 100) / 100);
    despesas.push(Math.round(dsp * 100) / 100);
  }

  return { labels: labels, receitas: receitas, despesas: despesas };
}

/**
 * Comparação entre dois períodos (receitas, despesas, saldo).
 */
function getComparacaoPeriodos(ano1, mes1, ano2, mes2) {
  function tot(ano, mes) {
    const ls = listLancamentos({ ano: ano, mes: mes }).filter(l => !l.transferencia_id);
    let r = 0, d = 0;
    ls.forEach(l => {
      const v = Number(l.valor) || 0;
      if (v >= 0) r += v; else d += Math.abs(v);
    });
    return { receitas: r, despesas: d, saldo: r - d, quantidade: ls.length };
  }
  return {
    periodo1: Object.assign({ ano: ano1, mes: mes1 }, tot(ano1, mes1)),
    periodo2: Object.assign({ ano: ano2, mes: mes2 }, tot(ano2, mes2))
  };
}

/**
 * Evolução das top N categorias nos últimos N meses (line chart).
 */
function getEvolucaoPorCategoria(meses, topN) {
  meses = Math.max(2, Math.min(24, Number(meses) || 6));
  topN  = Math.max(1, Math.min(10, Number(topN) || 5));

  const hoje = new Date();
  const cats = listCategorias();
  const nomes = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];

  const labels = [];
  const porMes = [];
  for (let i = meses - 1; i >= 0; i--) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    const ano = d.getFullYear();
    const mes = d.getMonth() + 1;
    labels.push(nomes[mes - 1] + '/' + String(ano).slice(2));
    const ls = listLancamentos({ ano: ano, mes: mes }).filter(l => !l.transferencia_id);
    const m = {};
    ls.forEach(l => {
      const k = l.categoria || '_sem';
      m[k] = (m[k] || 0) + Math.abs(Number(l.valor) || 0);
    });
    porMes.push(m);
  }

  const totalPorCat = {};
  porMes.forEach(m => {
    Object.keys(m).forEach(k => { totalPorCat[k] = (totalPorCat[k] || 0) + m[k]; });
  });

  const top = Object.keys(totalPorCat)
    .map(k => ({ id: k, total: totalPorCat[k] }))
    .sort((a, b) => b.total - a.total)
    .slice(0, topN);

  const datasets = top.map(t => {
    const cat = cats.find(c => String(c.id) === String(t.id));
    return {
      label: cat ? cat.nome : 'Sem categoria',
      data: porMes.map(m => +(m[t.id] || 0).toFixed(2))
    };
  });

  return { labels: labels, datasets: datasets };
}

/**
 * Lançamentos a vencer (despesas pendentes/agendadas) nos próximos N dias.
 */
function getContasAPagar(dias) {
  dias = Math.max(1, Math.min(365, Number(dias) || 30));
  const hoje = Utils.today();
  const fim = new Date();
  fim.setDate(fim.getDate() + dias);
  const fimStr = Utils.formatDate(fim);

  return DB.readAll(SHEET_LANCAMENTOS).filter(l =>
    !l.transferencia_id &&
    Number(l.valor) < 0 &&
    (l.status === 'pendente' || l.status === 'agendado') &&
    l.data >= hoje && l.data <= fimStr
  ).sort((a, b) => String(a.data).localeCompare(String(b.data)));
}

/**
 * Lançamentos a receber (receitas pendentes/agendadas) nos próximos N dias.
 */
function getContasAReceber(dias) {
  dias = Math.max(1, Math.min(365, Number(dias) || 30));
  const hoje = Utils.today();
  const fim = new Date();
  fim.setDate(fim.getDate() + dias);
  const fimStr = Utils.formatDate(fim);

  return DB.readAll(SHEET_LANCAMENTOS).filter(l =>
    !l.transferencia_id &&
    Number(l.valor) > 0 &&
    (l.status === 'pendente' || l.status === 'agendado') &&
    l.data >= hoje && l.data <= fimStr
  ).sort((a, b) => String(a.data).localeCompare(String(b.data)));
}
