/**
 * App.js — funções do web app novo (celular primeiro): Início com a fila de
 * revisão, lançamento rápido com IA, lista do mês e painel.
 *
 * Todas começam com "app" para não colidir com as do app clássico nem com as que
 * o bot chama pela biblioteca FF.
 */

const APP_TIPOS_CAIXA_ = ['corrente', 'poupanca', 'vale', 'dinheiro', 'outra'];
const APP_STATUS_ = ['pendente', 'agendado', 'confirmado', 'conciliado', 'revisar'];
const APP_PRIORIDADE_APRENDIDA_ = 10; // igual ao bot: regra aprendida vale mais que as gerais

function appAtivo_(v) {
  return v === '' || v === null || v === undefined || Utils.toBool(v);
}

function appContasCaixa_() {
  return listContas().filter(c => appAtivo_(c.ativo) && APP_TIPOS_CAIXA_.indexOf(c.tipo || 'corrente') !== -1);
}

function appCartoesAtivos_() {
  return listCartoes().filter(c => appAtivo_(c.ativo));
}

function appDiaMais_(iso, dias) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + dias);
  return Utils.formatDate(d);
}

function appArred_(v) { return Math.round((Number(v) || 0) * 100) / 100; }

/* ============================================================================
 * Quem está usando
 * ========================================================================== */

function appUsuarios_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty('USUARIOS_APP');
    const obj = raw ? JSON.parse(raw) : {};
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) {
    return {};
  }
}

/** Nomes que já aparecem na coluna "quem" (bot e app). */
function appNomesConhecidos_(lancs) {
  const set = {};
  (lancs || DB.readAll(SHEET_LANCAMENTOS)).forEach(l => { if (l.quem) set[String(l.quem)] = true; });
  const usuarios = appUsuarios_();
  Object.keys(usuarios).forEach(k => { if (usuarios[k]) set[usuarios[k]] = true; });
  return Object.keys(set).sort();
}

/** Nome de quem está no app: USUARIOS_APP {email: nome}; senão, o único nome já usado. */
function appQuem_(lancs) {
  const email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  const usuarios = appUsuarios_();
  if (email && usuarios[email]) return usuarios[email];
  const nomes = appNomesConhecidos_(lancs);
  return nomes.length === 1 ? nomes[0] : '';
}

/** Grava o nome de quem está usando (tela Mais). */
function appDefinirNome(nome) {
  nome = String(nome || '').trim().slice(0, 40);
  if (!nome) throw new Error('Escreva um nome.');
  const email = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email) throw new Error('Não consegui identificar sua conta Google.');
  const usuarios = appUsuarios_();
  usuarios[email] = nome;
  PropertiesService.getScriptProperties().setProperty('USUARIOS_APP', JSON.stringify(usuarios));
  return { nome: nome };
}

/* ============================================================================
 * Carga inicial
 * ========================================================================== */

