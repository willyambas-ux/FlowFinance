/**
 * Grande2.js — tela grande, etapa 2: Cartões e faturas, Relatórios e Planejamento
 * (próximos meses, provisão de gastos anuais, metas e orçamentos).
 */

/* ============================================================================
 * Cartões e faturas
 * ========================================================================== */

/** Fatura de um cartão (padrão: o primeiro, na fatura aberta hoje). */
function appCartoes(cartaoId, ano, mes) {
  const cartoes = appCartoesAtivos_();
  if (!cartoes.length) return { cartoes: [], cartao: null };
  const cartao = cartoes.find(c => String(c.id) === String(cartaoId)) || cartoes[0];
  const hoje = Utils.today();
  if (!ano || !mes) {
    const comp = sugerirFaturaCompetencia(cartao.id, hoje);
    ano = Number(comp.slice(0, 4)); mes = Number(comp.slice(5, 7));
  }
  ano = Number(ano); mes = Number(mes);
  DB.readAllFresh(SHEET_LANCAMENTOS);

  const f = getFatura(cartao.id, ano, mes);
  const resumo = getCartaoResumo(cartao.id);
  const painel = getCartaoPainel(cartao.id, ano, mes, 3, 3);
  const cats = gCategorias_();

  // Por categoria-pai nesta fatura (parcelas à parte)
  const porCat = {};
  let parcelas = 0;
  f.lancamentos.forEach(l => {
    const v = -(Number(l.valor) || 0);
    if (Number(l.parcela_total) > 1) { parcelas += v; return; }
    const p = cats.pai(l.categoria);
    const k = p ? p.nome : 'Sem categoria';
    porCat[k] = (porCat[k] || 0) + v;
  });
  const categorias = Object.keys(porCat).map(k => ({ nome: k, total: appArred_(porCat[k]) }));
  if (parcelas > 0.01) categorias.push({ nome: 'Parcelas', total: appArred_(parcelas) });
  categorias.sort((a, b) => b.total - a.total);

  // Média das 3 faturas anteriores e a categoria que mais subiu
  const anteriores = painel.serie.filter(s => s.competencia < f.competencia).slice(-3).filter(s => s.total > 0.01);
  const media = anteriores.length ? anteriores.reduce((t, s) => t + s.total, 0) / anteriores.length : 0;
  let maiorAlta = null;
  if (anteriores.length) {
    const ant = {};
    anteriores.forEach(s => {
      getFatura(cartao.id, s.ano, s.mes).lancamentos.forEach(l => {
        if (Number(l.parcela_total) > 1) return;
        const p = cats.pai(l.categoria);
        const k = p ? p.nome : 'Sem categoria';
        ant[k] = (ant[k] || 0) - (Number(l.valor) || 0) / anteriores.length;
      });
    });
    Object.keys(porCat).forEach(k => {
      const dif = porCat[k] - (ant[k] || 0);
      if (dif > 30 && (!maiorAlta || dif > maiorAlta.dif)) maiorAlta = { nome: k, dif: appArred_(dif) };
    });
  }

  const contaPg = cartao.conta_pagamento ? listContas().find(c => String(c.id) === String(cartao.conta_pagamento)) : null;
  const total = Math.max(0, -f.total);
  return {
    hoje: hoje,
    cartoes: cartoes.map(c => ({ id: String(c.id), nome: String(c.nome) })),
    cartao: {
      id: String(cartao.id), nome: String(cartao.nome),
      dia_fechamento: Number(cartao.dia_fechamento) || 0, dia_vencimento: Number(cartao.dia_vencimento) || 0,
      conta_pagamento: String(cartao.conta_pagamento || ''), conta_nome: contaPg ? String(contaPg.nome) : ''
    },
    fatura: {
      ano: ano, mes: mes, competencia: f.competencia, total: appArred_(total),
      pago: appArred_(f.total_pago), restante: appArred_(f.restante), status: f.status,
      inicio: f.ciclo.inicio, fechamento: f.ciclo.fim, vencimento: f.ciclo.vencimento,
      compras: f.lancamentos.slice().sort((a, b) => String(b.data).localeCompare(String(a.data))).map(appItem_),
      categorias: categorias
    },
    limite: { total: appArred_(resumo.limite), usado: appArred_(resumo.utilizado), livre: appArred_(resumo.disponivel) },
    futuro: appArred_(painel.comprometido_futuro),
    serie: painel.serie.map(s => ({ ano: s.ano, mes: s.mes, competencia: s.competencia, total: appArred_(s.total), status: s.status, central: s.central })),
    media: appArred_(media),
    variacao: media > 0 ? Math.round((total - media) / media * 100) : null,
    maior_alta: maiorAlta
  };
}

