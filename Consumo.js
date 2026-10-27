/**
 * Consumo.gs — luz, água e gás da casa: contas mês a mês e leituras do medidor.
 *
 * Aba Consumo, um registro por linha:
 *   tipo = 'fatura'  → a conta do mês (referencia YYYY-MM, consumo, valor, vencimento)
 *   tipo = 'leitura' → foto/anotação do medidor (data, leitura acumulada do relógio)
 * servico = luz | agua | gas
 *
 * A água vem dentro do boleto do condomínio (só o valor); o volume sai das
 * leituras do hidrômetro do andar, que o bot recebe por foto.
 */
const SHEET_CONSUMO = 'Consumo';

const SERVICOS_CONSUMO = {
  luz:  { nome: 'Luz',  unidade: 'kWh', categoria: 'Luz' },
  agua: { nome: 'Água', unidade: 'm³',  categoria: 'Água' },
  gas:  { nome: 'Gás',  unidade: 'm³',  categoria: 'Gás' }
};

function garantirAbaConsumo_() {
  if (!DB.getSpreadsheet().getSheetByName(SHEET_CONSUMO)) Init.ensureAllSheets();
}

function numConsumo_(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Utils.toNumber(v);
  return isFinite(n) ? n : null;
}

/** "2026-10", Date ou "2026-10-01" → "2026-10". */
function refConsumo_(v) {
  const s = Utils.dataISO ? Utils.dataISO(v) : String(v || '');
  const m = String(s || v || '').replace(/^'/, '').match(/^(\d{4})-(\d{2})/);
  return m ? m[1] + '-' + m[2] : '';
}

function dataConsumo_(v) {
  const s = Utils.dataISO ? Utils.dataISO(v) : String(v || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? String(s) : '';
}

function servicoConsumo_(s) {
  const t = String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/agua|hidro/.test(t)) return 'agua';
  if (/gas|glp/.test(t)) return 'gas';
  if (/luz|energia|eletric/.test(t)) return 'luz';
  return SERVICOS_CONSUMO[t] ? t : '';
}

/** Registros normalizados, mais antigos primeiro. */
function listConsumo() {
  if (!DB.getSpreadsheet().getSheetByName(SHEET_CONSUMO)) return [];
  return DB.readAll(SHEET_CONSUMO).map(r => ({
    id: String(r.id || ''),
    servico: servicoConsumo_(r.servico),
    tipo: String(r.tipo || '') === 'leitura' ? 'leitura' : 'fatura',
    referencia: refConsumo_(r.referencia),
    data: dataConsumo_(r.data),
    leitura: numConsumo_(r.leitura),
    consumo: numConsumo_(r.consumo),
    unidade: String(r.unidade || ''),
    dias: numConsumo_(r.dias),
    valor: numConsumo_(r.valor),
    vencimento: dataConsumo_(r.vencimento),
    pago_em: dataConsumo_(r.pago_em),
    lancamento_id: String(r.lancamento_id || ''),
    origem: String(r.origem || ''),
    observacao: String(r.observacao || ''),
    quem: String(r.quem || '')
  })).filter(r => r.id && r.servico).sort((a, b) =>
    (a.tipo === 'leitura' ? a.data : a.referencia).localeCompare(b.tipo === 'leitura' ? b.data : b.referencia));
}

function registroConsumo_(d) {
  const servico = servicoConsumo_(d.servico);
  if (!servico) throw new Error('Escolha luz, água ou gás.');
  const tipo = d.tipo === 'leitura' ? 'leitura' : 'fatura';
  const r = {
    servico: servico,
    tipo: tipo,
    referencia: refConsumo_(d.referencia) || (tipo === 'leitura' ? refConsumo_(d.data) : ''),
    data: dataConsumo_(d.data) || (tipo === 'leitura' ? Utils.today() : ''),
    leitura: numConsumo_(d.leitura),
    consumo: numConsumo_(d.consumo),
    unidade: String(d.unidade || SERVICOS_CONSUMO[servico].unidade),
    dias: numConsumo_(d.dias),
    valor: numConsumo_(d.valor),
    vencimento: dataConsumo_(d.vencimento),
    pago_em: dataConsumo_(d.pago_em),
    lancamento_id: String(d.lancamento_id || ''),
    origem: String(d.origem || 'manual'),
    observacao: String(d.observacao || '').slice(0, 500),
    quem: String(d.quem || '')
  };
  if (tipo === 'fatura' && !r.referencia) throw new Error('Informe o mês de referência.');
  if (tipo === 'leitura' && !(r.leitura >= 0)) throw new Error('Informe a leitura do medidor.');
  // Texto com apóstrofo: a planilha não transforma "2026-10" em data
  const paraAba = Object.assign({}, r);
  paraAba.referencia = r.referencia ? "'" + r.referencia : '';
  ['leitura', 'consumo', 'dias', 'valor'].forEach(k => { if (paraAba[k] === null) paraAba[k] = ''; });
  return { r: r, aba: paraAba };
}

/** Grava (ou atualiza, com id) um registro. Fatura do mesmo serviço e mês substitui a anterior. */
function salvarConsumo(d) {
  garantirAbaConsumo_();
  d = d || {};
  const x = registroConsumo_(d);
  let id = String(d.id || '');
  if (!id && x.r.tipo === 'fatura') {
    const igual = listConsumo().find(c => c.tipo === 'fatura' && c.servico === x.r.servico && c.referencia === x.r.referencia);
    if (igual) {
      id = igual.id;
      // O que a conta nova não trouxe continua como estava
      Object.keys(x.aba).forEach(k => { if (x.aba[k] === '' && igual[k] !== null && igual[k] !== '') delete x.aba[k]; });
    }
  }
  const salvo = id ? DB.update(SHEET_CONSUMO, id, x.aba) : DB.insert(SHEET_CONSUMO, x.aba);
  if (!salvo) throw new Error('Registro não encontrado.');
  return Object.assign({}, x.r, { id: String(salvo.id) });
}

function excluirConsumo(id) {
  garantirAbaConsumo_();
  DB.remove(SHEET_CONSUMO, id);
  return { ok: true };
}

/* ============================================================================
 * Análise
 * ========================================================================== */

function mediaConsumo_(nums) {
  const v = nums.filter(n => typeof n === 'number' && isFinite(n));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function diasEntre_(a, b) {
  return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
}

/** Leituras de um serviço com o consumo entre uma e outra. */
function leiturasComConsumo_(lista, servico) {
  const ls = lista.filter(c => c.servico === servico && c.tipo === 'leitura' && c.data && c.leitura !== null)
    .sort((a, b) => a.data.localeCompare(b.data));
  return ls.map((l, i) => {
    const ant = i > 0 ? ls[i - 1] : null;
    const dias = ant ? diasEntre_(ant.data, l.data) : null;
    const consumo = ant ? Math.round((l.leitura - ant.leitura) * 1000) / 1000 : null;
    const porDia = ant && dias > 0 && consumo >= 0 ? consumo / dias : null;
    return Object.assign({}, l, { desde: ant ? ant.data : '', intervalo: dias, consumo_periodo: consumo, por_dia: porDia });
  });
}

/**
 * Registra a leitura do medidor e devolve a comparação com a anterior.
 * d: { servico, leitura, data?, origem?, quem?, observacao? }
 */
function registrarLeituraConsumo(d) {
  d = Object.assign({}, d || {}, { tipo: 'leitura' });
  const servico = servicoConsumo_(d.servico);
  const data = dataConsumo_(d.data) || Utils.today();
  const leitura = numConsumo_(d.leitura);
  if (!servico) throw new Error('Diga se é água, gás ou luz.');
  if (!(leitura >= 0)) throw new Error('Não entendi o número do medidor.');
  const todasAntes = leiturasComConsumo_(listConsumo(), servico);
  // Leitura do mesmo dia: a nova corrige a anterior (foto refeita ou número digitado)
  const doDia = todasAntes.filter(l => l.data === data).pop();
  if (doDia && Math.abs(doDia.leitura - leitura) < 1e-9) {
    return { repetida: true, servico: servico, leitura: leitura, data: data };
  }
  const antes = todasAntes.filter(l => l.data < data);
  const ant = antes.length ? antes[antes.length - 1] : null;
  if (ant && leitura < ant.leitura) {
    throw new Error('A leitura ' + leitura + ' é menor que a anterior (' + ant.leitura + ' em ' + ant.data + '). Confira os números do medidor.');
  }
  salvarConsumo(Object.assign({}, d, { id: doDia ? doDia.id : '', data: data, referencia: refConsumo_(data) }));
  const todas = leiturasComConsumo_(listConsumo(), servico);
  const atual = todas.filter(l => l.data === data).pop();
  const porDiaHist = mediaConsumo_(todas.filter(l => l.data !== data && l.por_dia !== null && l.intervalo >= 3).map(l => l.por_dia));
  return {
    servico: servico,
    nome: SERVICOS_CONSUMO[servico].nome,
    corrigida: !!doDia,
    unidade: SERVICOS_CONSUMO[servico].unidade,
    leitura: leitura,
    data: data,
    anterior: ant ? { data: ant.data, leitura: ant.leitura } : null,
    consumo: atual ? atual.consumo_periodo : null,
    dias: atual ? atual.intervalo : null,
    por_dia: atual ? atual.por_dia : null,
    projecao_30: atual && atual.por_dia !== null ? Math.round(atual.por_dia * 30 * 100) / 100 : null,
    media_por_dia: porDiaHist,
    variacao_pct: atual && atual.por_dia !== null && atual.intervalo >= 3 && porDiaHist ? Math.round((atual.por_dia / porDiaHist - 1) * 100) : null
  };
}

/** Categoria do serviço (Luz, Água, Gás, Condomínio) pelo nome. */
function categoriaConsumo_(nome) {
  const alvo = String(nome || '').toLowerCase();
  const c = DB.readAll(SHEET_CATEGORIAS).find(x => String(x.nome || '').toLowerCase() === alvo && String(x.tipo) === 'despesa');
  return c ? String(c.id) : '';
}

/**
 * Conta de luz, gás ou condomínio lida pelo bot:
 *  - grava a fatura (e, no condomínio, a parte da água) na aba Consumo;
 *  - acerta a conta a pagar que já existe (da conta fixa) com o valor e o vencimento reais.
 * d: { servico: 'luz'|'gas'|'condominio', referencia, consumo, dias, valor, valor_pagar, vencimento,
 *      valor_agua, referencia_agua, historico: [{ referencia, consumo }], fornecedor, quem }
 * Devolve { registros, conta: { id, descricao, data, valor, antes: { data, valor } } | null }.
 */
function registrarFaturaConsumo(d) {
  d = d || {};
  const tipoConta = String(d.servico || '').toLowerCase();
  const registros = [];
  const base = { tipo: 'fatura', origem: 'bot', quem: d.quem || '' };

  if (tipoConta === 'condominio') {
    if (numConsumo_(d.valor_agua) > 0) {
      registros.push(salvarConsumo(Object.assign({}, base, {
        servico: 'agua', referencia: d.referencia_agua || d.referencia, valor: d.valor_agua,
        vencimento: d.vencimento, observacao: 'Cobrada no boleto do condomínio' + (d.periodo_agua ? ' (' + d.periodo_agua + ')' : '')
      })));
    }
  } else if (servicoConsumo_(tipoConta)) {
    registros.push(salvarConsumo(Object.assign({}, base, {
      servico: tipoConta, referencia: d.referencia, consumo: d.consumo, dias: d.dias,
      valor: d.valor, vencimento: d.vencimento, observacao: d.fornecedor || ''
    })));
    // Histórico impresso na conta: completa meses que ainda não estão na aba
    const existentes = {};
    listConsumo().filter(c => c.tipo === 'fatura' && c.servico === tipoConta).forEach(c => { existentes[c.referencia] = true; });
    (d.historico || []).forEach(h => {
      const ref = refConsumo_(h.referencia);
      if (ref && !existentes[ref] && numConsumo_(h.consumo) !== null) {
        registros.push(salvarConsumo(Object.assign({}, base, { servico: tipoConta, referencia: ref, consumo: h.consumo, observacao: 'Histórico da conta' })));
        existentes[ref] = true;
      }
    });
  }

  // Conta a pagar: acerta a que já existe (conta fixa) ou avisa que não achou
  let conta = null;
  const valorPagar = numConsumo_(d.valor_pagar) || numConsumo_(d.valor);
  const venc = dataConsumo_(d.vencimento);
  const nomeCat = tipoConta === 'condominio' ? 'Condomínio' : (SERVICOS_CONSUMO[tipoConta] || {}).categoria;
  const cat = nomeCat ? categoriaConsumo_(nomeCat) : '';
  if (cat && venc && valorPagar > 0) {
    const perto = DB.readAll(SHEET_LANCAMENTOS).filter(l =>
      String(l.categoria) === cat && (l.status === 'agendado' || l.status === 'pendente') &&
      Math.abs(diasEntre_(String(l.data).slice(0, 10), venc)) <= 12
    ).sort((a, b) => Math.abs(diasEntre_(String(a.data).slice(0, 10), venc)) - Math.abs(diasEntre_(String(b.data).slice(0, 10), venc)))[0];
    if (perto) {
      const antes = { data: String(perto.data).slice(0, 10), valor: Number(perto.valor) };
      const obs = [String(perto.observacao || '').trim(), 'Valor e vencimento da conta lida pelo bot em ' + Utils.today() + '.'].filter(Boolean).join(' ').slice(0, 900);
      saveLancamento(Object.assign({}, perto, { id: perto.id, valor: -Math.abs(valorPagar), data: venc, observacao: obs }));
      conta = { id: String(perto.id), descricao: String(perto.descricao), data: venc, valor: -Math.abs(valorPagar), antes: antes };
    }
  }
  return { registros: registros.length, conta: conta, categoria: cat };
}

/* ============================================================================
 * Tela
 * ========================================================================== */

function resumoServico_(lista, servico, hoje) {
  const info = SERVICOS_CONSUMO[servico];
  const faturas = lista.filter(c => c.servico === servico && c.tipo === 'fatura' && c.referencia)
    .sort((a, b) => a.referencia.localeCompare(b.referencia));
  const ultimas = faturas.slice(-13);
  const leituras = leiturasComConsumo_(lista, servico);

  // Para a água, o volume por mês sai das leituras (m³/dia × dias do mês)
  if (servico === 'agua' && leituras.length > 1) {
    ultimas.forEach(f => {
      if (f.consumo !== null) return;
      const est = consumoEstimadoMes_(leituras, f.referencia);
      if (est !== null) { f.consumo = est; f.estimado = true; }
    });
  }

  const ult = ultimas.length ? ultimas[ultimas.length - 1] : null;
  const anteriores = ultimas.slice(0, -1).slice(-6);
  const mediaCons = mediaConsumo_(anteriores.map(f => f.consumo));
  const mediaValor = mediaConsumo_(anteriores.map(f => f.valor));
  const base = ult && ult.consumo !== null && mediaCons ? 'consumo' : 'valor';
  const atual = ult ? (base === 'consumo' ? ult.consumo : ult.valor) : null;
  const media = base === 'consumo' ? mediaCons : mediaValor;
  const variacao = atual !== null && media ? Math.round((atual / media - 1) * 100) : null;

  const comAmbos = ultimas.filter(f => f.consumo > 0 && f.valor > 0 && !f.estimado).slice(-6);
  const preco = comAmbos.length ? comAmbos.reduce((s, f) => s + f.valor, 0) / comAmbos.reduce((s, f) => s + f.consumo, 0) : null;

  let alerta = '';
  if (variacao !== null && variacao >= 15) {
    alerta = (base === 'consumo' ? 'Consumo' : 'Valor') + ' ' + variacao + '% acima da média dos meses anteriores.';
  }
  const ultLeit = leituras.length ? leituras[leituras.length - 1] : null;
  // Só compara intervalos de 3 dias ou mais: leitura de um dia para o outro oscila demais
  const porDiaHist = mediaConsumo_(leituras.slice(0, -1).filter(l => l.intervalo >= 3).map(l => l.por_dia));
  if (ultLeit && ultLeit.por_dia !== null && ultLeit.intervalo >= 3 && porDiaHist && ultLeit.por_dia > porDiaHist * 1.25) {
    alerta = (alerta ? alerta + ' ' : '') + 'Na última leitura o gasto por dia subiu ' + Math.round((ultLeit.por_dia / porDiaHist - 1) * 100) + '%: vale conferir vazamentos.';
  }
  const diasSemLeitura = ultLeit ? diasEntre_(ultLeit.data, hoje) : null;

  return {
    id: servico, nome: info.nome, unidade: info.unidade,
    faturas: ultimas.map(f => ({
      id: f.id, referencia: f.referencia, consumo: f.consumo, estimado: !!f.estimado, valor: f.valor,
      vencimento: f.vencimento, dias: f.dias, observacao: f.observacao
    })),
    ultimo: ult ? { referencia: ult.referencia, consumo: ult.consumo, estimado: !!ult.estimado, valor: ult.valor } : null,
    media_consumo: mediaCons !== null ? Math.round(mediaCons * 100) / 100 : null,
    media_valor: mediaValor !== null ? Math.round(mediaValor * 100) / 100 : null,
    variacao_pct: variacao, base_variacao: base,
    preco_unidade: preco !== null ? Math.round(preco * 100) / 100 : null,
    alerta: alerta,
    leituras: leituras.slice(-12).reverse().map(l => ({
      id: l.id, data: l.data, leitura: l.leitura, desde: l.desde, intervalo: l.intervalo,
      consumo: l.consumo_periodo, por_dia: l.por_dia !== null ? Math.round(l.por_dia * 1000) / 1000 : null,
      projecao_30: l.por_dia !== null ? Math.round(l.por_dia * 30 * 100) / 100 : null, origem: l.origem
    })),
    dias_sem_leitura: diasSemLeitura
  };
}

/** m³ de um mês pela taxa diária das leituras que cobrem aquele mês. */
function consumoEstimadoMes_(leituras, ref) {
  const ini = ref + '-01';
  const d = new Date(ini + 'T12:00:00');
  const fim = Utils.formatDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  let total = 0, cobertos = 0;
  leituras.forEach(l => {
    if (l.por_dia === null || !l.desde) return;
    const a = l.desde > ini ? l.desde : ini;
    const b = l.data < fim ? l.data : fim;
    const dias = diasEntre_(a, b);
    if (dias > 0) { total += l.por_dia * dias; cobertos += dias; }
  });
  const diasMes = diasEntre_(ini, fim) + 1;
  if (cobertos < diasMes * 0.6) return null;
  return Math.round(total / cobertos * diasMes * 100) / 100;
}

function appConsumo() {
  const lista = listConsumo();
  const hoje = Utils.today();
  return {
    tem_dados: lista.length > 0,
    servicos: ['luz', 'agua', 'gas'].map(s => resumoServico_(lista, s, hoje)),
    hoje: hoje
  };
}

function appSalvarConsumo(d) {
  const salvo = salvarConsumo(Object.assign({}, d || {}, { origem: (d && d.origem) || 'manual', quem: (typeof appQuem_ === 'function' ? appQuem_() : '') }));
  return { ok: true, id: salvo.id };
}

function appExcluirConsumo(id) {
  return excluirConsumo(id);
}
