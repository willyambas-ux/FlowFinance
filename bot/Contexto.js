/**
 * Contexto.js — contas, cartões e categorias vindos do FlowFinance (biblioteca FF),
 * já no formato que a IA e os menus do bot usam.
 */
const Contexto = (function () {
  function carregar() {
    const contas = FF.listContas()
      .filter(c => ativo_(c.ativo) && c.tipo !== 'emprestimo')
      .map(c => ({ id: String(c.id), nome: String(c.nome), tipo: String(c.tipo || ''), banco: String(c.banco || '') }));

    const cartoes = FF.listCartoes()
      .filter(c => ativo_(c.ativo))
      .map(c => ({ id: String(c.id), nome: String(c.nome), bandeira: String(c.bandeira || '') }));

    const brutas = FF.listCategorias();
    const porId = {};
    brutas.forEach(c => { porId[String(c.id)] = c; });
    const categorias = brutas
      .filter(c => c.tipo === 'despesa' || c.tipo === 'receita')
      .map(c => {
        const pai = c.pai ? porId[String(c.pai)] : null;
        return {
          id: String(c.id),
          nome: String(c.nome),
          pai: c.pai ? String(c.pai) : '',
          tipo: String(c.tipo),
          caminho: pai ? (String(pai.nome) + ' > ' + String(c.nome)) : String(c.nome)
        };
      });

    return { contas: contas, cartoes: cartoes, categorias: categorias };
  }

  function ativo_(v) {
    // Coluna 'ativo' vazia conta como ativo
    if (v === '' || v === null || v === undefined) return true;
    return v === true || String(v).toLowerCase() === 'true';
  }

  function acharConta(ctx, id) { return ctx.contas.find(c => c.id === String(id)) || null; }
  function acharCartao(ctx, id) { return ctx.cartoes.find(c => c.id === String(id)) || null; }
  function acharCategoria(ctx, id) { return ctx.categorias.find(c => c.id === String(id)) || null; }

  return {
    carregar: carregar,
    acharConta: acharConta,
    acharCartao: acharCartao,
    acharCategoria: acharCategoria
  };
})();
