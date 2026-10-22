/**
 * Importacao.gs — parser de CSV genérico + importação em lote.
 *
 * Aceita CSV com cabeçalho. Detecta colunas: data, descricao/historico, valor.
 * Separador: vírgula ou ponto-e-vírgula (autodetectado).
 * Datas aceitas: dd/mm/aaaa ou aaaa-mm-dd.
 * Valores aceitam vírgula ou ponto como decimal.
 */

function parseCSV(texto, opts) {
  if (!texto) return { headers: [], lancs: [] };
  opts = opts || {};
  const modoFatura = !!opts.modoFatura; // fatura de cartão: inverte sinal e marca pagamentos

  const linhas = String(texto).trim().split(/\r?\n/);
  if (linhas.length < 2) throw new Error('CSV precisa de pelo menos 2 linhas (cabeçalho + 1 dado).');

  const sep = detectaSeparador_(linhas[0]);
  const headers = splitCSV_(linhas[0], sep).map(h => h.trim().toLowerCase());

  const colData  = encontraColuna_(headers, ['data','date','dt']);
  const colDesc  = encontraColuna_(headers, ['descricao','descrição','historico','histórico','description','memo','estabelecimento','lançamento','lancamento','histórico do lançamento']);
  const colValor = encontraColuna_(headers, ['valor','amount','valor (r$)','value']);
  const colParcela = encontraColuna_(headers, ['parcela','parcelas','installment']);

  if (colData === -1 || colDesc === -1 || colValor === -1) {
    throw new Error('CSV deve ter colunas: data, descrição (ou estabelecimento) e valor. Cabeçalhos encontrados: ' + headers.join(', '));
  }

  const lancs = [];
  for (let i = 1; i < linhas.length; i++) {
    const linha = linhas[i].trim();
    if (!linha) continue;
    const campos = splitCSV_(linha, sep);
    if (campos.length < 3) continue;

    const dataStr = parseData_(campos[colData]);
    if (!dataStr) continue;

    const desc  = String(campos[colDesc] || '').trim();
    let valor = Utils.toNumber(campos[colValor]);
    const ehPag = ehPagamentoFatura_(desc);

    // Modo fatura: na fatura, compras vêm positivas; no app, despesa é negativa → inverte
    if (modoFatura) valor = -valor;

    const parc = (colParcela !== -1) ? parseParcela_(campos[colParcela]) : { atual: '', total: '' };

    lancs.push({
      data: dataStr,
      descricao: desc,
      valor: valor,
      parcela_atual: parc.atual,
      parcela_total: parc.total,
      _pagamento: ehPag
    });
  }

  return { headers: headers, lancs: lancs };
}

/** Parseia "3 de 10", "3/10", "03 de 03" → {atual, total}. Vazio se não bater. */
function parseParcela_(s) {
  s = String(s || '').trim();
  if (!s || s === '-') return { atual: '', total: '' };
  const m = s.match(/(\d+)\s*(?:de|\/)\s*(\d+)/i);
  if (m) return { atual: Number(m[1]), total: Number(m[2]) };
  return { atual: '', total: '' };
}

/**
 * Detecta APENAS o pagamento da fatura (a quitação), que deve ser ignorado pra não
 * duplicar o pagamento já registrado como transferência.
 *
 * IMPORTANTE: estornos, devoluções, cashback e outros CRÉDITOS NÃO entram aqui —
 * eles são valores creditados legítimos (reduzem a fatura) e devem ser importados
 * como entrada (positiva) no cartão.
 */
function ehPagamentoFatura_(desc) {
  const d = String(desc || '').toLowerCase().trim();
  if (/estorno|devolu|cashback|reembolso/.test(d)) return false; // crédito legítimo
  return /^pagamento/.test(d)
      || /pagamento.*(valido|v[aá]lido|normais|fatura|recebido)/.test(d)
      || /^pgto/.test(d)
      || /saldo anterior/.test(d);
}

function detectaSeparador_(linha) {
  const c = (linha.match(/,/g) || []).length;
  const sc = (linha.match(/;/g) || []).length;
  return sc > c ? ';' : ',';
}

