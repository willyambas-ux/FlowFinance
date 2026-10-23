/**
 * Lancamentos.gs — CRUD + agregações para visão geral.
 * Status válidos: pendente | agendado | confirmado | conciliado | revisar
 *   pendente = a pagar/receber (vai para o Google Agenda); agendado = programado;
 *   confirmado/conciliado = realizado; revisar = realizado, falta conferir (veio de
 *   notificação do banco ou foi salvo para revisar no app).
 * Convenção de sinal: receitas têm valor positivo, despesas negativo.
 */
const SHEET_LANCAMENTOS = 'Lancamentos';

function listLancamentos(filtro) {
  filtro = filtro || {};
  let dados = DB.readAll(SHEET_LANCAMENTOS);

  if (filtro.ano && filtro.mes) {
    const r = Utils.monthRange(filtro.ano, filtro.mes);
    dados = dados.filter(l => l.data >= r.start && l.data <= r.end);
  }
  if (filtro.conta)    dados = dados.filter(l => l.conta === filtro.conta);
  if (filtro.status)   dados = dados.filter(l => l.status === filtro.status);
  if (filtro.categoria) dados = dados.filter(l => l.categoria === filtro.categoria);

  dados.sort((a, b) => String(a.data).localeCompare(String(b.data)));
  return dados;
}

function saveLancamento(data) {
  // Regras de auto-preenchimento só rodam em novos lançamentos (não em edições).
  let processed = data;
  if (data && !data.id) {
    try { processed = aplicarRegras(data); }
    catch (e) { processed = data; }
  }
  const record = normalizeLancamento_(processed);
  const saved = (data && data.id)
    ? DB.update(SHEET_LANCAMENTOS, data.id, record)
    : DB.insert(SHEET_LANCAMENTOS, record);

  // Auto-sync com Google Calendar (silencioso — não bloqueia o save)
  if (saved) {
    try {
      const novoId = (typeof _autoSyncIfEnabled === 'function') ? _autoSyncIfEnabled(saved) : null;
      if (novoId !== null && novoId !== saved.calendar_event_id) {
        DB.update(SHEET_LANCAMENTOS, saved.id, { calendar_event_id: novoId });
        saved.calendar_event_id = novoId;
      }
    } catch (e) { /* falha do Calendar não derruba o save */ }
  }
  return saved;
}

/** Um lançamento pelo id, lido direto da planilha (null se não existir). */
function getLancamento(id) {
  if (!id) return null;
  return DB.readAllFresh(SHEET_LANCAMENTOS).find(l => String(l.id) === String(id)) || null;
}

function deleteLancamento(id) {
  const lanc = DB.findById(SHEET_LANCAMENTOS, id);

  // Transferência: remove AMBAS as pernas (saída + entrada) que compartilham
  // o transferencia_id. Não faz sentido deixar meia transferência.
  if (lanc && lanc.transferencia_id) {
    const pernas = DB.readAll(SHEET_LANCAMENTOS)
      .filter(l => l.transferencia_id === lanc.transferencia_id);
    pernas.forEach(p => {
      try {
        if (p.calendar_event_id && typeof _removeCalendarEventForLanc === 'function') {
          _removeCalendarEventForLanc(p);
        }
      } catch (e) {}
      DB.remove(SHEET_LANCAMENTOS, p.id);
    });
    return { ok: true, removed: pernas.length };
  }

  // Lançamento normal
  try {
    if (lanc && lanc.calendar_event_id && typeof _removeCalendarEventForLanc === 'function') {
      _removeCalendarEventForLanc(lanc);
    }
  } catch (e) {}
  return DB.remove(SHEET_LANCAMENTOS, id);
}

/**
 * Atualiza em massa os campos de vários lançamentos (seleção múltipla).
 * @param {string[]} ids
 * @param {Object} changes - { status?, categoria?, centro?, conta? }
 *   Só aplica os campos presentes (não-vazios). Para 'status', recalcula 'conciliado'.
 * @returns {{ok:true, count:number}}
 */
