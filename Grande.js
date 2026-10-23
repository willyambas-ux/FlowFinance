/**
 * Grande.js — funções da versão de tela grande (computador e tablet):
 * Visão do mês (reunião), Revisar em lote, Lançamentos em tabela,
 * indicadores de saúde financeira e decisões da reunião.
 *
 * Usa as mesmas bases do app do celular (App.js).
 */

const SHEET_DECISOES = 'Decisoes';

/* ============================================================================
 * Ajudantes
 * ========================================================================== */

function gMesMais_(ano, mes, delta) {
  let a = Number(ano), m = Number(mes) + delta;
  while (m > 12) { m -= 12; a++; }
  while (m < 1) { m += 12; a--; }
  return { ano: a, mes: m };
}

/** Mapa de categorias com a categoria-pai e a natureza (fixa/variável) herdada do pai. */
function gCategorias_() {
  const cats = listCategorias();
  const porId = {};
  cats.forEach(c => { porId[String(c.id)] = c; });
  function pai(id) {
    const c = porId[String(id)];
    if (!c) return null;
    return (c.pai && porId[String(c.pai)]) ? porId[String(c.pai)] : c;
  }
  function natureza(id) {
    const c = porId[String(id)];
    if (!c) return '';
    if (c.natureza) return String(c.natureza);
    const p = pai(id);
    return p && p.natureza ? String(p.natureza) : '';
  }
  return { porId: porId, pai: pai, natureza: natureza, lista: cats };
}

/** Somatórios de um mês (sem transferências), separados em realizado e previsto. */
function gAgregar_(lancs, ano, mes, cats) {
  const r = Utils.monthRange(ano, mes);
  const out = {
    receitas: 0, despesas: 0, fixas: 0,
    rec_realizado: 0, desp_realizado: 0, rec_previsto: 0, desp_previsto: 0,
    porCat: {}, porQuem: {}, quantidade: 0
  };
  lancs.forEach(l => {
    if (l.data < r.start || l.data > r.end || l.transferencia_id) return;
    const v = Number(l.valor) || 0;
    const real = Utils.statusRealizado(l.status);
    out.quantidade++;
    if (v >= 0) {
      out.receitas += v;
      if (real) out.rec_realizado += v; else out.rec_previsto += v;
      return;
    }
    const d = -v;
    out.despesas += d;
    if (real) out.desp_realizado += d; else out.desp_previsto += d;
    const p = cats.pai(l.categoria);
    const k = p ? String(p.id) : '';
    out.porCat[k] = (out.porCat[k] || 0) + d;
    if (cats.natureza(l.categoria) === 'fixa') out.fixas += d;
    const q = l.quem ? String(l.quem) : '';
    out.porQuem[q] = (out.porQuem[q] || 0) + d;
  });
  return out;
}

function gMetaPoupanca_() {
  const v = Number(PropertiesService.getScriptProperties().getProperty('META_POUPANCA'));
  return v > 0 && v < 100 ? v : 15;
}

/* ============================================================================
 * Visão do mês
 * ========================================================================== */