function splitCSV_(linha, sep) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (c === '"') {
      if (inQuotes && linha[i+1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === sep && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function encontraColuna_(headers, candidatos) {
  for (let i = 0; i < headers.length; i++) {
    if (candidatos.indexOf(headers[i]) !== -1) return i;
  }
  return -1;
}

function parseData_(s) {
  s = String(s || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let ano = m[3];
    if (ano.length === 2) ano = '20' + ano;
    return ano + '-' + String(m[2]).padStart(2,'0') + '-' + String(m[1]).padStart(2,'0');
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return m[1] + '-' + String(m[2]).padStart(2,'0') + '-' + String(m[3]).padStart(2,'0');
  return '';
}

/**
 * Faz o parse do CSV, retorna a pré-visualização e os lançamentos já com regras aplicadas
 * (sem persistir nada). Usado pela UI antes da importação confirmar.
 */
function previewImportacaoCSV(texto, contaId) {
  const parsed = parseCSV(texto);
  if (!contaId) return parsed;
  parsed.lancs = parsed.lancs.map(l =>
    aplicarRegras(Object.assign({}, l, { conta: contaId, status: 'pendente' }))
  );
  return parsed;
}

/* ============================================================================
 * OFX parser (1.x SGML e 2.x XML — abordagem regex tolerante).
 * ========================================================================== */

function parseOFX(texto) {
  if (!texto) return { lancs: [] };

  const txnRegex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  const lancs = [];
  let match;
  while ((match = txnRegex.exec(texto)) !== null) {
    const body = match[1];
    const dt = extractOFXTag_(body, 'DTPOSTED');
    const amt = extractOFXTag_(body, 'TRNAMT');
    const memo = extractOFXTag_(body, 'MEMO') || extractOFXTag_(body, 'NAME') || '';

    if (!dt || !amt) continue;

    const m = String(dt).match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) continue;
    const dataStr = m[1] + '-' + m[2] + '-' + m[3];

    lancs.push({
      data: dataStr,
      descricao: String(memo).trim(),
      valor: Number(String(amt).replace(',', '.')) || 0
    });
  }
  return { lancs: lancs };
}

function extractOFXTag_(body, tag) {
  const re = new RegExp('<' + tag + '>\\s*([^<\\r\\n]+)', 'i');
  const m = body.match(re);
  return m ? String(m[1]).trim() : '';
}

/**
 * Preview unificado: detecta CSV ou OFX automaticamente pelo conteúdo.
 * @param {string} texto - conteúdo CSV/OFX
 * @param {Object|string} opts - { tipo:'conta'|'cartao', id, modoFatura } ou (legado) contaId string
 */
function previewImportacao(texto, opts) {
  if (typeof opts === 'string') opts = { tipo: 'conta', id: opts };
  opts = opts || {};
  // Modo fatura: padrão LIGADO quando destino é cartão
  const modoFatura = (opts.tipo === 'cartao') && (opts.modoFatura !== false);

  const isOFX = /OFXHEADER|<OFX>|<STMTTRN>/i.test(String(texto || ''));
  const parsed = isOFX ? parseOFX(texto) : parseCSV(texto, { modoFatura: modoFatura });
  parsed.formato = isOFX ? 'OFX' : 'CSV';
  parsed.modo_fatura = modoFatura;

  // Índice de duplicados: mapeia data|valor|descrição → lista de lançamentos existentes
  const existentes = DB.readAll(SHEET_LANCAMENTOS);
  const indexDup = {};
  existentes.forEach(l => {
    const k = _chaveDup_(l);
    if (!indexDup[k]) indexDup[k] = [];
    indexDup[k].push(l);
  });

  // Caches pra resolver nomes de conta/cartão/categoria do lançamento existente
  const contasMap  = {}; (typeof listContas  === 'function' ? listContas()  : []).forEach(c => contasMap[c.id]  = c);
  const cartoesMap = {}; (typeof listCartoes === 'function' ? listCartoes() : []).forEach(c => cartoesMap[c.id] = c);
  const catMap     = {}; listCategorias().forEach(c => catMap[c.id] = c);

  function _resumoDup_(l) {
    return {
      id: l.id,
      data: l.data,
      descricao: l.descricao,
      valor: Number(l.valor) || 0,
      conta_nome: (l.conta && contasMap[l.conta]) ? contasMap[l.conta].nome : '',
      cartao_nome: (l.cartao && cartoesMap[l.cartao]) ? cartoesMap[l.cartao].nome : '',
      categoria_nome: (l.categoria && catMap[l.categoria]) ? catMap[l.categoria].nome : '',
      status: l.status || '',
      origem: l.origem || ''
    };
  }

  if (opts.id) {
    parsed.lancs = parsed.lancs.map(l => {
      const base = Object.assign({}, l, { status: 'pendente' });
      if (opts.tipo === 'cartao') { base.cartao = opts.id; base.conta = ''; }
      else                        { base.conta = opts.id;  base.cartao = ''; }
      const comRegras = aplicarRegras(base);
      comRegras.parcela_atual = l.parcela_atual;
      comRegras.parcela_total = l.parcela_total;
      comRegras._pagamento    = l._pagamento;
      const matches = indexDup[_chaveDup_(l)];
      comRegras._duplicado     = !!matches;
      comRegras._dup_existentes = matches ? matches.map(_resumoDup_) : [];
      return comRegras;
    });
  } else {
    parsed.lancs.forEach(l => {
      const matches = indexDup[_chaveDup_(l)];
      l._duplicado = !!matches;
      l._dup_existentes = matches ? matches.map(_resumoDup_) : [];
    });
  }
  return parsed;
}

/** Chave para detecção de duplicados: data + valor (2 casas) + descrição normalizada. */
function _chaveDup_(l) {
  const v = (Number(l.valor) || 0).toFixed(2);
  const d = String(l.descricao || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return String(l.data) + '|' + v + '|' + d;
}

/**
 * Importa lançamentos em lote. Cada um passa por regras antes de ser inserido.
 * @param {Object} payload - { tipo:'conta'|'cartao', id, lancs } ou (legado) { conta_id, lancs }
 */
function importarLancamentos(payload) {
  payload = payload || {};
  let tipo = payload.tipo;
  let id = payload.id;
  if (!tipo && payload.conta_id) { tipo = 'conta'; id = payload.conta_id; }
  id = String(id || '').trim();
  if (!id) throw new Error('Informe a conta ou cartão de destino.');

  // Importa tudo que o usuário deixou marcado (só pula o que ele desmarcou).
  const lancs = (payload.lancs || []).filter(l => !l._ignorar);
  if (lancs.length === 0) return { importados: 0, ignorados: (payload.lancs || []).length };

  const records = [];
  let parcelasFuturas = 0;
  lancs.forEach(l => {
    const base = Object.assign({}, l, { status: l.status || 'pendente', origem: 'importacao' });
    if (tipo === 'cartao') { base.cartao = id; base.conta = ''; }
    else                   { base.conta = id;  base.cartao = ''; }
    // Categoria/centro: usa o que o usuário definiu no preview; senão aplica regras
    const comRegras = (l.categoria || l.centro) ? base : aplicarRegras(base);
    comRegras.categoria = l.categoria || comRegras.categoria || '';
    comRegras.centro    = l.centro    || comRegras.centro    || '';
    comRegras.parcela_atual = l.parcela_atual || '';
    comRegras.parcela_total = l.parcela_total || '';
    comRegras.origem = 'importacao';

    // Parcelado e ainda há parcelas futuras? Gera as próximas como agendadas
    const atual = Number(l.parcela_atual) || 0;
    const total = Number(l.parcela_total) || 0;
    const temFuturas = atual > 0 && total > 0 && atual < total;
    if (temFuturas) {
      comRegras.recorrencia_id = comRegras.recorrencia_id || Utils.uuid();
      // Acrescenta sufixo "(N/M)" na descrição da parcela atual pra ficar visual igual às futuras
      const descBase = String(comRegras.descricao || '').replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();
      comRegras.descricao = descBase + ' (' + atual + '/' + total + ')';
    }
    const principal = normalizeLancamento_(comRegras);
    records.push(principal);

    if (temFuturas) {
      const baseDate = new Date(comRegras.data + 'T00:00:00');
      const descBase = String(comRegras.descricao).replace(/\s*\(\d+\/\d+\)\s*$/, '').trim();
      for (let i = atual + 1; i <= total; i++) {
        const offset = i - atual;
        const novaDate = offsetData_(baseDate, 'mensal', 1, offset);
        // Competência da parcela futura: se a atual tem competência manual, segue a sequência
        // (atual + offset meses); senão fica vazia (cada uma cai na fatura pela própria data).
        const compFutura = principal.fatura_competencia
          ? _addMesesYYYYMM_(principal.fatura_competencia, offset)
          : '';
        const futuro = Object.assign({}, principal, {
          data: Utils.formatDate(novaDate),
          descricao: descBase + ' (' + i + '/' + total + ')',
          parcela_atual: i,
          parcela_total: total,
          recorrencia_id: principal.recorrencia_id,
          status: 'agendado',
          fatura_competencia: compFutura
        });
        records.push(normalizeLancamento_(futuro));
        parcelasFuturas++;
      }
    }
  });

  DB.batchInsert(SHEET_LANCAMENTOS, records);
  return {
    importados: records.length,
    ignorados: (payload.lancs || []).length - lancs.length,
    parcelas_futuras: parcelasFuturas
  };
}