function updateLancamentosBatch(ids, changes) {
  ids = (ids || []).map(String);
  changes = changes || {};
  if (ids.length === 0) return { ok: true, count: 0 };

  // Monta o patch só com campos válidos
  const patch = {};
  ['status', 'categoria', 'centro', 'conta', 'fatura_competencia'].forEach(k => {
    if (changes[k] !== undefined && changes[k] !== null && changes[k] !== '') patch[k] = changes[k];
  });
  if (Object.keys(patch).length === 0) return { ok: true, count: 0 };
  if (patch.status !== undefined) patch.conciliado = (patch.status === 'conciliado');
  if (patch.fatura_competencia !== undefined) patch.fatura_competencia = String(patch.fatura_competencia).slice(0, 7);

  const patchById = {};
  ids.forEach(id => { patchById[id] = patch; });

  const count = DB.batchUpdate(SHEET_LANCAMENTOS, patchById);
  return { ok: true, count: count };
}

/**
 * Exclui vários lançamentos de uma vez (seleção múltipla).
 * Expande transferências (remove as 2 pernas) e limpa eventos do Calendar.
 */
function deleteLancamentosBatch(ids) {
  ids = (ids || []).map(String);
  if (ids.length === 0) return { ok: true, count: 0 };

  const all = DB.readAll(SHEET_LANCAMENTOS);
  const byId = {};
  all.forEach(l => { byId[String(l.id)] = l; });

  // Expande: inclui ambas as pernas de cada transferência
  const idSet = new Set();
  ids.forEach(id => {
    const lanc = byId[id];
    if (!lanc) return;
    if (lanc.transferencia_id) {
      all.filter(l => l.transferencia_id === lanc.transferencia_id)
         .forEach(p => idSet.add(String(p.id)));
    } else {
      idSet.add(id);
    }
  });

  // Remove eventos de Calendar (silencioso)
  idSet.forEach(id => {
    const l = byId[id];
    try {
      if (l && l.calendar_event_id && typeof _removeCalendarEventForLanc === 'function') {
        _removeCalendarEventForLanc(l);
      }
    } catch (e) {}
  });

  const count = DB.batchRemove(SHEET_LANCAMENTOS, Array.from(idSet));
  return { ok: true, count: count };
}

/* ============================================================================
 * Operações em série (parcelados/fixos compartilham recorrencia_id).
 * ========================================================================== */

/**
 * Retorna informações sobre a série de um lançamento.
 * @param {string} id - ID do lançamento de referência.
 * @returns {{is_series:boolean, total:number, forward_count:number, recorrencia_id:string}}
 */
function getLancamentoSerieInfo(id) {
  const ref = DB.findById(SHEET_LANCAMENTOS, id);
  if (!ref) return { is_series: false, total: 0, forward_count: 0, recorrencia_id: '' };
  if (!ref.recorrencia_id) return { is_series: false, total: 1, forward_count: 1, recorrencia_id: '' };
  const irmaos = DB.readAll(SHEET_LANCAMENTOS).filter(l => l.recorrencia_id === ref.recorrencia_id);
  const forward = irmaos.filter(l => String(l.data) >= String(ref.data));
  return {
    is_series: irmaos.length > 1,
    total: irmaos.length,
    forward_count: forward.length,
    recorrencia_id: ref.recorrencia_id
  };
}

/**
 * Atualiza um lançamento e (opcionalmente) os irmãos da mesma série.
 * @param {string} refId - ID do lançamento clicado.
 * @param {'one'|'forward'|'all'} scope - escopo da alteração.
 * @param {Object} data - dados do form (mesmo formato de saveLancamento).
 * @returns {{ok:true, count:number}}
 */
