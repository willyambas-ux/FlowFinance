/**
 * Rascunho.js — o lançamento em revisão no Telegram: guardar, mostrar, ajustar,
 * confirmar e desfazer.
 *
 * Botões usam callback_data "acao|chave|arg" (limite do Telegram: 64 bytes).
 */
const Rascunho = (function () {
  const TTL = 21600; // 6 horas, máximo do CacheService

  function cache_() { return CacheService.getScriptCache(); }

  function novaChave_() {
    return Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  }

  function salvar(r) {
    cache_().put('rasc_' + r.chave, JSON.stringify(r), TTL);
    return r;
  }

  function ler(chave) {
    const raw = cache_().get('rasc_' + chave);
    return raw ? JSON.parse(raw) : null;
  }

  function criar(dados) {
    const r = Object.assign({ chave: novaChave_(), estado: 'aberto', ids: [] }, dados);
    return salvar(r);
  }

  /* ------------------------------------------------------------------ texto */

  function faltaPagamento_(r) { return !r.conta && !r.cartao; }
  function faltaValor_(r) { return !(Number(r.valor) > 0); }

  function textoResumo_(r, ctx, titulo) {
    const L = [];
    const tipo = r.tipo === 'receita' ? 'Receita' : 'Despesa';
    L.push(titulo ? '<b>' + titulo + '</b>' : '');
    L.push('<b>' + tipo + ' · ' + (faltaValor_(r) ? 'valor?' : Formato.brl(r.valor)) + '</b>');
    L.push(Telegram.esc(r.descricao));

    const cat = r.categoria ? Contexto.acharCategoria(ctx, r.categoria) : null;
    L.push('Categoria: ' + (cat ? Telegram.esc(cat.caminho) : '<i>sem categoria</i>'));

    if (r.cartao) {
      const c = Contexto.acharCartao(ctx, r.cartao);
      let fatura = '';
      try { fatura = Formato.competenciaBR(FF.sugerirFaturaCompetencia(r.cartao, r.data)); } catch (e) { /* ignora */ }
      L.push('Pagamento: ' + Telegram.esc(c ? c.nome : '?') + (fatura ? ' · fatura ' + fatura : ''));
    } else if (r.conta) {
      const c = Contexto.acharConta(ctx, r.conta);
      L.push('Pagamento: ' + Telegram.esc(c ? c.nome : '?'));
    } else {
      L.push('Pagamento: <i>falta escolher</i>');
    }

    let linhaData = 'Data: ' + Formato.dataBR(r.data);
    if (r.parcelas > 1 && !faltaValor_(r)) {
      linhaData += ' · ' + r.parcelas + 'x de ' + Formato.brl(r.valor / r.parcelas);
    }
    L.push(linhaData);
    L.push('Quem: ' + Telegram.esc(r.quem));
    return L.filter(x => x !== '').join('\n');
  }

  /* ---------------------------------------------------------------- teclados */

  function grade_(itens, porLinha) {
    const linhas = [];
    for (let i = 0; i < itens.length; i += porLinha) linhas.push(itens.slice(i, i + porLinha));
    return linhas;
  }

  function botao_(texto, dados) { return { text: texto, callback_data: dados }; }

  function tecladoPrincipal_(r) {
    const k = r.chave;
    const linhas = [];
    if (!faltaPagamento_(r) && !faltaValor_(r)) linhas.push([botao_('Confirmar', 'ok|' + k)]);
    linhas.push([botao_('Categoria', 'mc|' + k), botao_('Pagamento', 'mp|' + k), botao_('Data', 'md|' + k)]);
    linhas.push([botao_(r.tipo === 'receita' ? 'É despesa' : 'É receita', 'tt|' + k), botao_('Cancelar', 'x|' + k)]);
    return linhas;
  }

  function tecladoPagamento_(r, ctx) {
    const k = r.chave;
    const itens = ctx.cartoes.map(c => botao_(c.nome, 'sp|' + k + '|c' + c.id))
      .concat(ctx.contas
        .filter(c => c.tipo !== 'investimento')
        .map(c => botao_(c.nome, 'sp|' + k + '|a' + c.id)));
    const linhas = grade_(itens, 2);
    linhas.push([botao_('Voltar', 'v|' + k), botao_('Cancelar', 'x|' + k)]);
    return linhas;
  }

  function tecladoCategoriasPai_(r, ctx) {
    const k = r.chave;
    const pais = ctx.categorias.filter(c => c.tipo === r.tipo && !c.pai);
    const linhas = grade_(pais.map(c => botao_(c.nome, 'cp|' + k + '|' + c.id)), 2);
    linhas.push([botao_('Sem categoria', 'sc|' + k + '|-'), botao_('Voltar', 'v|' + k)]);
    return linhas;
  }

  function tecladoCategoriasFilhas_(r, ctx, paiId) {
    const k = r.chave;
    const pai = Contexto.acharCategoria(ctx, paiId);
    const filhas = ctx.categorias.filter(c => c.pai === String(paiId));
    const linhas = grade_(filhas.map(c => botao_(c.nome, 'sc|' + k + '|' + c.id)), 2);
    linhas.push([botao_('Só ' + (pai ? pai.nome : 'esta'), 'sc|' + k + '|' + paiId)]);
    linhas.push([botao_('Voltar', 'mc|' + k)]);
    return linhas;
  }

  function tecladoData_(r) {
    const k = r.chave;
    return [
      [botao_('Hoje', 'sd|' + k + '|' + Formato.hoje()),
       botao_('Ontem', 'sd|' + k + '|' + Formato.hoje(-1)),
       botao_('Anteontem', 'sd|' + k + '|' + Formato.hoje(-2))],
      [botao_('Voltar', 'v|' + k)]
    ];
  }

  /* ------------------------------------------------------------- exibição */

  /** Texto e botões do estado atual. Se falta pagamento, já abre a escolha. */
  function tela_(r, ctx) {
    if (faltaPagamento_(r) && !faltaValor_(r)) {
      return {
        texto: textoResumo_(r, ctx) + '\n\n<b>Pagou com qual?</b>',
        botoes: tecladoPagamento_(r, ctx)
      };
    }
    let texto = textoResumo_(r, ctx);
    if (faltaValor_(r)) texto += '\n\n<b>Qual foi o valor?</b> Cancele e mande de novo com o valor.';
    return { texto: texto, botoes: tecladoPrincipal_(r) };
  }

  function mostrarNovo(r, ctx) {
    const t = tela_(r, ctx);
    const resp = Telegram.enviar(r.chatId, t.texto, t.botoes);
    if (resp && resp.ok) {
      r.messageId = resp.result.message_id;
      salvar(r);
    }
  }

  function atualizar_(r, ctx) {
    const t = tela_(r, ctx);
    Telegram.editar(r.chatId, r.messageId, t.texto, t.botoes);
  }

  /* ---------------------------------------------------------------- ações */

  function confirmar_(r, ctx) {
    const hoje = Formato.hoje();
    const valor = Math.abs(Number(r.valor));
    const registro = {
      data: r.data,
      descricao: r.descricao,
      valor: r.tipo === 'receita' ? valor : -valor,
      conta: r.cartao ? '' : r.conta,
      cartao: r.cartao || '',
      categoria: r.categoria || '',
      status: r.data > hoje ? 'agendado' : 'confirmado',
      origem: 'telegram',
      quem: r.quem,
      observacao: 'Telegram: ' + String(r.textoOriginal || '').slice(0, 200)
    };

    let criados;
    if (r.parcelas > 1) {
      criados = FF.criarParcelamento(registro, r.parcelas, 1, 'mensal', 1) || [];
    } else {
      criados = [FF.saveLancamento(registro)];
    }
    r.ids = criados.filter(Boolean).map(l => String(l.id));
    r.estado = 'salvo';
    salvar(r);
    CacheService.getScriptCache().put('ultimo_' + r.usuarioId, r.chave, TTL);

    const titulo = r.parcelas > 1 ? 'Lançado em ' + r.parcelas + ' parcelas' : 'Lançado';
    Telegram.editar(r.chatId, r.messageId, textoResumo_(r, ctx, titulo),
      [[botao_('Desfazer', 'u|' + r.chave)]]);
  }

  function desfazer(r) {
    if (r.estado !== 'salvo' || !r.ids.length) return false;
    FF.deleteLancamentosBatch(r.ids);
    r.estado = 'desfeito';
    salvar(r);
    Telegram.editar(r.chatId, r.messageId,
      '<s>' + Telegram.esc(r.descricao) + ' · ' + Formato.brl(r.valor) + '</s>\nDesfeito: nada ficou gravado.', []);
    return true;
  }

  /**
   * Trata o toque num botão. Retorna o aviso curto para answerCallbackQuery.
   */
  function tratarBotao(dados, usuarioId) {
    const partes = String(dados || '').split('|');
    const acao = partes[0], chave = partes[1], arg = partes.slice(2).join('|');
    const r = ler(chave);
    if (!r) return 'Esse lançamento expirou. Mande de novo.';
    if (String(r.usuarioId) !== String(usuarioId)) return 'Esse lançamento é de outra pessoa.';

    if (acao === 'u') return desfazer(r) ? 'Desfeito' : 'Nada para desfazer';
    if (r.estado !== 'aberto') return 'Esse lançamento já foi resolvido.';

    const ctx = Contexto.carregar();

    if (acao === 'ok') {
      if (faltaPagamento_(r) || faltaValor_(r)) return 'Falta informação';
      confirmar_(r, ctx);
      return 'Lançado';
    }
    if (acao === 'x') {
      r.estado = 'cancelado';
      salvar(r);
      Telegram.editar(r.chatId, r.messageId, '<s>' + Telegram.esc(r.descricao) + '</s>\nCancelado.', []);
      return 'Cancelado';
    }
    if (acao === 'v') { atualizar_(r, ctx); return ''; }
    if (acao === 'mp') {
      Telegram.editar(r.chatId, r.messageId, textoResumo_(r, ctx) + '\n\n<b>Pagou com qual?</b>', tecladoPagamento_(r, ctx));
      return '';
    }
    if (acao === 'sp') {
      const id = arg.slice(1);
      if (arg.charAt(0) === 'c' && Contexto.acharCartao(ctx, id)) { r.cartao = id; r.conta = ''; }
      else if (arg.charAt(0) === 'a' && Contexto.acharConta(ctx, id)) { r.conta = id; r.cartao = ''; }
      salvar(r); atualizar_(r, ctx); return '';
    }
    if (acao === 'mc') {
      Telegram.editar(r.chatId, r.messageId, textoResumo_(r, ctx) + '\n\n<b>Qual categoria?</b>', tecladoCategoriasPai_(r, ctx));
      return '';
    }
    if (acao === 'cp') {
      const temFilhas = ctx.categorias.some(c => c.pai === arg);
      if (!temFilhas) { r.categoria = arg; salvar(r); atualizar_(r, ctx); return ''; }
      Telegram.editar(r.chatId, r.messageId, textoResumo_(r, ctx) + '\n\n<b>Qual categoria?</b>', tecladoCategoriasFilhas_(r, ctx, arg));
      return '';
    }
    if (acao === 'sc') {
      r.categoria = (arg === '-') ? '' : (Contexto.acharCategoria(ctx, arg) ? arg : r.categoria);
      salvar(r); atualizar_(r, ctx); return '';
    }
    if (acao === 'md') {
      Telegram.editar(r.chatId, r.messageId, textoResumo_(r, ctx) + '\n\n<b>Quando foi?</b>', tecladoData_(r));
      return '';
    }
    if (acao === 'sd') {
      if (Formato.ehDataISO(arg)) r.data = arg;
      salvar(r); atualizar_(r, ctx); return '';
    }
    if (acao === 'tt') {
      r.tipo = r.tipo === 'receita' ? 'despesa' : 'receita';
      const cat = r.categoria ? Contexto.acharCategoria(ctx, r.categoria) : null;
      if (cat && cat.tipo !== r.tipo) r.categoria = '';
      salvar(r); atualizar_(r, ctx); return '';
    }
    return '';
  }

  return {
    criar: criar,
    ler: ler,
    mostrarNovo: mostrarNovo,
    desfazer: desfazer,
    tratarBotao: tratarBotao
  };
})();