function appMes(ano, mes) {
  ano = Number(ano); mes = Number(mes);
  const hoje = Utils.today();
  const r = Utils.monthRange(ano, mes);
  const lancs = DB.readAllFresh(SHEET_LANCAMENTOS);
  const cats = gCategorias_();

  const atual = gAgregar_(lancs, ano, mes, cats);
  const ant = [1, 2, 3].map(i => { const m = gMesMais_(ano, mes, -i); return gAgregar_(lancs, m.ano, m.mes, cats); });
  const anterior = ant[0];
  const comDados = ant.filter(a => a.quantidade > 0);
  const n = comDados.length || 1;
  const media = { receitas: 0, despesas: 0, fixas: 0, porCat: {} };
  comDados.forEach(a => {
    media.receitas += a.receitas / n; media.despesas += a.despesas / n; media.fixas += a.fixas / n;
    Object.keys(a.porCat).forEach(k => { media.porCat[k] = (media.porCat[k] || 0) + a.porCat[k] / n; });
  });

  // Categorias: este mês vs mês anterior vs média dos 3 anteriores
  const chaves = {};
  Object.keys(atual.porCat).concat(Object.keys(media.porCat)).forEach(k => { chaves[k] = true; });
  const categorias = Object.keys(chaves).map(k => {
    const a = atual.porCat[k] || 0, m = media.porCat[k] || 0;
    return {
      id: k,
      nome: k ? (cats.porId[k] ? cats.porId[k].nome : 'Categoria apagada') : 'Sem categoria',
      natureza: k ? cats.natureza(k) : '',
      atual: appArred_(a),
      anterior: appArred_(anterior.porCat[k] || 0),
      media: appArred_(m),
      variacao: m > 0 ? Math.round((a - m) / m * 100) : null
    };
  }).filter(c => c.atual > 0 || c.media > 0)
    .sort((x, y) => y.atual - x.atual);

  // Onde gastamos demais: bem acima da média (≥10% e ≥ R$ 50)
  const acima = categorias
    .filter(c => c.id && comDados.length && c.atual - c.media >= 50 && (c.media === 0 || c.atual >= c.media * 1.1))
    .sort((x, y) => (y.atual - y.media) - (x.atual - x.media))
    .slice(0, 4);

  // Saldo projetado: este mês e o próximo, emendados
  const prox = gMesMais_(ano, mes, 1);
  const p1 = appProjecao_(ano, mes);
  const p2 = appProjecao_(prox.ano, prox.mes);
  const ajuste = p1.fim - p2.inicio; // o próximo mês começa de onde este termina (com o previsto)
  const pontos = p1.pontos.concat(p2.pontos.map(p => ({ data: p.data, saldo: appArred_(p.saldo + ajuste) })));
  const desde = hoje > r.start ? hoje : r.start;
  let menor = null;
  pontos.forEach(p => { if (p.data >= desde && (!menor || p.saldo < menor.saldo)) menor = p; });

  // Saúde financeira
  const caixa = appContasCaixa_();
  const saldos = getSaldosContas();
  const reservaIds = {};
  listContas().forEach(c => { if (Utils.toBool(c.reserva)) reservaIds[String(c.id)] = true; });
  const temReserva = Object.keys(reservaIds).length > 0;
  const reserva = saldos.filter(s => reservaIds[String(s.id)]).reduce((t, s) => t + (Number(s.confirmado) || 0), 0);
  const temFixas = cats.lista.some(c => c.natureza === 'fixa');
  const custoMensal = temFixas ? media.fixas : media.despesas;
  const fimMes = r.end;
  let parcelasFuturas = 0;
  const mesesParcelas = {};
  lancs.forEach(l => {
    if (!(Number(l.parcela_total) > 1) || l.data <= fimMes || (Number(l.valor) || 0) >= 0 || l.transferencia_id) return;
    parcelasFuturas += -Number(l.valor);
    mesesParcelas[String(l.data).slice(0, 7)] = true;
  });
  const saude = {
    meta_poupanca: gMetaPoupanca_(),
    poupanca_mes: atual.receitas > 0 ? Math.round((atual.receitas - atual.despesas) / atual.receitas * 100) : null,
    poupanca_media: media.receitas > 0 ? Math.round((media.receitas - media.despesas) / media.receitas * 100) : null,
    tem_fixas: temFixas,
    fixo_renda: (temFixas && media.receitas > 0) ? Math.round(media.fixas / media.receitas * 100) : null,
    fixo_mensal: appArred_(media.fixas),
    tem_reserva: temReserva,
    reserva: appArred_(reserva),
    reserva_meses: (temReserva && custoMensal > 0) ? Math.round(reserva / custoMensal * 10) / 10 : null,
    reserva_base: temFixas ? 'custo fixo' : 'gasto médio',
    parcelas_futuras: appArred_(parcelasFuturas),
    parcelas_meses: Object.keys(mesesParcelas).length,
    meses_base: comDados.length
  };

  let orcamentos = [];
  try {
    orcamentos = getOrcamentosProgresso(ano, mes).map(o => ({
      id: o.id, nome: o.nome, orcado: appArred_(o.orcado), consumido: appArred_(o.consumido), percentual: o.percentual
    }));
  } catch (e) { orcamentos = []; }

  let metas = [];
  try {
    metas = getMetasEconomia().map(m => ({
      id: m.id, nome: m.nome, meta: appArred_(m.valor_meta), atual: appArred_(m.saldo_atual),
      restante: appArred_(m.restante), meses: m.meses_restantes, por_mes: appArred_(m.aplicacao_mensal_ideal),
      data_alvo: String(m.data_alvo || '').slice(0, 10), conta: m.nome_conta
    }));
  } catch (e) { metas = []; }

  const quem = Object.keys(atual.porQuem)
    .map(k => ({ nome: k || 'Sem nome', total: appArred_(atual.porQuem[k]), sem_nome: !k }))
    .sort((a, b) => (a.sem_nome - b.sem_nome) || (b.total - a.total));

  // Pauta automática da reunião
  const pauta = [];
  const revisar = lancs.filter(l => l.status === 'revisar').length;
  if (revisar) pauta.push({ texto: revisar + (revisar === 1 ? ' lançamento para revisar' : ' lançamentos para revisar'), acao: 'Revisar', alvo: 'revisar' });
  const atrasados = lancs.filter(l => l.status === 'pendente' && l.data < hoje && !l.transferencia_id && (Number(l.valor) || 0) < 0);
  if (atrasados.length) {
    const tot = atrasados.reduce((t, l) => t - Number(l.valor), 0);
    pauta.push({ texto: atrasados.length + (atrasados.length === 1 ? ' conta atrasada' : ' contas atrasadas') + ' (' + appBRL_(tot) + ')', acao: 'Ver', alvo: 'apagar' });
  }
  orcamentos.filter(o => o.percentual >= 90).forEach(o => {
    pauta.push({ texto: o.nome + ': ' + o.percentual + '% do orçamento usado', acao: 'Ver gastos', alvo: 'busca:' + o.nome });
  });
  acima.slice(0, 2).forEach(c => {
    pauta.push({ texto: c.nome + ' ' + appBRL_(c.atual - c.media) + ' acima da média', acao: 'Ver gastos', alvo: 'categoria:' + c.id });
  });
  if (!temFixas || !temReserva) {
    pauta.push({ texto: 'Configurar os indicadores (' + [!temFixas ? 'categorias fixas' : '', !temReserva ? 'conta de reserva' : ''].filter(Boolean).join(' e ') + ')', acao: 'Configurar', alvo: 'config' });
  }

  return {
    ano: ano, mes: mes, hoje: hoje,
    dias_mes: Number(r.end.slice(8, 10)),
    fechamento: {
      resultado: appArred_(atual.receitas - atual.despesas),
      entrou: appArred_(atual.rec_realizado), saiu: appArred_(atual.desp_realizado),
      vai_entrar: appArred_(atual.rec_previsto), vai_sair: appArred_(atual.desp_previsto),
      receitas: appArred_(atual.receitas), despesas: appArred_(atual.despesas)
    },
    projecao: pontos,
    inicio_proximo: p2.pontos.length ? p2.pontos[0].data : '',
    saldo_inicio: p1.inicio,
    saldo_fim: p1.fim,
    menor: menor,
    saude: saude,
    acima: acima,
    categorias: categorias,
    orcamentos: orcamentos,
    metas: metas,
    quem: quem,
    pauta: pauta,
    decisoes: gDecisoes_(12)
  };
}

