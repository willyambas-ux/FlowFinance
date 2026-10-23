/**
 * Itens.gs — banco de produtos comprados, um registro por item de cupom fiscal.
 *
 * Serve para o histórico de preços: quanto paguei, onde e quando, e onde um
 * produto (ou uma categoria de produtos) costuma sair mais barato.
 *
 * Cada item aponta para o lançamento (lancamento_id) que pagou a compra.
 */
const SHEET_ITENS = 'Itens';

function garantirAbaItens_() {
  if (!DB.getSpreadsheet().getSheetByName(SHEET_ITENS)) Init.ensureAllSheets();
}

function normalizarTexto_(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function numItem_(v) {
  const n = Number(v);
  return isFinite(n) ? Math.round(n * 10000) / 10000 : '';
}

/**
 * Grava os itens de um cupom ligados a um lançamento. Se o lançamento já tinha
 * itens, eles são substituídos (gravar de novo não duplica).
 * cab: { data, loja, cnpj, chave_nfce, quem }
 * itens: [{ descricao_cupom, produto, marca, categoria_item, quantidade, unidade, valor_unitario, valor_total, desconto }]
 */
function salvarItensCupom(lancamentoId, cab, itens) {
  if (!lancamentoId || !itens || !itens.length) return { gravados: 0 };
  garantirAbaItens_();
  removerItensDoLancamento([lancamentoId]);
  cab = cab || {};
  const registros = itens.map(i => {
    const qtd = Number(i.quantidade) > 0 ? Number(i.quantidade) : 1;
    const total = Number(i.valor_total);
    let unit = Number(i.valor_unitario);
    if (!(unit > 0) && total > 0) unit = total / qtd;
    return {
      data: cab.data || '',
      lancamento_id: String(lancamentoId),
      loja: String(cab.loja || ''),
      cnpj: String(cab.cnpj || ''),
      descricao_cupom: String(i.descricao_cupom || i.produto || '').slice(0, 200),
      produto: String(i.produto || i.descricao_cupom || '').slice(0, 120),
      marca: String(i.marca || ''),
      categoria_item: String(i.categoria_item || ''),
      quantidade: numItem_(qtd),
      unidade: String(i.unidade || 'un'),
      valor_unitario: numItem_(unit),
      valor_total: numItem_(total),
      desconto: numItem_(i.desconto || 0),
      chave_nfce: String(cab.chave_nfce || '').replace(/\D/g, ''),
      quem: String(cab.quem || '')
    };
  });
  DB.batchInsert(SHEET_ITENS, registros);
  return { gravados: registros.length };
}

/** Apaga os itens dos lançamentos informados (usado no Desfazer). */
function removerItensDoLancamento(lancamentoIds) {
  if (!DB.getSpreadsheet().getSheetByName(SHEET_ITENS)) return 0;
  const alvo = {};
  (lancamentoIds || []).forEach(id => { alvo[String(id)] = true; });
  const ids = DB.readAllFresh(SHEET_ITENS).filter(i => alvo[String(i.lancamento_id)]).map(i => i.id);
  return ids.length ? DB.batchRemove(SHEET_ITENS, ids) : 0;
}

/**
 * Pesquisa preços. termo casa com produto, descrição do cupom, marca ou categoria do item.
 * Devolve { termo, total, itens (mais recentes primeiro), lojas: [{ loja, menor, media, ultimo, ultima_data, vezes }] }
 * ordenadas do menor preço unitário médio para o maior.
 */
function pesquisarPrecos(termo, opcoes) {
  opcoes = opcoes || {};
  if (!DB.getSpreadsheet().getSheetByName(SHEET_ITENS)) return { termo: termo, total: 0, itens: [], lojas: [] };
  const palavras = normalizarTexto_(termo).split(' ').filter(p => p.length >= 2);
  const desde = opcoes.desde || '';
  const achados = DB.readAll(SHEET_ITENS).filter(i => {
    if (desde && String(i.data) < desde) return false;
    const alvo = normalizarTexto_([i.produto, i.descricao_cupom, i.marca, i.categoria_item].join(' '));
    return palavras.length > 0 && palavras.every(p => alvo.indexOf(p) !== -1);
  });
  achados.sort((a, b) => String(b.data).localeCompare(String(a.data)));

  const porLoja = {};
  achados.forEach(i => {
    const loja = i.loja || '(sem loja)';
    const u = Number(i.valor_unitario);
    if (!(u > 0)) return;
    const g = porLoja[loja] || (porLoja[loja] = { loja: loja, soma: 0, vezes: 0, menor: Infinity, ultimo: null, ultima_data: '' });
    g.soma += u; g.vezes += 1;
    if (u < g.menor) g.menor = u;
    if (!g.ultima_data || String(i.data) > g.ultima_data) { g.ultima_data = String(i.data); g.ultimo = u; }
  });
  const lojas = Object.keys(porLoja).map(k => {
    const g = porLoja[k];
    return { loja: g.loja, menor: g.menor, media: g.soma / g.vezes, ultimo: g.ultimo, ultima_data: g.ultima_data, vezes: g.vezes };
  }).sort((a, b) => a.media - b.media);

  return { termo: termo, total: achados.length, itens: achados.slice(0, opcoes.limite || 30), lojas: lojas };
}