/** Cadastros para os seletores do app (contas, cartões, categorias, nomes). */
function appBoot() {
  const lancs = DB.readAll(SHEET_LANCAMENTOS);
  const cats = listCategorias();
  const porId = {};
  cats.forEach(c => { porId[String(c.id)] = c; });

  const contas = listContas()
    .filter(c => appAtivo_(c.ativo))
    .map(c => ({ id: String(c.id), nome: String(c.nome), tipo: String(c.tipo || 'corrente') }));
  const cartoes = appCartoesAtivos_().map(c => ({
    id: String(c.id), nome: String(c.nome),
    conta_pagamento: String(c.conta_pagamento || ''),
    dia_fechamento: Number(c.dia_fechamento) || 0,
    dia_vencimento: Number(c.dia_vencimento) || 0
  }));
  const categorias = cats
    .filter(c => c.tipo === 'despesa' || c.tipo === 'receita')
    .map(c => {
      const pai = c.pai ? porId[String(c.pai)] : null;
      return {
        id: String(c.id), nome: String(c.nome), tipo: String(c.tipo),
        pai: c.pai ? String(c.pai) : '',
        caminho: pai ? String(pai.nome) + ' › ' + String(c.nome) : String(c.nome)
      };
    })
    .sort((a, b) => a.caminho.localeCompare(b.caminho, 'pt-BR'));

  let urlApp = '';
  try { urlApp = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  let urlPlanilha = '';
  try { urlPlanilha = DB.getSpreadsheet().getUrl(); } catch (e) {}

  return {
    hoje: Utils.today(),
    email: Session.getActiveUser().getEmail(),
    quem: appQuem_(lancs),
    nomes: appNomesConhecidos_(lancs),
    contas: contas,
    cartoes: cartoes,
    categorias: categorias,
    ia_configurada: !!PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY'),
    url_app: urlApp,
    url_planilha: urlPlanilha
  };
}

/* ============================================================================
 * Início
 * ========================================================================== */

function appItem_(l) {
  return {
    id: String(l.id),
    data: String(l.data || ''),
    descricao: String(l.descricao || ''),
    valor: Number(l.valor) || 0,
    conta: String(l.conta || ''),
    cartao: String(l.cartao || ''),
    categoria: String(l.categoria || ''),
    status: String(l.status || 'pendente'),
    origem: String(l.origem || ''),
    quem: String(l.quem || ''),
    observacao: String(l.observacao || ''),
    transferencia: !!l.transferencia_id,
    serie: !!l.recorrencia_id,
    parcela: (l.parcela_atual && l.parcela_total) ? (l.parcela_atual + '/' + l.parcela_total) : ''
  };
}

/** Faturas de cartão que vencem entre `de` e `ate` e ainda não foram pagas. */
function appFaturasAPagar_(de, ate) {
  const meses = [];
  const ini = new Date(de + 'T12:00:00');
  const fim = new Date(ate + 'T12:00:00');
  const cur = new Date(ini.getFullYear(), ini.getMonth(), 1);
  while (cur <= fim) {
    meses.push({ ano: cur.getFullYear(), mes: cur.getMonth() + 1 });
    cur.setMonth(cur.getMonth() + 1);
  }
  const itens = [];
  appCartoesAtivos_().forEach(c => {
    meses.forEach(m => {
      let f;
      try { f = getFatura(c.id, m.ano, m.mes); } catch (e) { return; }
      const venc = f.ciclo && f.ciclo.vencimento;
      if (!venc || venc < de || venc > ate) return;
      if (f.status === 'paga' || Math.abs(f.total) < 0.01 || f.total > 0) return;
      const falta = f.status === 'parcial' ? -Number(f.restante) : f.total;
      itens.push({
        id: '', fatura: true, cartao: String(c.id), data: venc, ano: m.ano, mes: m.mes,
        descricao: 'Fatura ' + c.nome + (f.status === 'parcial' ? ' (restante)' : ''), valor: appArred_(falta), status: f.status
      });
    });
  });
  return itens;
}

/**
 * Saldo dia a dia do mês nas contas de caixa, incluindo o que está previsto
 * (a pagar, agendado, recorrências e faturas a pagar).
 */
function appProjecao_(ano, mes) {
  const contas = appContasCaixa_();
  const cartoes = appCartoesAtivos_();
  const r = Utils.monthRange(ano, mes);
  if (contas.length === 0) return { pontos: [], inicio: 0, fim: 0 };
  const view = getMovimentacoesView(ano, mes,
    contas.map(c => String(c.id)), APP_STATUS_, cartoes.map(c => String(c.id)));

  const contaPorId = {};
  contas.forEach(c => { contaPorId[String(c.id)] = c; });
  // Total das contas e, separado, cada conta (para o filtro por conta na tela de lançamentos)
  const porDia = {}, porDiaConta = {};
  (view.lancamentos_contas || []).forEach(l => {
    if (l._virtual && !l._fatura_cartao_id) return; // "restante de orçamento" não entra
    if (!l._virtual && Utils.antesDoMarco(l, contaPorId[String(l.conta)])) return; // já dentro do saldo inicial
    const v = Number(l.valor) || 0;
    porDia[l.data] = (porDia[l.data] || 0) + v;
    const k = String(l.conta || '');
    if (!k) return;
    porDiaConta[k] = porDiaConta[k] || {};
    porDiaConta[k][l.data] = (porDiaConta[k][l.data] || 0) + v;
  });
  const anterior = view.saldo_anterior_por_conta || {};
  let saldo = Number(view.saldo_anterior_contas) || 0;
  const inicio = saldo;
  const pontos = [];
  const porConta = {};
  const corrente = {};
  contas.forEach(c => { const k = String(c.id); corrente[k] = Number(anterior[k]) || 0; porConta[k] = {}; });
  let d = r.start;
  while (d <= r.end) {
    saldo += porDia[d] || 0;
    pontos.push({ data: d, saldo: appArred_(saldo) });
    Object.keys(corrente).forEach(k => {
      corrente[k] += (porDiaConta[k] && porDiaConta[k][d]) || 0;
      porConta[k][d] = appArred_(corrente[k]);
    });
    d = appDiaMais_(d, 1);
  }
  return { pontos: pontos, porConta: porConta, inicio: appArred_(inicio), fim: pontos.length ? pontos[pontos.length - 1].saldo : inicio };
}

function appInicio() {
  const hoje = Utils.today();
  const ano = Number(hoje.slice(0, 4)), mes = Number(hoje.slice(5, 7));
  const r = Utils.monthRange(ano, mes);
  // Direto da planilha: o bot grava por outro script e o cache daqui não sabe.
  const lancs = DB.readAllFresh(SHEET_LANCAMENTOS);

  // Saldo nas contas de caixa (o que já aconteceu)
  const caixaIds = {};
  appContasCaixa_().forEach(c => { caixaIds[String(c.id)] = true; });
  const contas = getSaldosContas()
    .filter(s => caixaIds[String(s.id)])
    .map(s => ({ id: String(s.id), nome: s.nome, saldo: appArred_(s.confirmado) }));
  const saldo = appArred_(contas.reduce((t, c) => t + c.saldo, 0));

  // Entrou e saiu no mês (realizado, sem transferências)
  let entrou = 0, saiu = 0;
  lancs.forEach(l => {
    if (l.data < r.start || l.data > r.end || l.transferencia_id) return;
    if (!Utils.statusRealizado(l.status)) return;
    const v = Number(l.valor) || 0;
    if (v > 0) entrou += v; else saiu += -v;
  });

  // Quanto ainda deve mexer no caixa até o fim do mês
  let previsto = 0;
  try {
    const proj = appProjecao_(ano, mes);
    const ponto = proj.pontos.find(p => p.data === hoje);
    if (ponto) previsto = appArred_(proj.fim - ponto.saldo);
  } catch (e) { previsto = 0; }

  // Fila de revisão
  const revisar = lancs
    .filter(l => l.status === 'revisar')
    .sort((a, b) => String(b.data).localeCompare(String(a.data)) || String(b.criado_em).localeCompare(String(a.criado_em)))
    .map(appItem_);

  // A pagar/receber: atrasados (até 60 dias) e os próximos 7 dias
  const de = appDiaMais_(hoje, -60), ate = appDiaMais_(hoje, 7);
  const contasPagar = lancs.filter(l => {
    if (l.data < de || l.data > ate || l.transferencia_id || l.cartao) return false;
    if (l.status !== 'pendente' && l.status !== 'agendado') return false;
    return l.data >= hoje || l.status === 'pendente'; // agendado passado = débito automático, já foi
  }).map(l => Object.assign(appItem_(l), { atrasado: l.data < hoje }));
  const faturas = appFaturasAPagar_(appDiaMais_(hoje, -10), ate)
    .map(f => Object.assign(f, { atrasado: f.data < hoje }));
  const proximos = contasPagar.concat(faturas)
    .sort((a, b) => a.data.localeCompare(b.data) || a.valor - b.valor);

  return {
    hoje: hoje,
    saldo: saldo,
    contas: contas,
    mes: { entrou: appArred_(entrou), saiu: appArred_(saiu), previsto: previsto },
    revisar: revisar,
    proximos: proximos
  };
}

/* ============================================================================
 * Lista do mês
 * ========================================================================== */

function appListar(ano, mes) {
  const r = Utils.monthRange(Number(ano), Number(mes));
  return DB.readAllFresh(SHEET_LANCAMENTOS)
    .filter(l => l.data >= r.start && l.data <= r.end)
    .sort((a, b) => String(b.data).localeCompare(String(a.data)) || String(b.criado_em).localeCompare(String(a.criado_em)))
    .map(appItem_);
}

/* ============================================================================
 * Painel do mês
 * ========================================================================== */

function appPainel(ano, mes) {
  ano = Number(ano); mes = Number(mes);
  const hoje = Utils.today();
  const r = Utils.monthRange(ano, mes);
  const lancs = DB.readAllFresh(SHEET_LANCAMENTOS);

  const proj = appProjecao_(ano, mes);
  const futuro = proj.pontos.filter(p => p.data >= hoje);
  const base = futuro.length ? futuro : proj.pontos;
  let menor = null;
  base.forEach(p => { if (!menor || p.saldo < menor.saldo) menor = p; });

  // Receitas e despesas do mês (tudo, inclusive previsto), sem transferências
  let receitas = 0, despesas = 0;
  const porQuem = {}, porCat = {};
  const cats = listCategorias();
  const catPorId = {};
  cats.forEach(c => { catPorId[String(c.id)] = c; });
  lancs.forEach(l => {
    if (l.data < r.start || l.data > r.end || l.transferencia_id) return;
    const v = Number(l.valor) || 0;
    if (v >= 0) { receitas += v; return; }
    despesas += -v;
    const quem = l.quem ? String(l.quem) : '';
    porQuem[quem] = (porQuem[quem] || 0) + -v;
    let cat = catPorId[String(l.categoria)];
    if (cat && cat.pai && catPorId[String(cat.pai)]) cat = catPorId[String(cat.pai)];
    const k = cat ? String(cat.id) : '';
    porCat[k] = (porCat[k] || 0) + -v;
  });

  let orcamentos = [];
  try {
    orcamentos = getOrcamentosProgresso(ano, mes).map(o => ({
      id: o.id, nome: o.nome, orcado: appArred_(o.orcado), consumido: appArred_(o.consumido),
      percentual: o.percentual
    }));
  } catch (e) { orcamentos = []; }

  const quem = Object.keys(porQuem)
    .map(k => ({ nome: k || 'Sem nome', total: appArred_(porQuem[k]), sem_nome: !k }))
    .sort((a, b) => (a.sem_nome - b.sem_nome) || (b.total - a.total));
  const categorias = Object.keys(porCat)
    .map(k => ({ id: k, nome: k ? catPorId[k].nome : 'Sem categoria', total: appArred_(porCat[k]) }))
    .sort((a, b) => b.total - a.total);

  return {
    ano: ano, mes: mes, hoje: hoje,
    projecao: proj.pontos,
    saldo_inicio: proj.inicio,
    saldo_fim: proj.fim,
    menor: menor,
    resumo: { receitas: appArred_(receitas), despesas: appArred_(despesas), resultado: appArred_(receitas - despesas) },
    orcamentos: orcamentos,
    quem: quem,
    categorias: categorias
  };
}

/* ============================================================================
 * Lançar, revisar, confirmar
 * ========================================================================== */

/** Interpreta a frase com a IA e devolve o rascunho (nada é gravado). */
function appInterpretar(texto) {
  return IA.interpretar(texto, appQuem_());
}

/** Até 3 palavras da descrição, sem acento e sem números (igual ao bot). */
function appPalavraChave_(descricao) {
  const palavras = IA.semAcento(String(descricao || '')).toUpperCase()
    .replace(/[^A-Z ]+/g, ' ').trim().split(/\s+/).filter(p => p.length >= 2);
  const chave = palavras.slice(0, 3).join(' ');
  return chave.length >= 3 ? chave : '';
}

/** Se a categoria escolhida difere da sugerida, cria regra para acertar na próxima. */
function appAprender_(descricao, categoria, sugerida) {
  if (!categoria || sugerida === undefined || sugerida === null) return '';
  if (String(categoria) === String(sugerida)) return '';
  if (/sem nome da loja/i.test(descricao)) return '';
  const chave = appPalavraChave_(descricao);
  if (!chave) return '';
  try {
    saveRegraSubstituindo({
      condicao_campo: 'descricao', condicao_operador: 'contains', condicao_valor: chave,
      acao_campo: 'categoria', acao_valor: String(categoria),
      prioridade: APP_PRIORIDADE_APRENDIDA_, ativo: true
    });
    const cat = listCategorias().find(c => String(c.id) === String(categoria));
    return 'Aprendi: "' + chave + '" → ' + (cat ? cat.nome : 'categoria');
  } catch (e) {
    return '';
  }
}

/**
 * Grava um lançamento novo ou editado.
 * dados: { id?, tipo: despesa|receita|transferencia, descricao, valor (positivo), data,
 *          conta, cartao, conta_destino, categoria, status, quem, parcelas, observacao }
 * opcoes: { categoria_sugerida?, origem? }
 */
function appSalvar(dados, opcoes) {
  dados = dados || {};
  opcoes = opcoes || {};
  const valor = Math.abs(Utils.toNumber(dados.valor));
  if (!(valor > 0)) throw new Error('Informe o valor.');
  const data = /^\d{4}-\d{2}-\d{2}$/.test(String(dados.data || '')) ? String(dados.data) : Utils.today();
  let status = APP_STATUS_.indexOf(dados.status) !== -1 ? dados.status : 'confirmado';
  if (status === 'confirmado' && data > Utils.today()) status = 'agendado'; // ainda não aconteceu
  const quem = String(dados.quem || '').trim() || appQuem_();
  const descricao = String(dados.descricao || '').trim().slice(0, 120);
  const tipo = dados.tipo === 'receita' || dados.tipo === 'transferencia' ? dados.tipo : 'despesa';

  // Transferência nova entre duas contas
  if (tipo === 'transferencia') {
    if (dados.id) throw new Error('Para mudar uma transferência, use Movimentações no app clássico.');
    const res = criarTransferencia({
      valor: valor, conta_origem: dados.conta, conta_destino: dados.conta_destino,
      data: data, descricao: descricao || 'Transferência', status: status === 'revisar' ? 'confirmado' : status,
      origem: opcoes.origem || 'app', quem: quem, observacao: dados.observacao || ''
    });
    const ids = DB.readAll(SHEET_LANCAMENTOS)
      .filter(l => l.transferencia_id === res.transferencia_id).map(l => String(l.id));
    return { ok: true, quantidade: 1, ids: ids, aprendido: '' };
  }

  if (!dados.conta && !dados.cartao) throw new Error('Escolha a conta ou o cartão.');
  const registro = {
    data: data,
    descricao: descricao || '(sem descrição)',
    valor: tipo === 'receita' ? valor : -valor,
    conta: dados.cartao ? '' : String(dados.conta || ''),
    cartao: String(dados.cartao || ''),
    categoria: String(dados.categoria || ''),
    status: status,
    quem: quem
  };
  if (dados.observacao !== undefined) registro.observacao = String(dados.observacao || '').slice(0, 300);

  if (dados.id) {
    const atual = getLancamento(dados.id);
    if (!atual) throw new Error('Esse lançamento não existe mais (foi apagado?).');
    if (atual.transferencia_id) throw new Error('Para mudar uma transferência, use Movimentações no app clássico.');
    // Mantém o que o app novo não edita
    const mantido = {
      centro: atual.centro, projeto: atual.projeto, contato: atual.contato, tags: atual.tags,
      parcela_atual: atual.parcela_atual, parcela_total: atual.parcela_total,
      recorrencia_id: atual.recorrencia_id, anexo_url: atual.anexo_url,
      calendar_event_id: atual.calendar_event_id, origem: atual.origem,
      fatura_competencia: (registro.cartao && registro.cartao === String(atual.cartao)) ? atual.fatura_competencia : ''
    };
    if (registro.observacao === undefined) registro.observacao = atual.observacao;
    const salvo = saveLancamento(Object.assign({}, mantido, registro, { id: dados.id }));
    const aprendido = appAprender_(registro.descricao, registro.categoria, opcoes.categoria_sugerida);
    return { ok: true, quantidade: 1, id: String(salvo ? salvo.id : dados.id), ids: [], aprendido: aprendido };
  }

  registro.origem = opcoes.origem || 'app';
  const parcelas = Math.max(1, Math.min(48, Math.floor(Number(dados.parcelas) || 1)));
  let criados;
  if (parcelas > 1) {
    criados = criarParcelamento(registro, parcelas, 1, 'mensal', 1) || [];
  } else {
    criados = [saveLancamento(registro)];
  }
  const aprendido = appAprender_(registro.descricao, registro.categoria, opcoes.categoria_sugerida);
  const ids = criados.filter(Boolean).map(l => String(l.id));
  return { ok: true, quantidade: ids.length, id: ids[0] || '', ids: ids, aprendido: aprendido };
}

/**
 * Confirma vários itens da fila de revisão de uma vez. Só confirma os que estão
 * completos (conta ou cartão escolhido); devolve quantos ficaram de fora.
 */
function appConfirmarTodos(ids) {
  ids = (ids || []).map(String);
  const set = {};
  ids.forEach(id => { set[id] = true; });
  const hoje = Utils.today();
  const patch = {};
  let pulados = 0;
  DB.readAllFresh(SHEET_LANCAMENTOS).forEach(l => {
    if (!set[String(l.id)] || l.status !== 'revisar') return;
    if (!l.conta && !l.cartao) { pulados++; return; }
    patch[String(l.id)] = { status: l.data > hoje ? 'agendado' : 'confirmado', conciliado: false };
  });
  const n = Object.keys(patch).length ? DB.batchUpdate(SHEET_LANCAMENTOS, patch) : 0;
  return { ok: true, confirmados: n, pulados: pulados };
}

/** Marca uma conta a pagar (ou a receber) como paga hoje. */
function appMarcarPago(id) {
  const l = getLancamento(id);
  if (!l) throw new Error('Esse lançamento não existe mais.');
  const salvo = saveLancamento(Object.assign({}, l, { status: 'confirmado' }));
  return { ok: true, id: salvo ? salvo.id : id };
}

/** Desfaz um lançamento recém-criado pelo app (todas as parcelas / as duas pernas). */
function appDesfazer(ids) {
  ids = (ids || []).map(String).filter(Boolean);
  if (!ids.length) return { ok: true, count: 0 };
  return deleteLancamentosBatch(ids);
}

function appExcluir(id) {
  const l = getLancamento(id);
  if (!l) return { ok: true };
  deleteLancamento(id);
  return { ok: true };
}