function updateLancamentoSerie(refId, scope, data) {
  const ref = DB.findById(SHEET_LANCAMENTOS, refId);
  if (!ref) throw new Error('Lançamento não encontrado: ' + refId);

  // Sem série ou escopo "one": comportamento padrão de saveLancamento
  if (!ref.recorrencia_id || scope === 'one') {
    const saved = saveLancamento(Object.assign({}, data, { id: refId }));
    return { ok: true, count: saved ? 1 : 0 };
  }

  const irmaos = DB.readAll(SHEET_LANCAMENTOS).filter(l => l.recorrencia_id === ref.recorrencia_id);
  let alvos;
  if (scope === 'forward') alvos = irmaos.filter(l => String(l.data) >= String(ref.data));
  else if (scope === 'all') alvos = irmaos;
  else alvos = [ref];

  // Campos que NUNCA propagam (identidade/sequência/ligações da parcela específica)
  const NAO_PROPAGAR = new Set([
    'id', 'data',
    'parcela_atual', 'parcela_total', 'recorrencia_id',
    'transferencia_id', 'calendar_event_id', 'anexo_url'
  ]);

  // Extrai descrição base (sem sufixo de parcela "(N/M)")
  const novaDescBase = String(data.descricao || '').replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();

  let count = 0;
  alvos.forEach(alvo => {
    const merged = Object.assign({}, alvo);
    // Aplica os campos do form, exceto os que não devem propagar
    Object.keys(data || {}).forEach(k => {
      if (NAO_PROPAGAR.has(k)) return;
      merged[k] = data[k];
    });
    // Reconstroi descrição: base + sufixo da parcela específica (se houver)
    if (alvo.parcela_atual && alvo.parcela_total) {
      merged.descricao = novaDescBase + ' (' + alvo.parcela_atual + '/' + alvo.parcela_total + ')';
    } else {
      merged.descricao = novaDescBase;
    }
    // Identidade preservada
    merged.id = alvo.id;
    merged.data = alvo.data;
    merged.parcela_atual = alvo.parcela_atual;
    merged.parcela_total = alvo.parcela_total;
    merged.recorrencia_id = alvo.recorrencia_id;
    merged.transferencia_id = alvo.transferencia_id;
    merged.calendar_event_id = alvo.calendar_event_id;

    const saved = DB.update(SHEET_LANCAMENTOS, alvo.id, normalizeLancamento_(merged));
    // Auto-sync com Calendar (silencioso)
    if (saved) {
      try {
        const novoId = (typeof _autoSyncIfEnabled === 'function') ? _autoSyncIfEnabled(saved) : null;
        if (novoId !== null && novoId !== saved.calendar_event_id) {
          DB.update(SHEET_LANCAMENTOS, saved.id, { calendar_event_id: novoId });
        }
      } catch (e) {}
    }
    count++;
  });

  return { ok: true, count: count };
}

/**
 * Exclui um lançamento e (opcionalmente) os irmãos da mesma série.
 * @param {string} refId
 * @param {'one'|'forward'|'all'} scope
 */
function deleteLancamentoSerie(refId, scope) {
  const ref = DB.findById(SHEET_LANCAMENTOS, refId);
  if (!ref) throw new Error('Lançamento não encontrado: ' + refId);

  if (!ref.recorrencia_id || scope === 'one') {
    deleteLancamento(refId);
    return { ok: true, count: 1 };
  }

  const irmaos = DB.readAll(SHEET_LANCAMENTOS).filter(l => l.recorrencia_id === ref.recorrencia_id);
  let alvos;
  if (scope === 'forward') alvos = irmaos.filter(l => String(l.data) >= String(ref.data));
  else if (scope === 'all') alvos = irmaos;
  else alvos = [ref];

  // Remove direto via DB (não via deleteLancamento) porque numa série de transferências
  // as duas pernas já estão em `irmaos` — deleteLancamento tentaria removê-las de novo.
  // Contamos transferências distintas (por transferencia_id) pra mensagem fazer sentido.
  let count = 0;
  const removidos = new Set();
  const transfContadas = new Set();
  alvos.forEach(l => {
    if (removidos.has(l.id)) return;
    try {
      if (l.calendar_event_id && typeof _removeCalendarEventForLanc === 'function') {
        _removeCalendarEventForLanc(l);
      }
    } catch (e) {}
    DB.remove(SHEET_LANCAMENTOS, l.id);
    removidos.add(l.id);
    // Conta 1 por transferência (não por perna)
    if (l.transferencia_id) {
      if (!transfContadas.has(l.transferencia_id)) {
        transfContadas.add(l.transferencia_id);
        count++;
      }
    } else {
      count++;
    }
  });
  return { ok: true, count: count };
}

/**
 * Cria N lançamentos consecutivos a partir de um template.
 * Gera um id de série (recorrencia_id) compartilhado pelas N parcelas.
 * O valor é dividido igualmente; a última parcela absorve eventuais centavos restantes.
 */
/**
 * Cria parcelas de `parcelaInicial` até `totalParcelas` (inclusive).
 *   - Útil para registrar planos já em andamento (ex.: parcela 3/12 → gera 3..12).
 *   - `data.valor` é o VALOR TOTAL do plano. Cada parcela = valor/totalParcelas.
 *   - A última absorve eventuais centavos de sobra.
 */