/** Paga a fatura (inteira ou parte) com transferência da conta para o cartão. */
function appPagarFatura(cartaoId, ano, mes, valor, data, contaId) {
  const v = Math.abs(Utils.toNumber(valor));
  if (!(v > 0)) throw new Error('Informe o valor do pagamento.');
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(data || '')) ? String(data) : Utils.today();
  const status = d > Utils.today() ? 'agendado' : 'confirmado';
  const r = pagarFatura(cartaoId, Number(ano), Number(mes), d, status, contaId || '', v);
  return { ok: true, total_pago: r.total_pago, conta: r.conta_debitada };
}

function appMoverFatura(lancId, delta) {
  return moverFaturaCompetencia(lancId, Number(delta) || 1);
}

/* ============================================================================
 * Relatórios
 * ========================================================================== */

/** periodo: 6 | 12 (meses até o atual) ou um ano ('2026'). */
function appRelatorios(periodo) {
  const hoje = Utils.today();
  const ha = Number(hoje.slice(0, 4)), hm = Number(hoje.slice(5, 7));
  let meses = [];
  const p = String(periodo || '12');
  if (/^\d{4}$/.test(p)) {
    for (let m = 1; m <= 12; m++) meses.push({ ano: Number(p), mes: m });
    if (Number(p) === ha) meses = meses.filter(x => x.mes <= hm);
  } else {
    const n = p === '6' ? 6 : 12;
    for (let i = n - 1; i >= 0; i--) meses.push(gMesMais_(ha, hm, -i));
  }
  const lancs = DB.readAllFresh(SHEET_LANCAMENTOS);
  const cats = gCategorias_();
  const ROT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

  const ag = meses.map(m => Object.assign({ ano: m.ano, mes: m.mes, rotulo: ROT[m.mes - 1] + (meses.length > 12 || m.ano !== ha ? '/' + String(m.ano).slice(2) : '') }, gAgregar_(lancs, m.ano, m.mes, cats)));
  const comDados = ag.filter(a => a.quantidade > 0);
  const n = comDados.length || 1;
  const soma = (k) => comDados.reduce((t, a) => t + a[k], 0);

  // Mesmo período logo antes, para comparar
  const antes = meses.map(m => gMesMais_(m.ano, m.mes, -meses.length)).map(m => gAgregar_(lancs, m.ano, m.mes, cats)).filter(a => a.quantidade > 0);
  const mediaAntes = (k) => antes.length ? antes.reduce((t, a) => t + a[k], 0) / antes.length : 0;
  const varPct = (atual, ant) => ant > 0 ? Math.round((atual - ant) / ant * 100) : null;

  const rendaMedia = soma('receitas') / n, gastoMedio = soma('despesas') / n;
  const guardado = soma('receitas') - soma('despesas');
  const negativos = comDados.filter(a => a.receitas - a.despesas < 0);

  const serie = ag.map(a => ({
    rotulo: a.rotulo, receitas: appArred_(a.receitas), despesas: appArred_(a.despesas),
    sobra_pct: a.receitas > 0 ? Math.round((a.receitas - a.despesas) / a.receitas * 100) : null, vazio: a.quantidade === 0
  }));

  // Categorias-pai mês a mês (as 10 maiores)
  const totCat = {};
  ag.forEach(a => Object.keys(a.porCat).forEach(k => { totCat[k] = (totCat[k] || 0) + a.porCat[k]; }));
  const topo = Object.keys(totCat).sort((x, y) => totCat[y] - totCat[x]).slice(0, 10);
  const matriz = topo.map(k => {
    const valores = ag.map(a => appArred_(a.porCat[k] || 0));
    const media = totCat[k] / n;
    return { id: k, nome: k ? (cats.porId[k] ? cats.porId[k].nome : '—') : 'Sem categoria', valores: valores, media: appArred_(media) };
  });

  // O que chamou atenção (só meses fechados: o mês atual ainda está pela metade)
  const insights = [];
  const fechado = (i) => ag[i].quantidade > 0 && !(ag[i].ano === ha && ag[i].mes === hm);
  matriz.forEach(c => {
    const v = c.valores.filter((x, i) => fechado(i));
    const u = v.slice(-3);
    if (u.length === 3 && u[0] < u[1] && u[1] < u[2] && u[2] > c.media * 1.1) {
      insights.push({ tom: 'alerta', texto: c.nome + ' subiu 3 meses seguidos e está ' + Math.round((u[2] - c.media) / c.media * 100) + '% acima da média do período.' });
    }
  });
  if (negativos.length) {
    insights.push({ tom: 'alerta', texto: (negativos.length === 1 ? 'Um mês fechou' : negativos.length + ' meses fecharam') + ' no negativo: ' +
      negativos.map(a => a.rotulo).join(', ') + '. Se foram gastos que se repetem todo ano, a provisão em Planejamento evita isso.' });
  }
  matriz.forEach(c => {
    const v = c.valores.filter((x, i) => fechado(i));
    if (v.length < 3) return;
    const ult = v[v.length - 1];
    const anteriores = v.slice(0, -1);
    // Mediana: um gasto isolado (ex.: IPVA) não distorce a comparação
    const ord = anteriores.slice().sort((x, y) => x - y);
    const med = ord.length % 2 ? ord[(ord.length - 1) / 2] : (ord[ord.length / 2 - 1] + ord[ord.length / 2]) / 2;
    if (med > 100 && ult < med * 0.8) {
      insights.push({ tom: 'bom', texto: c.nome + ' caiu ' + Math.round((med - ult) / med * 100) + '% no último mês fechado em relação ao normal dos meses anteriores.' });
    }
  });
  try {
    const estouros = {};
    meses.slice(-6).forEach(m => {
      getOrcamentosProgresso(m.ano, m.mes).forEach(o => { if (o.percentual > 100) estouros[o.nome] = (estouros[o.nome] || 0) + 1; });
    });
    Object.keys(estouros).filter(k => estouros[k] >= 3).forEach(k => {
      insights.push({ tom: 'neutro', texto: k + ' passou do orçamento em ' + estouros[k] + ' dos últimos ' + Math.min(6, meses.length) + ' meses: vale rever o limite ou o hábito.' });
    });
  } catch (e) { /* sem orçamentos */ }
  if (!insights.length) insights.push({ tom: 'neutro', texto: 'Nada fora do comum no período.' });

  // Por pessoa (média por mês)
  const quem = {};
  ag.forEach(a => Object.keys(a.porQuem).forEach(k => { quem[k] = (quem[k] || 0) + a.porQuem[k]; }));
  const pessoas = Object.keys(quem).map(k => ({ nome: k || 'Sem nome', media: appArred_(quem[k] / n), sem_nome: !k }))
    .sort((a, b) => (a.sem_nome - b.sem_nome) || (b.media - a.media));

  return {
    periodo: p,
    anos: gAnosComDados_(lancs),
    kpis: {
      renda_media: appArred_(rendaMedia), renda_var: varPct(rendaMedia, mediaAntes('receitas')),
      gasto_medio: appArred_(gastoMedio), gasto_var: varPct(gastoMedio, mediaAntes('despesas')),
      guardado: appArred_(guardado), guardado_pct: soma('receitas') > 0 ? Math.round(guardado / soma('receitas') * 100) : null,
      meta_poupanca: gMetaPoupanca_(),
      meses_positivos: comDados.length - negativos.length, meses_total: comDados.length,
      negativos: negativos.map(a => a.rotulo)
    },
    serie: serie,
    meses: ag.map(a => a.rotulo),
    matriz: matriz,
    insights: insights.slice(0, 6),
    pessoas: pessoas
  };
}

