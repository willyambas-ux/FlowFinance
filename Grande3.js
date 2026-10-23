/**
 * Grande3.js — tela grande, etapa 3: Configurações e cadastros, Importar extrato,
 * Fechamento (conferir saldo com o banco) e Patrimônio. Com ela o app clássico
 * deixa de ser necessário (continua em /exec?v=classico por segurança).
 */

/* ============================================================================
 * Configurações e cadastros
 * ========================================================================== */

function appConfig() {
  Init.ensureAllSheets();
  const lancs = DB.readAllFresh(SHEET_LANCAMENTOS);
  const usoConta = {}, usoCartao = {}, usoCat = {};
  lancs.forEach(l => {
    if (l.conta) usoConta[l.conta] = (usoConta[l.conta] || 0) + 1;
    if (l.cartao) usoCartao[l.cartao] = (usoCartao[l.cartao] || 0) + 1;
    if (l.categoria) usoCat[l.categoria] = (usoCat[l.categoria] || 0) + 1;
  });
  // Próxima data de cada recorrência = o primeiro lançamento futuro ainda não pago
  const hoje = Utils.today();
  const proximaRec = {};
  lancs.forEach(l => {
    if (!l.recorrencia_id || l.data < hoje || (l.status !== 'pendente' && l.status !== 'agendado')) return;
    const k = String(l.recorrencia_id);
    if (!proximaRec[k] || l.data < proximaRec[k]) proximaRec[k] = l.data;
  });
  const saldos = {};
  getSaldosContas().forEach(s => { saldos[String(s.id)] = s.confirmado; });
  const cats = listCategorias();
  const catNome = {};
  cats.forEach(c => { catNome[String(c.id)] = c.nome; });
  const contaNome = {}, cartaoNome = {};
  listContas().forEach(c => { contaNome[String(c.id)] = c.nome; });
  listCartoes().forEach(c => { cartaoNome[String(c.id)] = c.nome; });

  let auth = [];
  try { auth = listAuthUsers(); } catch (e) { auth = []; }
  let cal = null;
  try { cal = getCalendarSyncInfo(); } catch (e) { cal = null; }

  return {
    email: Session.getActiveUser().getEmail(),
    contas: listContas().map(c => ({
      id: String(c.id), nome: String(c.nome), tipo: String(c.tipo || 'corrente'), banco: String(c.banco || ''),
      saldo_inicial: Number(c.saldo_inicial) || 0, data_saldo_inicial: Utils.dataISO(c.data_saldo_inicial),
      ativo: appAtivo_(c.ativo), reserva: Utils.toBool(c.reserva), saldo: appArred_(saldos[String(c.id)] || 0),
      usos: usoConta[c.id] || 0
    })),
    cartoes: listCartoes().map(c => ({
      id: String(c.id), nome: String(c.nome), conta_pagamento: String(c.conta_pagamento || ''),
      conta_nome: contaNome[String(c.conta_pagamento)] || '', dia_fechamento: Number(c.dia_fechamento) || 0,
      dia_vencimento: Number(c.dia_vencimento) || 0, limite: Number(c.limite) || 0, ativo: appAtivo_(c.ativo),
      usos: usoCartao[c.id] || 0
    })),
    categorias: cats.map(c => ({
      id: String(c.id), nome: String(c.nome), tipo: String(c.tipo || 'despesa'), pai: String(c.pai || ''),
      natureza: String(c.natureza || ''), usos: usoCat[c.id] || 0
    })),
    regras: listRegras().map(r => ({
      id: String(r.id), campo: String(r.condicao_campo || 'descricao'), operador: String(r.condicao_operador || 'contains'),
      valor: String(r.condicao_valor || ''), acao: String(r.acao_campo || 'categoria'), destino: String(r.acao_valor || ''),
      destino_nome: r.acao_campo === 'categoria' ? (catNome[String(r.acao_valor)] || '(categoria apagada)') : String(r.acao_valor || ''),
      prioridade: Number(r.prioridade) || 0, ativo: Utils.toBool(r.ativo)
    })).sort((a, b) => (b.prioridade - a.prioridade) || a.valor.localeCompare(b.valor, 'pt-BR')),
    recorrencias: listRecorrencias().map(r => ({
      id: String(r.id), descricao: String(r.descricao || ''), valor: Number(r.valor) || 0,
      conta: String(r.conta || ''), cartao: String(r.cartao || ''),
      pagamento_nome: r.cartao ? (cartaoNome[String(r.cartao)] || '') : (contaNome[String(r.conta)] || ''),
      categoria: String(r.categoria || ''), categoria_nome: catNome[String(r.categoria)] || '',
      periodicidade: String(r.periodicidade || 'mensal'), intervalo: Number(r.intervalo) || 1, dia: Number(r.dia) || 1,
      proxima_data: proximaRec[String(r.id)] || String(r.proxima_data || '').slice(0, 10), ativo: Utils.toBool(r.ativo)
    })).sort((a, b) => (b.ativo - a.ativo) || a.descricao.localeCompare(b.descricao, 'pt-BR')),
    usuarios_app: appUsuarios_(),
    auth: auth,
    timeout: (function () { try { return getAuthStatus().timeout_minutes; } catch (e) { return 15; } })(),
    calendario: cal
  };
}