function criarParcelamento(data, totalParcelas, parcelaInicial, periodicidade, intervalo) {
  const total = Math.max(1, Math.floor(Number(totalParcelas) || 1));
  const inicial = Math.max(1, Math.min(total, Math.floor(Number(parcelaInicial) || 1)));
  const period = periodicidade || 'mensal';
  const intv = Math.max(1, Math.floor(Number(intervalo) || 1));
  if (total === 1) return [saveLancamento(data)];

  const valorTotal = Utils.toNumber(data.valor);
  const valorParcela = Math.round((valorTotal / total) * 100) / 100;
  const sobra = +(valorTotal - valorParcela * total).toFixed(2);

  const baseData = data.data || Utils.today();
  const baseDate = new Date(baseData + (String(baseData).length === 10 ? 'T00:00:00' : ''));
  const baseDescricao = String(data.descricao || '').trim();
  const recId = Utils.uuid();

  const criados = [];
  for (let i = inicial; i <= total; i++) {
    const offset = i - inicial; // primeira parcela registrada cai em baseDate
    const d = offsetData_(baseDate, period, intv, offset);
    const valor = i === total ? +(valorParcela + sobra).toFixed(2) : valorParcela;
    const parcela = Object.assign({}, data, {
      id: null,
      data: Utils.formatDate(d),
      valor: valor,
      descricao: baseDescricao + ' (' + i + '/' + total + ')',
      parcela_atual: i,
      parcela_total: total,
      recorrencia_id: recId,
      // Cada parcela cai numa fatura própria (calculada pela sua data). Não herda a
      // competência fixa do form — senão todas as parcelas iriam pra mesma fatura.
      fatura_competencia: ''
    });
    delete parcela.id;
    criados.push(saveLancamento(parcela));
  }
  return criados;
}

/**
 * Retorna a data deslocada por `offset` períodos (cada período = intervalo unidades da periodicidade).
 */
function offsetData_(baseDate, periodicidade, intervalo, offset) {
  const d = new Date(baseDate);
  const intv = Math.max(1, Math.floor(Number(intervalo) || 1));
  const off  = Number(offset) || 0;
  if (periodicidade === 'diaria') {
    d.setDate(d.getDate() + intv * off);
    return d;
  }
  if (periodicidade === 'semanal') {
    d.setDate(d.getDate() + 7 * intv * off);
    return d;
  }
  if (periodicidade === 'anual') {
    d.setFullYear(d.getFullYear() + intv * off);
    return d;
  }
  // mensal
  const target = new Date(d.getFullYear(), d.getMonth() + intv * off, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d.getDate(), lastDay));
  return target;
}

// addMonths_ legado mantido (não é mais usado, mas evita quebrar callers externos)
function addMonths_(date, months) {
  return offsetData_(date, 'mensal', 1, months);
}

function normalizeLancamento_(data) {
  data = data || {};
  const out = {
    data: data.data || Utils.today(),
    descricao: String(data.descricao || '').trim(),
    valor: Utils.toNumber(data.valor),
    conta: data.conta || '',
    categoria: data.categoria || '',
    centro: data.centro || '',
    projeto: data.projeto || '',
    contato: data.contato || '',
    tags: data.tags || '',
    status: data.status || 'pendente',
    cartao: data.cartao || '',
    parcela_atual: data.parcela_atual || '',
    parcela_total: data.parcela_total || '',
    recorrencia_id: data.recorrencia_id || '',
    transferencia_id: data.transferencia_id || '',
    anexo_url: data.anexo_url || '',
    calendar_event_id: data.calendar_event_id || '',
    conciliado: data.status === 'conciliado',
    observacao: data.observacao || '',
    fatura_competencia: data.fatura_competencia ? String(data.fatura_competencia).slice(0, 7) : ''
  };
  // 'quem' (quem lançou) só entra quando vem preenchido: assim uma edição pelo
  // web app, que não conhece esse campo, não apaga o valor gravado pelo bot.
  if (data.quem !== undefined && data.quem !== '') out.quem = String(data.quem);
  // Mesmo cuidado com 'origem' (telegram | notificacao | cupom | app | importacao).
  if (data.origem !== undefined && data.origem !== '') out.origem = String(data.origem);
  return out;
}

/* ============================================================================
 * Agregações para a Visão Geral.
 * ========================================================================== */

function getResumoMes(ano, mes) {
  const lancs = listLancamentos({ ano: ano, mes: mes }).filter(l => !l.transferencia_id);
  let receitas = 0, despesas = 0;
  lancs.forEach(l => {
    const v = Number(l.valor) || 0;
    if (v >= 0) receitas += v;
    else despesas += Math.abs(v);
  });
  return {
    receitas: receitas,
    despesas: despesas,
    saldo: receitas - despesas,
    quantidade: lancs.length
  };
}