function appBRL_(v) {
  const n = Math.abs(Number(v) || 0);
  const p = n.toFixed(2).split('.');
  return 'R$ ' + p[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + p[1];
}

/* ============================================================================
 * Decisões da reunião
 * ========================================================================== */

function gDecisoes_(limite) {
  let lista;
  try { lista = DB.readAll(SHEET_DECISOES); } catch (e) { return []; }
  return lista
    .sort((a, b) => String(b.data).localeCompare(String(a.data)) || String(b.criado_em).localeCompare(String(a.criado_em)))
    .slice(0, limite || 12)
    .map(d => ({ id: String(d.id), data: String(d.data || '').slice(0, 10), texto: String(d.texto || ''), quem: String(d.quem || '') }));
}

function appSalvarDecisao(texto) {
  texto = String(texto || '').trim().slice(0, 300);
  if (!texto) throw new Error('Escreva a decisão.');
  Init.ensureAllSheets();
  DB.insert(SHEET_DECISOES, { data: Utils.today(), texto: texto, quem: appQuem_() });
  return gDecisoes_(12);
}

function appExcluirDecisao(id) {
  DB.remove(SHEET_DECISOES, id);
  return gDecisoes_(12);
}

/* ============================================================================
 * Configuração dos indicadores
 * ========================================================================== */

function appIndicadoresConfig() {
  Init.ensureAllSheets();
  const todas = listCategorias().filter(c => c.tipo === 'despesa');
  const nomePor = {};
  todas.forEach(c => { nomePor[String(c.id)] = String(c.nome); });
  // Principais e subcategorias: uma sub pode ser fixa mesmo com a principal variável
  // (ex.: Casa › Condomínio fixa, Casa › Manutenção variável).
  const cats = todas
    .map(c => ({
      id: String(c.id), nome: String(c.nome), fixa: c.natureza === 'fixa',
      pai: String(c.pai || ''), grupo: c.pai ? (nomePor[String(c.pai)] || '') : String(c.nome)
    }))
    .sort((a, b) => a.grupo.localeCompare(b.grupo, 'pt-BR') || (a.pai ? 1 : 0) - (b.pai ? 1 : 0) || a.nome.localeCompare(b.nome, 'pt-BR'));
  const contas = listContas()
    .filter(c => appAtivo_(c.ativo) && c.tipo !== 'emprestimo')
    .map(c => ({ id: String(c.id), nome: String(c.nome), tipo: String(c.tipo || ''), reserva: Utils.toBool(c.reserva) }));
  return { categorias: cats, contas: contas, meta_poupanca: gMetaPoupanca_() };
}

/** cfg: { fixas: [ids de categorias, principais ou subs], reservas: [ids de contas], meta_poupanca: número } */
function appSalvarIndicadores(cfg) {
  cfg = cfg || {};
  Init.ensureAllSheets();
  const fixas = {}; (cfg.fixas || []).forEach(id => { fixas[String(id)] = true; });
  const reservas = {}; (cfg.reservas || []).forEach(id => { reservas[String(id)] = true; });

  const patchCats = {};
  listCategorias().filter(c => c.tipo === 'despesa').forEach(c => {
    const nova = fixas[String(c.id)] ? 'fixa' : (c.pai ? '' : 'variavel');
    if (c.natureza !== nova) patchCats[String(c.id)] = { natureza: nova };
  });
  if (Object.keys(patchCats).length) DB.batchUpdate(SHEET_CATEGORIAS, patchCats);

  const patchContas = {};
  listContas().forEach(c => {
    const nova = !!reservas[String(c.id)];
    if (Utils.toBool(c.reserva) !== nova) patchContas[String(c.id)] = { reserva: nova };
  });
  if (Object.keys(patchContas).length) DB.batchUpdate(SHEET_CONTAS, patchContas);

  const meta = Number(cfg.meta_poupanca);
  if (meta > 0 && meta < 100) PropertiesService.getScriptProperties().setProperty('META_POUPANCA', String(Math.round(meta)));
  return { ok: true };
}

/* ============================================================================
 * Revisar e editar em lote
 * ========================================================================== */

/**
 * Itens da fila de revisão: opcionalmente troca a categoria (e aprende a regra)
 * e confirma os que têm conta ou cartão.
 */
function appRevisarLote(ids, opcoes) {
  opcoes = opcoes || {};
  const set = {};
  (ids || []).forEach(id => { set[String(id)] = true; });
  const hoje = Utils.today();
  const patch = {};
  let confirmados = 0, pulados = 0, tipoDiferente = 0;
  const aprendidos = [];
  const cat = opcoes.categoria ? listCategorias().find(c => String(c.id) === String(opcoes.categoria)) : null;
  DB.readAllFresh(SHEET_LANCAMENTOS).forEach(l => {
    if (!set[String(l.id)] || l.status !== 'revisar') return;
    const p = {};
    // Categoria de despesa só vai para despesa; de receita, só para receita
    const tipo = (Number(l.valor) || 0) >= 0 ? 'receita' : 'despesa';
    if (cat && cat.tipo !== tipo) tipoDiferente++;
    else if (cat) {
      if (String(l.categoria) !== String(opcoes.categoria)) {
        const a = appAprender_(l.descricao, opcoes.categoria, l.categoria || '');
        if (a) aprendidos.push(a);
      }
      p.categoria = String(opcoes.categoria);
    }
    if (opcoes.confirmar) {
      if (l.conta || l.cartao) { p.status = l.data > hoje ? 'agendado' : 'confirmado'; p.conciliado = false; confirmados++; }
      else pulados++;
    }
    if (Object.keys(p).length) patch[String(l.id)] = p;
  });
  const n = Object.keys(patch).length ? DB.batchUpdate(SHEET_LANCAMENTOS, patch) : 0;
  return { ok: true, alterados: n, confirmados: confirmados, pulados: pulados, tipo_diferente: tipoDiferente, aprendidos: aprendidos };
}

/** Lançamentos selecionados na tabela: categoria e/ou situação. */
function appEditarLote(ids, mudancas) {
  mudancas = mudancas || {};
  ids = (ids || []).map(String);
  if (mudancas.status && APP_STATUS_.indexOf(mudancas.status) !== -1) {
    updateLancamentosBatch(ids, { status: mudancas.status });
  }
  let pulados = 0;
  if (mudancas.categoria) {
    // Só nos lançamentos do mesmo tipo da categoria (e nunca em transferências)
    const cat = listCategorias().find(c => String(c.id) === String(mudancas.categoria));
    if (!cat) throw new Error('Categoria não encontrada.');
    const set = {}; ids.forEach(id => { set[id] = true; });
    const alvo = [];
    DB.readAll(SHEET_LANCAMENTOS).forEach(l => {
      if (!set[String(l.id)]) return;
      const tipo = (Number(l.valor) || 0) >= 0 ? 'receita' : 'despesa';
      if (l.transferencia_id || tipo !== cat.tipo) { pulados++; return; }
      alvo.push(String(l.id));
    });
    if (alvo.length) updateLancamentosBatch(alvo, { categoria: String(cat.id) });
  }
  return { ok: true, count: ids.length - pulados, pulados: pulados };
}

function appExcluirLote(ids) {
  return deleteLancamentosBatch((ids || []).map(String));
}

/* ============================================================================
 * Lançamentos do mês em tabela (com saldo das contas no fim de cada dia)
 * ========================================================================== */

function appMovimentos(ano, mes) {
  const itens = appListar(ano, mes);
  const saldos = {};
  try {
    appProjecao_(Number(ano), Number(mes)).pontos.forEach(p => { saldos[p.data] = p.saldo; });
  } catch (e) { /* sem contas: sem coluna de saldo */ }
  return { itens: itens, saldos: saldos };
}