function appSalvarConta(d) {
  d = d || {};
  if (!String(d.nome || '').trim()) throw new Error('Dê um nome à conta.');
  const atual = d.id ? listContas().find(c => String(c.id) === String(d.id)) : null;
  const dados = Object.assign({}, atual || {}, {
    id: d.id || undefined, nome: d.nome, tipo: d.tipo || 'corrente', banco: d.banco || '',
    saldo_inicial: Utils.toNumber(d.saldo_inicial), data_saldo_inicial: d.data_saldo_inicial || Utils.today(),
    ativo: d.ativo !== false
  });
  const salvo = saveConta(dados);
  DB.update(SHEET_CONTAS, salvo.id, { reserva: !!d.reserva });
  return { ok: true, id: String(salvo.id) };
}

function appSalvarCartao(d) {
  d = d || {};
  if (!String(d.nome || '').trim()) throw new Error('Dê um nome ao cartão.');
  const atual = d.id ? listCartoes().find(c => String(c.id) === String(d.id)) : null;
  const salvo = saveCartao(Object.assign({}, atual || {}, {
    id: d.id || undefined, nome: d.nome, conta_pagamento: d.conta_pagamento || '',
    dia_fechamento: Number(d.dia_fechamento) || 1, dia_vencimento: Number(d.dia_vencimento) || 1,
    limite: Utils.toNumber(d.limite), ativo: d.ativo !== false
  }));
  return { ok: true, id: String(salvo.id) };
}

function appSalvarCategoria(d) {
  d = d || {};
  if (!String(d.nome || '').trim()) throw new Error('Dê um nome à categoria.');
  if (d.pai && d.id && String(d.pai) === String(d.id)) throw new Error('A categoria não pode ser filha dela mesma.');
  if (d.pai) {
    const pai = listCategorias().find(c => String(c.id) === String(d.pai));
    if (!pai) throw new Error('Categoria-pai não encontrada.');
    if (pai.pai) throw new Error('Use só dois níveis: escolha uma categoria principal como pai.');
    d.tipo = pai.tipo;
  }
  const atual = d.id ? listCategorias().find(c => String(c.id) === String(d.id)) : null;
  const salvo = saveCategoria(Object.assign({}, atual || {}, { id: d.id || undefined, nome: d.nome, pai: d.pai || '', tipo: d.tipo || 'despesa' }));
  // Principal: fixa/variavel. Subcategoria: 'fixa' ou vazio (herda da principal).
  DB.update(SHEET_CATEGORIAS, salvo.id, { natureza: d.natureza === 'fixa' ? 'fixa' : (d.pai ? '' : 'variavel') });
  // Filhas acompanham o tipo do pai
  if (atual && !d.pai) {
    const patch = {};
    listCategorias().filter(c => String(c.pai) === String(salvo.id) && c.tipo !== salvo.tipo).forEach(c => { patch[String(c.id)] = { tipo: salvo.tipo }; });
    if (Object.keys(patch).length) DB.batchUpdate(SHEET_CATEGORIAS, patch);
  }
  return { ok: true, id: String(salvo.id) };
}

/**
 * Exclui conta, cartão ou categoria só se nada usa. Com uso, a conta/cartão
 * deve ser desativada e a categoria pode ser trocada por outra (mover_para).
 */