/**
 * Fluxo de caixa diário (saldo projetado) ao longo de um mês.
 * Considera apenas lançamentos com `conta` preenchida (ignora lançamentos no cartão).
 */
function getFluxoCaixa(ano, mes, contasIds) {
  const todasContas = listContas().filter(c =>
    Utils.toBool(c.ativo) || c.ativo === '' || c.ativo === undefined
  );
  let contas;
  if (Array.isArray(contasIds)) {
    const set = new Set(contasIds.map(String));
    contas = todasContas.filter(c => set.has(String(c.id)));
  } else {
    contas = todasContas;
  }
  if (contas.length === 0) return [];

  const contaIdSet = new Set(contas.map(c => String(c.id)));
  const lancs = DB.readAll(SHEET_LANCAMENTOS).filter(l =>
    l.conta && contaIdSet.has(String(l.conta))
  );
  lancs.sort((a, b) => String(a.data).localeCompare(String(b.data)));

  const inicio = new Date(ano, mes - 1, 1);
  const fim = new Date(ano, mes, 0);
  const inicioStr = Utils.formatDate(inicio);
  const fimStr = Utils.formatDate(fim);

  let saldo = contas.reduce((s, c) => s + (Number(c.saldo_inicial) || 0), 0);
  let idx = 0;

  // Incorpora lançamentos anteriores ao início do range
  while (idx < lancs.length && lancs[idx].data < inicioStr) {
    saldo += Number(lancs[idx].valor) || 0;
    idx++;
  }

  const pontos = [];
  const cur = new Date(inicio);
  while (Utils.formatDate(cur) <= fimStr) {
    const dStr = Utils.formatDate(cur);
    let entradas = 0;
    let saidas = 0;
    while (idx < lancs.length && lancs[idx].data === dStr) {
      const v = Number(lancs[idx].valor) || 0;
      saldo += v;
      if (v > 0) entradas += v;
      else if (v < 0) saidas += Math.abs(v);
      idx++;
    }
    pontos.push({ data: dStr, saldo: saldo, entradas: entradas, saidas: saidas });
    cur.setDate(cur.getDate() + 1);
  }
  return pontos;
}

/**
 * View completa da tela de Movimentações com filtros multi-conta e multi-status.
 *
 * Retorna:
 *   - saldo_anterior: soma do saldo das contas filtradas no início do mês
 *                     (saldo_inicial + lançamentos confirmados/conciliados anteriores)
 *   - saldos_contas: saldo confirmado/projetado de cada conta filtrada
 *   - totais: totais agregados (confirmado/projetado) das contas filtradas
 *   - lancamentos: lista do mês (já com `_saldo_corrente`) APÓS filtro de status
 *   - resumo: entradas, saídas, transferências, resultado do conjunto visível
 */