function gAnosComDados_(lancs) {
  const anos = {};
  lancs.forEach(l => { const a = String(l.data || '').slice(0, 4); if (/^\d{4}$/.test(a)) anos[a] = true; });
  const hoje = Utils.today().slice(0, 4);
  return Object.keys(anos).filter(a => a <= hoje).sort().reverse().slice(0, 4);
}

/* ============================================================================
 * Planejamento
 * ========================================================================== */

function appPlanejamento() {
  const hoje = Utils.today();
  const ha = Number(hoje.slice(0, 4)), hm = Number(hoje.slice(5, 7));
  const lancs = DB.readAllFresh(SHEET_LANCAMENTOS);
  const cats = gCategorias_();
  const ROT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

  // Base: média dos 3 meses fechados anteriores
  const base = [1, 2, 3].map(i => { const m = gMesMais_(ha, hm, -i); return gAgregar_(lancs, m.ano, m.mes, cats); }).filter(a => a.quantidade > 0);
  const nb = base.length || 1;
  const media = k => base.reduce((t, a) => t + a[k], 0) / nb;
  const parcelasMes = (ano, mes) => {
    const r = Utils.monthRange(ano, mes);
    return lancs.filter(l => l.data >= r.start && l.data <= r.end && Number(l.parcela_total) > 1 && (Number(l.valor) || 0) < 0 && !l.transferencia_id)
      .reduce((t, l) => t - Number(l.valor), 0);
  };
  const mediaParcelas = base.length ? [1, 2, 3].map(i => { const m = gMesMais_(ha, hm, -i); return parcelasMes(m.ano, m.mes); }).reduce((t, v) => t + v, 0) / nb : 0;
  const rendaMedia = media('receitas'), fixasMedia = media('fixas');
  const variaveisMedia = Math.max(0, media('despesas') - fixasMedia - mediaParcelas);

  const provisoes = gProvisoes_();
  const temFixas = cats.lista.some(c => c.natureza === 'fixa');

  // Próximos 6 meses
  const proximos = [];
  for (let i = 1; i <= 6; i++) {
    const m = gMesMais_(ha, hm, i);
    const ag = gAgregar_(lancs, m.ano, m.mes, cats);
    const renda = Math.max(ag.receitas, rendaMedia);
    const fixas = Math.max(ag.fixas, fixasMedia);
    const parcelas = parcelasMes(m.ano, m.mes);
    const anuais = provisoes.filter(p => p.mes_vencimento === m.mes).reduce((t, p) => t + p.valor, 0);
    const sobra = renda - fixas - parcelas - anuais - variaveisMedia;
    proximos.push({
      ano: m.ano, mes: m.mes, rotulo: ROT[m.mes - 1] + (m.ano !== ha ? '/' + String(m.ano).slice(2) : ''),
      renda: appArred_(renda), fixas: appArred_(fixas), parcelas: appArred_(parcelas), anuais: appArred_(anuais),
      variaveis: appArred_(variaveisMedia), sobra: appArred_(sobra)
    });
  }
  let alerta = '';
  const primeiroNeg = proximos.find(p => p.sobra < 0);
  if (primeiroNeg) {
    const porMes = provisoes.reduce((t, p) => t + p.por_mes, 0);
    const motivo = primeiroNeg.anuais > 0 ? ' por causa dos gastos anuais' : '';
    alerta = maiusc_(primeiroNeg.rotulo) + ' deve fechar no negativo (' + appBRL_(primeiroNeg.sobra) + ')' + motivo + '.' +
      (porMes > 0 ? ' Guardar ' + appBRL_(porMes) + ' por mês na provisão a partir de agora ajuda a cobrir.' : ' Cadastre os gastos anuais para planejar a provisão.');
  }

  // Metas
  let metas = [];
  try {
    metas = getMetasEconomia().map(mt => ({
      id: String(mt.id), nome: mt.nome, meta: appArred_(mt.valor_meta), atual: appArred_(mt.saldo_atual),
      restante: appArred_(mt.restante), meses: mt.meses_restantes, por_mes: appArred_(mt.aplicacao_mensal_ideal),
      data_alvo: String(mt.data_alvo || '').slice(0, 10), conta: String(mt.conta_vinculada || ''), conta_nome: mt.nome_conta || ''
    }));
  } catch (e) { metas = []; }

  // Orçamentos do próximo mês, com gasto deste mês, média e sugestão
  const prox = gMesMais_(ha, hm, 1);
  let orcamentos = [];
  try {
    const atual = getOrcamentosProgresso(ha, hm);
    const historico = [1, 2, 3].map(i => { const m = gMesMais_(ha, hm, -i); return getOrcamentosProgresso(m.ano, m.mes); });
    const ativosProx = getOrcamentosProgresso(prox.ano, prox.mes);
    const ids = {};
    atual.concat(ativosProx).forEach(o => { ids[String(o.id)] = o; });
    orcamentos = Object.keys(ids).map(id => {
      const o = ids[id];
      const a = atual.find(x => String(x.id) === id);
      const hs = historico.map(h => h.find(x => String(x.id) === id)).filter(Boolean);
      const med = hs.length ? hs.reduce((t, x) => t + x.consumido, 0) / hs.length : 0;
      return {
        id: id, nome: o.nome, referencia: String(o.referencia), tipo: o.tipo,
        gasto: appArred_(a ? a.consumido : 0), media: appArred_(med),
        sugestao: med > 0 ? Math.ceil(med / 50) * 50 : 0, limite: appArred_(o.orcado)
      };
    }).sort((x, y) => y.limite - x.limite);
  } catch (e) { orcamentos = []; }
  const comOrc = {};
  orcamentos.forEach(o => { if (o.tipo === 'categoria') comOrc[o.referencia] = true; });
  const semOrcamento = cats.lista.filter(c => c.tipo === 'despesa' && !c.pai && !comOrc[String(c.id)])
    .map(c => ({ id: String(c.id), nome: String(c.nome) })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

  const contas = listContas().filter(c => appAtivo_(c.ativo) && c.tipo !== 'emprestimo').map(c => ({ id: String(c.id), nome: String(c.nome) }));

  return {
    hoje: hoje,
    base_meses: base.length,
    tem_fixas: temFixas,
    proximos: proximos,
    alerta: alerta,
    provisoes: provisoes,
    provisao_por_mes: appArred_(provisoes.reduce((t, p) => t + p.por_mes, 0)),
    metas: metas,
    orcamentos: orcamentos,
    orcamento_mes: { ano: prox.ano, mes: prox.mes, rotulo: ROT[prox.mes - 1] },
    sem_orcamento: semOrcamento,
    contas: contas
  };
}

function maiusc_(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

/**
 * Gastos anuais (Projetos com tipo = provisao). O guardado sai do saldo da conta
 * vinculada; se várias provisões usam a mesma conta, o saldo é dividido na
 * proporção do valor de cada uma.
 */
function gProvisoes_() {
  const hoje = Utils.today();
  const hm = Number(hoje.slice(5, 7));
  const lista = listProjetos().filter(p => p.tipo === 'provisao');
  const saldos = {};
  getSaldosContas().forEach(s => { saldos[String(s.id)] = Number(s.confirmado) || 0; });
  const somaPorConta = {};
  lista.forEach(p => { if (p.conta_vinculada) somaPorConta[p.conta_vinculada] = (somaPorConta[p.conta_vinculada] || 0) + (Number(p.valor_meta) || 0); });
  const contas = {};
  listContas().forEach(c => { contas[String(c.id)] = String(c.nome); });
  return lista.map(p => {
    const valor = Number(p.valor_meta) || 0;
    const mv = Math.max(1, Math.min(12, Number(p.mes_vencimento) || 1));
    let guardado = 0;
    if (p.conta_vinculada && somaPorConta[p.conta_vinculada] > 0) {
      guardado = Math.max(0, (saldos[String(p.conta_vinculada)] || 0) * valor / somaPorConta[p.conta_vinculada]);
    }
    guardado = Math.min(guardado, valor);
    // Meses até o próximo vencimento (inclui o mês do vencimento)
    let meses = mv - hm;
    if (meses <= 0) meses += 12;
    const restante = Math.max(0, valor - guardado);
    return {
      id: String(p.id), nome: String(p.nome), valor: appArred_(valor), mes_vencimento: mv,
      conta: String(p.conta_vinculada || ''), conta_nome: contas[String(p.conta_vinculada)] || '',
      compartilhada: !!(p.conta_vinculada && lista.filter(x => x.conta_vinculada === p.conta_vinculada).length > 1),
      guardado: appArred_(guardado), restante: appArred_(restante), meses: meses,
      por_mes: appArred_(restante / meses)
    };
  }).sort((a, b) => a.meses - b.meses);
}

/** Cria ou altera meta/provisão: { id?, tipo, nome, valor, data_alvo?, mes_vencimento?, conta } */
function appSalvarObjetivo(o) {
  o = o || {};
  Init.ensureAllSheets();
  const nome = String(o.nome || '').trim();
  if (!nome) throw new Error('Dê um nome.');
  const valor = Math.abs(Utils.toNumber(o.valor));
  if (!(valor > 0)) throw new Error('Informe o valor.');
  const dados = {
    id: o.id || undefined, nome: nome, valor_meta: valor, conta_vinculada: String(o.conta || ''),
    tipo: o.tipo === 'provisao' ? 'provisao' : 'meta',
    data_alvo: o.tipo === 'provisao' ? '' : String(o.data_alvo || '')
  };
  if (o.tipo === 'provisao') dados.mes_vencimento = Number(o.mes_vencimento) || 1;
  saveProjeto(dados);
  return { ok: true };
}

function appExcluirObjetivo(id) {
  deleteProjeto(id);
  return { ok: true };
}

/** Limites do próximo mês: [{ id?, referencia?, valor }] (id = orçamento existente). */
function appSalvarOrcamentos(lista) {
  const atuais = {};
  listOrcamentos().forEach(o => { atuais[String(o.id)] = o; });
  // Limite novo vale já a partir deste mês
  const desde = Utils.today().slice(0, 7);
  let n = 0;
  (lista || []).forEach(it => {
    const valor = Math.abs(Utils.toNumber(it.valor));
    if (it.id && atuais[String(it.id)]) {
      if (Math.abs((Number(atuais[String(it.id)].valor) || 0) - valor) < 0.005) return;
      DB.update(SHEET_ORCAMENTOS, it.id, { valor: valor });
      n++;
    } else if (it.referencia && valor > 0) {
      saveOrcamento({ tipo: 'categoria', referencia: String(it.referencia), valor: valor, periodo: 'mensal',
        data_inicio: desde });
      n++;
    }
  });
  return { ok: true, alterados: n };
}