function appExcluirCadastro(tipo, id, moverPara) {
  id = String(id);
  const lancs = DB.readAllFresh(SHEET_LANCAMENTOS);
  if (tipo === 'conta') {
    const n = lancs.filter(l => String(l.conta) === id).length;
    if (n) throw new Error('Esta conta tem ' + n + ' lançamentos. Desative em vez de excluir.');
    if (listCartoes().some(c => String(c.conta_pagamento) === id)) throw new Error('Um cartão é pago por esta conta. Troque no cartão antes.');
    deleteConta(id);
  } else if (tipo === 'cartao') {
    const n = lancs.filter(l => String(l.cartao) === id).length;
    if (n) throw new Error('Este cartão tem ' + n + ' lançamentos. Desative em vez de excluir.');
    deleteCartao(id);
  } else if (tipo === 'categoria') {
    if (listCategorias().some(c => String(c.pai) === id)) throw new Error('Esta categoria tem subcategorias. Mova ou exclua as subcategorias antes.');
    const usados = lancs.filter(l => String(l.categoria) === id).map(l => String(l.id));
    if (usados.length && !moverPara) throw new Error('Esta categoria tem ' + usados.length + ' lançamentos. Escolha para qual categoria movê-los.');
    if (usados.length) updateLancamentosBatch(usados, { categoria: String(moverPara) });
    // Regras e orçamentos que apontavam para ela
    listRegras().filter(r => r.acao_campo === 'categoria' && String(r.acao_valor) === id).forEach(r => {
      if (moverPara) DB.update(SHEET_REGRAS, r.id, { acao_valor: String(moverPara) }); else DB.remove(SHEET_REGRAS, r.id);
    });
    listOrcamentos().filter(o => o.tipo === 'categoria' && String(o.referencia) === id).forEach(o => DB.remove(SHEET_ORCAMENTOS, o.id));
    deleteCategoria(id);
    return { ok: true, movidos: usados.length };
  } else {
    throw new Error('Tipo desconhecido.');
  }
  return { ok: true };
}

/** Regra simples: descrição contém X → categoria. */
function appSalvarRegra(d) {
  d = d || {};
  const valor = String(d.valor || '').trim();
  if (!valor) throw new Error('Escreva o texto que a descrição deve conter.');
  if (!d.destino) throw new Error('Escolha a categoria.');
  saveRegraSubstituindo({
    id: d.id || undefined,
    condicao_campo: 'descricao', condicao_operador: d.operador || 'contains',
    condicao_valor: IA.semAcento(valor).toUpperCase(),
    acao_campo: 'categoria', acao_valor: String(d.destino),
    prioridade: Number(d.prioridade) || 0, ativo: d.ativo !== false
  });
  return { ok: true };
}

function appExcluirRegra(id) {
  deleteRegra(id);
  return { ok: true };
}

/** Lançamentos futuros ainda não pagos de uma recorrência. */
function gFuturosRecorrencia_(id) {
  const hoje = Utils.today();
  return DB.readAll(SHEET_LANCAMENTOS).filter(l =>
    String(l.recorrencia_id) === String(id) && l.data >= hoje && (l.status === 'pendente' || l.status === 'agendado')
  ).sort((a, b) => String(a.data).localeCompare(String(b.data)));
}

/**
 * Recorrência (conta fixa, salário, assinatura). valor positivo; tipo diz o sinal.
 * Se só mudar valor/categoria/conta, os lançamentos futuros não pagos são atualizados.
 * Se mudar a data (dia, periodicidade ou próxima), eles são refeitos a partir da nova data.
 */
function appSalvarRecorrencia(d) {
  d = d || {};
  if (!String(d.descricao || '').trim()) throw new Error('Dê uma descrição.');
  const v = Math.abs(Utils.toNumber(d.valor));
  if (!(v > 0)) throw new Error('Informe o valor.');
  if (!d.conta && !d.cartao) throw new Error('Escolha a conta ou o cartão.');
  const proxima = /^\d{4}-\d{2}-\d{2}$/.test(String(d.proxima_data || '')) ? String(d.proxima_data) : Utils.today();
  const atual = d.id ? listRecorrencias().find(r => String(r.id) === String(d.id)) : null;
  const futuros = atual ? gFuturosRecorrencia_(atual.id) : [];
  const proximaAtual = futuros.length ? futuros[0].data : String(atual ? atual.proxima_data : '').slice(0, 10);
  const mudouData = atual && (
    String(atual.periodicidade || 'mensal') !== String(d.periodicidade || 'mensal') ||
    Number(atual.dia) !== Number(d.dia) || proximaAtual !== proxima
  );
  if (mudouData && futuros.length) deleteLancamentosBatch(futuros.map(l => String(l.id)));

  const salvo = saveRecorrencia(Object.assign({}, atual || {}, {
    id: d.id || undefined, descricao: d.descricao, valor: d.tipo === 'receita' ? v : -v,
    conta: d.cartao ? '' : d.conta, cartao: d.cartao || '', categoria: d.categoria || '',
    periodicidade: d.periodicidade || 'mensal', intervalo: 1, dia: Number(d.dia) || 1,
    proxima_data: (atual && !mudouData) ? atual.proxima_data : proxima,
    ativo: d.ativo !== false, total_ocorrencias: atual ? atual.total_ocorrencias : 0
  }));

  let atualizados = 0;
  if (atual && !mudouData && futuros.length) {
    const patch = {};
    futuros.forEach(l => {
      patch[String(l.id)] = { descricao: salvo.descricao, valor: salvo.valor, conta: salvo.conta, cartao: salvo.cartao, categoria: salvo.categoria };
    });
    atualizados = DB.batchUpdate(SHEET_LANCAMENTOS, patch);
  }
  if (atual && d.ativo === false && futuros.length && !mudouData) {
    // Desativada: some com o que ainda não foi pago
    deleteLancamentosBatch(futuros.map(l => String(l.id)));
    atualizados = 0;
  }
  return { ok: true, id: String(salvo.id), futuros_atualizados: atualizados, refeitos: !!mudouData };
}