function getMovimentacoesView(ano, mes, contasIds, statusList, cartoesIds) {
  contasIds  = (contasIds  || []).map(String);
  cartoesIds = (cartoesIds || []).map(String);
  statusList = statusList || [];
  // Filtro explícito: vazio = nenhum resultado (não "todos").
  const contasSet  = new Set(contasIds);
  const cartoesSet = new Set(cartoesIds);
  const statusSet  = new Set(statusList);

  const r = Utils.monthRange(ano, mes);
  const contasAll = listContas();
  const lancsAll = DB.readAll(SHEET_LANCAMENTOS);

  const contasUsadas = contasAll.filter(c => contasSet.has(String(c.id)));

  // Contas OPERACIONAIS = todas exceto empréstimo. Cartões e empréstimos são passivos
  // (não compõem o caixa do mês — seus pagamentos já aparecem como saída na conta
  // pagadora via lançamento ou virtual de fatura).
  const contasOp    = contasUsadas.filter(c => c.tipo !== 'emprestimo');
  const contasOpSet = new Set(contasOp.map(c => String(c.id)));

  // Saldo anterior — só CONTAS OPERACIONAIS pro caixa; cartões trackeados à parte.
  // Calcula POR CONTA pra permitir agrupamento no frontend, e mantém os totais agregados.
  const saldoAnteriorPorConta = {}; // contaId -> valor
  contasOp.forEach(c => { saldoAnteriorPorConta[c.id] = Number(c.saldo_inicial) || 0; });
  let saldoAnteriorCartoes = 0;
  lancsAll.forEach(l => {
    if (l.data >= r.start) return;
    if (l.conta && contasOpSet.has(String(l.conta))) {
      if (Utils.statusRealizado(l.status)) {
        saldoAnteriorPorConta[l.conta] = (saldoAnteriorPorConta[l.conta] || 0) + (Number(l.valor) || 0);
      }
    } else if (l.cartao && cartoesSet.has(String(l.cartao))) {
      saldoAnteriorCartoes += Number(l.valor) || 0;
    }
  });
  const saldoAnteriorContas = Object.keys(saldoAnteriorPorConta)
    .reduce((s, k) => s + saldoAnteriorPorConta[k], 0);
  const saldoAnterior = saldoAnteriorContas + saldoAnteriorCartoes;

  // Lançamentos do mês para contas/cartões selecionados
  let lancsMes = lancsAll.filter(l => {
    if (l.data < r.start || l.data > r.end) return false;
    if (l.conta  && contasSet.has(String(l.conta)))   return true;
    if (l.cartao && cartoesSet.has(String(l.cartao))) return true;
    return false;
  });

  // Orçamentos ativos no mês (com progresso) — precisa vir antes dos virtuais
  let orcamentos = [];
  try { orcamentos = getOrcamentosProgresso(ano, mes); }
  catch (e) { orcamentos = []; }

  // Lançamentos virtuais: "Restante de orçamento" (no último dia do mês)
  if (orcamentos.length > 0) {
    const cats = listCategorias();
    const lastDay = Utils.formatDate(new Date(ano, mes, 0));
    orcamentos.forEach(o => {
      if (!o.mostrar_restante) return;
      const restante = (Number(o.orcado) || 0) - (Number(o.consumido) || 0);
      if (restante <= 0.01) return;

      let catTarget = '';
      let centroTarget = '';
      if (o.tipo === 'categoria') {
        const cat = cats.find(c => String(c.id) === String(o.referencia));
        catTarget = (cat && cat.pai) ? cat.pai : (o.referencia || '');
      } else {
        centroTarget = o.referencia || '';
      }

      lancsMes.push({
        id: '_v_orc_' + o.id,
        data: lastDay,
        descricao: 'Restante orçamento: ' + (o.nome || o.ref_nome),
        valor: -Math.abs(restante),
        conta: '',
        cartao: '',
        categoria: catTarget,
        centro: centroTarget,
        projeto: '',
        contato: '',
        tags: '',
        status: 'agendado',
        recorrencia_id: '',
        transferencia_id: '',
        anexo_url: '',
        parcela_atual: '',
        parcela_total: '',
        observacao: '',
        _virtual: true,
        _orcamento_id: o.id
      });
    });
  }

  // Lançamentos virtuais: "Pagamento de fatura projetado" — para cada cartão selecionado
  // com conta_pagamento dentro do filtro, gera uma saída na data do vencimento equivalente
  // ao total da fatura, A NÃO SER que já exista transferência de pagamento daquele mês.
  try {
    const cartoesAll = listCartoes().filter(c =>
      Utils.toBool(c.ativo) || c.ativo === '' || c.ativo === undefined
    );
    cartoesAll.forEach(c => {
      if (!cartoesSet.has(String(c.id))) return;            // cartão não selecionado
      if (!c.conta_pagamento) return;                       // sem conta de pagamento
      if (!contasSet.has(String(c.conta_pagamento))) return;// conta de pagamento fora do filtro

      let fatura;
      try { fatura = getFatura(c.id, ano, mes); } catch (e) { return; }
      const total = Number(fatura.total) || 0;
      if (Math.abs(total) < 0.01) return;                   // fatura zerada

      const dataVenc = fatura.ciclo.vencimento;
      if (!dataVenc) return;
      const yyyymm = String(dataVenc).slice(0, 7);

      // Já existe pagamento de fatura desse cartão nesse mês? (perna +cartao da transferência)
      const jaPago = lancsAll.some(l =>
        l.transferencia_id &&
        String(l.cartao) === String(c.id) &&
        (Number(l.valor) || 0) > 0 &&
        String(l.data).slice(0, 7) === yyyymm
      );
      if (jaPago) return;

      lancsMes.push({
        id: '_v_pagfat_' + c.id,
        data: dataVenc,
        descricao: 'Fatura ' + c.nome + ' (a pagar)',
        valor: total,                  // já é negativo (saída na conta)
        conta: c.conta_pagamento,
        cartao: '',
        categoria: '',
        centro: '',
        projeto: '',
        contato: '',
        tags: '',
        status: 'agendado',
        recorrencia_id: '',
        transferencia_id: '',
        anexo_url: '',
        parcela_atual: '',
        parcela_total: '',
        observacao: 'Projeção do pagamento da fatura. Use "Pagar fatura" pra concretizar.',
        _virtual: true,
        _fatura_cartao_id: c.id
      });
    });
  } catch (e) { /* falha silenciosa — não derruba a view */ }

  lancsMes.sort((a, b) => String(a.data).localeCompare(String(b.data)));

  // Separa em dois fluxos independentes:
  //  - CONTAS (caixa): lançamentos de contas OPERACIONAIS + virtuais (orçamento, pagto fatura)
  //  - CARTÕES (fatura): lançamentos de cartão (não afetam o caixa)
  //  Lançamentos em conta de empréstimo NÃO entram no caixa (são amortização de passivo).
  let lancsContas  = lancsMes.filter(l => {
    if (l.cartao) return false;
    if (l._virtual && !l.conta) return true;        // virtual de orçamento (sem conta)
    if (!l.conta) return true;                      // defensivo
    return contasOpSet.has(String(l.conta));        // só contas operacionais
  });
  let lancsCartoes = lancsMes.filter(l => l.cartao);

  // Saldo corrente do caixa (contas)
  let saldoC = saldoAnteriorContas;
  let saldoContasReal = saldoAnteriorContas; // sem virtuais
  lancsContas.forEach(l => {
    const v = Number(l.valor) || 0;
    saldoC += v;
    if (!l._virtual) saldoContasReal += v;
    l._saldo_corrente = saldoC;
  });
  const saldoFinalContasComV = saldoC;        // inclui virtuais (previsão de orçamento)
  const saldoFinalContas     = saldoContasReal; // só lançamentos reais de conta

  // Acumulado de fatura (cartões) — saldo devedor crescendo no mês
  let saldoK = saldoAnteriorCartoes;
  lancsCartoes.forEach(l => {
    saldoK += Number(l.valor) || 0;
    l._saldo_corrente = saldoK;
  });
  const saldoFinalCartoes = saldoK;

  // Filtro de status em cada fluxo
  lancsContas  = lancsContas.filter(l => statusSet.has(l.status));
  lancsCartoes = lancsCartoes.filter(l => statusSet.has(l.status));
  lancsMes     = lancsMes.filter(l => statusSet.has(l.status));

  // Info por cartão (rodapé da tabela de cartões): total do mês, vencimento, limite, disponível
  const vencMes = mes === 12 ? 1 : mes + 1;
  const vencAno = mes === 12 ? ano + 1 : ano;
  const cartoesInfo = listCartoes()
    .filter(c => cartoesSet.has(String(c.id)))
    .map(c => {
      let totalMes = 0;
      lancsCartoes.forEach(l => {
        if (String(l.cartao) === String(c.id)) totalMes += Number(l.valor) || 0;
      });
      const diaVenc = Number(c.dia_vencimento) || 0;
      let vencimento = '';
      if (diaVenc > 0) {
        const ultDia = new Date(vencAno, vencMes, 0).getDate();
        vencimento = Utils.formatDate(new Date(vencAno, vencMes - 1, Math.min(diaVenc, ultDia)));
      }
      let limite = Number(c.limite) || 0, disponivel = null;
      try { const rr = getCartaoResumo(c.id); limite = rr.limite; disponivel = rr.disponivel; }
      catch (e) {}
      return {
        id: c.id,
        nome: c.nome,
        icone: c.icone || 'credit_card',
        icone_url: c.icone_url || '',
        total_mes: totalMes,
        dia_vencimento: diaVenc,
        vencimento: vencimento,
        limite: limite,
        disponivel: disponivel
      };
    });

  // Saldos das contas + cartões (TODOS pra sidebar; totais só dos selecionados).
  // Projetado: limitado ao fim do mês visível (evita inflar com parcelas longe no futuro).
  const saldosContas  = getSaldosContas(r.end);
  const saldosCartoes = getSaldosCartoes(ano, mes); // passa ano/mes pra calcular fatura do ciclo
  // Total OPERACIONAL (caixa): só contas que não são empréstimo
  // Total PASSIVOS: cartões + contas tipo empréstimo (saldo devedor)
  let totaisConf = 0, totaisProj = 0;
  let passivosConf = 0, passivosProj = 0;
  saldosContas.forEach(s => {
    if (!contasSet.has(String(s.id))) return;
    if (s.tipo === 'emprestimo') {
      passivosConf += Number(s.confirmado) || 0;
      passivosProj += Number(s.projetado)  || 0;
    } else {
      totaisConf += Number(s.confirmado) || 0;
      totaisProj += Number(s.projetado)  || 0;
    }
  });
  saldosCartoes.forEach(s => {
    if (!cartoesSet.has(String(s.id))) return;
    passivosConf += Number(s.confirmado) || 0;
    passivosProj += Number(s.projetado)  || 0;
  });

  // Resumo: separa lançamentos reais de virtuais (Restante orçamento).
  // O usuário precisa ver as duas perspectivas:
  //   - "real": só lançamentos da planilha → bate com Projetado das contas
  //   - "com previsão": inclui virtuais → bate com saldo corrente da tabela
  let receitas = 0, despesas = 0, transfIn = 0, transfOut = 0;
  let virtuais = 0;
  lancsMes.forEach(l => {
    const v = Number(l.valor) || 0;
    if (l._virtual) {
      // Virtuais são sempre saídas (Restante orçamento)
      virtuais += Math.abs(v);
      return;
    }
    if (l.transferencia_id) {
      if (v > 0) transfIn  += v;
      else       transfOut += Math.abs(v);
    } else {
      if (v > 0) receitas += v;
      else       despesas += Math.abs(v);
    }
  });

  const entradas       = receitas + transfIn;
  const saidasReais    = despesas + transfOut;
  const resultadoReal  = entradas - saidasReais;
  const resultadoComV  = entradas - (saidasReais + virtuais);

  return {
    saldo_anterior: saldoAnterior,
    saldo_anterior_contas: saldoAnteriorContas,
    saldo_anterior_cartoes: saldoAnteriorCartoes,
    saldo_anterior_por_conta: saldoAnteriorPorConta,
    saldo_final_contas: saldoFinalContas,
    saldo_final_contas_com_virtuais: saldoFinalContasComV,
    saldo_final_cartoes: saldoFinalCartoes,
    saldos_contas: saldosContas,
    saldos_cartoes: saldosCartoes,
    totais: { confirmado: totaisConf, projetado: totaisProj },
    totais_passivos: { confirmado: passivosConf, projetado: passivosProj },
    lancamentos: lancsMes,
    lancamentos_contas: lancsContas,
    lancamentos_cartoes: lancsCartoes,
    cartoes_info: cartoesInfo,
    orcamentos: orcamentos,
    resumo: {
      entradas: entradas,
      receitas: receitas,
      transf_in: transfIn,
      saidas: saidasReais,           // só reais
      despesas: despesas,
      transf_out: transfOut,
      virtuais: virtuais,            // total das previsões de orçamento
      resultado: resultadoReal,                       // real (sem virtuais)
      resultado_com_virtuais: resultadoComV,          // com previsão
      saldo_final: saldoAnterior + resultadoReal,                  // bate com Projetado total
      saldo_final_com_virtuais: saldoAnterior + resultadoComV,     // bate com última linha da tabela
      quantidade: lancsMes.length
    }
  };
}

/**
 * Saldos das contas.
 * @param {string} [ate] - Data limite (yyyy-MM-dd) para o "projetado". Se omitido,
 *                        considera TODOS os lançamentos (passado + futuro).
 *                        O "confirmado" sempre considera tudo (é o estado real).
 */
function getSaldosContas(ate) {
  const contas = listContas().filter(c => Utils.toBool(c.ativo) || c.ativo === '' || c.ativo === undefined);
  const lancs = DB.readAll(SHEET_LANCAMENTOS);
  const limite = ate || null;

  return contas.map(conta => {
    const ini = Number(conta.saldo_inicial) || 0;
    let confirmado = ini;
    let projetado = ini;
    lancs.forEach(l => {
      if (l.conta !== conta.id) return;
      const v = Number(l.valor) || 0;
      if (!limite || l.data <= limite) projetado += v;
      if (Utils.statusRealizado(l.status)) confirmado += v;
    });
    return {
      id: conta.id,
      nome: conta.nome,
      icone: conta.icone || 'account_balance',
      icone_url: conta.icone_url || '',
      moeda: conta.moeda || 'BRL',
      tipo: conta.tipo,
      confirmado: confirmado,
      projetado: projetado
    };
  });
}