/** Exclui a recorrência e os lançamentos futuros dela ainda não pagos. */
function appExcluirRecorrencia(id) {
  const futuros = gFuturosRecorrencia_(id).map(l => String(l.id));
  if (futuros.length) deleteLancamentosBatch(futuros);
  deleteRecorrencia(id);
  return { ok: true, futuros_removidos: futuros.length };
}

/** Nome de cada conta Google no app (quem lançou). */
function appSalvarPessoa(email, nome) {
  email = String(email || '').trim().toLowerCase();
  nome = String(nome || '').trim().slice(0, 40);
  if (!email || email.indexOf('@') === -1) throw new Error('E-mail inválido.');
  const u = appUsuarios_();
  if (nome) u[email] = nome; else delete u[email];
  PropertiesService.getScriptProperties().setProperty('USUARIOS_APP', JSON.stringify(u));
  return { ok: true };
}

/* ============================================================================
 * Importar extrato (CSV ou OFX)
 * ========================================================================== */

/** Lê o arquivo e devolve as linhas com categoria pelas regras e duplicados marcados. */
function appPreviewImportacao(texto, tipo, id) {
  if (!String(texto || '').trim()) throw new Error('O arquivo está vazio.');
  if (!id) throw new Error('Escolha a conta ou o cartão.');
  const r = previewImportacao(texto, { tipo: tipo === 'cartao' ? 'cartao' : 'conta', id: String(id) });
  const linhas = (r.lancs || []).map((l, i) => ({
    i: i, data: String(l.data || ''), descricao: String(l.descricao || ''), valor: Number(l.valor) || 0,
    categoria: String(l.categoria || ''), parcela_atual: l.parcela_atual || '', parcela_total: l.parcela_total || '',
    pagamento: !!l._pagamento, duplicado: !!l._duplicado,
    dup: (l._dup_existentes || []).slice(0, 1).map(x => x.descricao + ' · ' + x.data + (x.status ? ' · ' + x.status : ''))[0] || ''
  })).filter(l => l.data && l.valor);

  // Possível duplicado: mesmo valor na mesma conta/cartão com até 3 dias de diferença
  // (o banco escreve "NORDESTAO 7424" e você lançou "Nordestão")
  const campo = tipo === 'cartao' ? 'cartao' : 'conta';
  const existentes = DB.readAll(SHEET_LANCAMENTOS).filter(l => String(l[campo]) === String(id));
  const dia = (iso) => new Date(String(iso).slice(0, 10) + 'T12:00:00').getTime() / 86400000;
  const usados = {};
  linhas.forEach(l => {
    if (l.duplicado) return;
    const achado = existentes.find(e => !usados[e.id] && Math.abs((Number(e.valor) || 0) - l.valor) < 0.005 && Math.abs(dia(e.data) - dia(l.data)) <= 3);
    if (achado) {
      usados[achado.id] = true;
      l.duplicado = true;
      l.parecido = true;
      l.dup = String(achado.descricao) + ' · ' + String(achado.data).slice(0, 10) + (achado.status ? ' · ' + achado.status : '');
    }
  });
  return { formato: r.formato || '', linhas: linhas, erros: r.erros || [], aviso: r.aviso || '' };
}

/**
 * Importa as linhas escolhidas. O que já aconteceu entra como "revisar" (vai para
 * a fila); datas futuras (parcelas) entram como agendado.
 */
function appImportar(tipo, id, linhas) {
  const hoje = Utils.today();
  const lancs = (linhas || []).map(l => ({
    data: l.data, descricao: l.descricao, valor: Number(l.valor) || 0, categoria: l.categoria || '',
    parcela_atual: l.parcela_atual || '', parcela_total: l.parcela_total || '',
    status: l.data > hoje ? 'agendado' : 'revisar',
    quem: appQuem_()
  }));
  if (!lancs.length) throw new Error('Nenhuma linha marcada para importar.');
  return importarLancamentos({ tipo: tipo === 'cartao' ? 'cartao' : 'conta', id: String(id), lancs: lancs });
}

/* ============================================================================
 * Fechamento: conferir o saldo do sistema com o do banco
 * ========================================================================== */

function appFechamento() {
  const hoje = Utils.today();
  DB.readAllFresh(SHEET_LANCAMENTOS);
  const fechs = listFechamentos();
  const contas = listContas().filter(c => appAtivo_(c.ativo) && c.tipo !== 'emprestimo').map(c => {
    const meus = fechs.filter(f => String(f.conta) === String(c.id)).sort((a, b) => String(b.data).localeCompare(String(a.data)));
    const ult = meus[0];
    return {
      id: String(c.id), nome: String(c.nome), tipo: String(c.tipo || ''),
      saldo_sistema: appArred_(getSaldoContaNaData(c.id, hoje)),
      ultimo: ult ? { data: String(ult.data).slice(0, 10), saldo_real: appArred_(ult.saldo_real) } : null
    };
  });
  const nomes = {};
  contas.forEach(c => { nomes[c.id] = c.nome; });
  const historico = fechs.slice().sort((a, b) => String(b.data).localeCompare(String(a.data))).slice(0, 20).map(f => ({
    id: String(f.id), data: String(f.data).slice(0, 10), conta: nomes[String(f.conta)] || '—', saldo_real: appArred_(f.saldo_real)
  }));
  return { hoje: hoje, contas: contas, historico: historico };
}

function appSaldoNaData(contaId, data) {
  return appArred_(getSaldoContaNaData(contaId, data || Utils.today()));
}

function appFechar(contaId, data, saldoReal, ajustar) {
  const r = fecharPosicao(contaId, data || Utils.today(), saldoReal, !!ajustar);
  return { ok: true, diferenca: r.diferenca, ajuste_criado: r.ajuste_criado, saldo_sistema: appArred_(r.saldo_sistema) };
}

/* ============================================================================
 * Patrimônio (ponte até a etapa de ativos)
 * ========================================================================== */

function appPatrimonio() {
  const hoje = Utils.today();
  DB.readAllFresh(SHEET_LANCAMENTOS);
  const b = getBalancoPatrimonial(hoje);
  const grupos = {};
  const NOMES = { corrente: 'Contas correntes', poupanca: 'Poupança', vale: 'Vale-alimentação/refeição', dinheiro: 'Dinheiro',
    investimento: 'Investimentos', emprestimo: 'Empréstimos', outra: 'Outras contas' };
  b.contas.forEach(c => {
    const k = c.tipo || 'outra';
    if (!grupos[k]) grupos[k] = { tipo: k, nome: NOMES[k] || k, total: 0, contas: [] };
    grupos[k].total += c.saldo;
    grupos[k].contas.push({ nome: c.nome, saldo: appArred_(c.saldo) });
  });
  const ordem = ['corrente', 'poupanca', 'vale', 'dinheiro', 'investimento', 'outra', 'emprestimo'];
  const lista = Object.keys(grupos).sort((a, b2) => ordem.indexOf(a) - ordem.indexOf(b2)).map(k => {
    grupos[k].total = appArred_(grupos[k].total);
    return grupos[k];
  });
  const cartoes = b.cartoes.filter(c => Math.abs(c.saldo) >= 0.01).map(c => ({ nome: c.nome, saldo: appArred_(c.saldo) }));

  // Patrimônio líquido no fim de cada um dos últimos 12 meses
  const ha = Number(hoje.slice(0, 4)), hm = Number(hoje.slice(5, 7));
  const ROT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const evolucao = [];
  for (let i = 11; i >= 0; i--) {
    const m = gMesMais_(ha, hm, -i);
    const fim = i === 0 ? hoje : Utils.monthRange(m.ano, m.mes).end;
    const x = getBalancoPatrimonial(fim);
    evolucao.push({ rotulo: ROT[m.mes - 1] + (m.ano !== ha ? '/' + String(m.ano).slice(2) : ''), pl: appArred_(x.patrimonio_liquido) });
  }
  return {
    data: hoje, ativos: appArred_(b.ativos), passivos: appArred_(b.passivos), liquido: appArred_(b.patrimonio_liquido),
    grupos: lista, cartoes: cartoes, evolucao: evolucao,
    variacao_12m: evolucao.length ? appArred_(evolucao[evolucao.length - 1].pl - evolucao[0].pl) : 0
  };
}
