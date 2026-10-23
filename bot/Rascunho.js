/**
 * Rascunho.js — o lançamento em revisão no Telegram: guardar, mostrar, ajustar,
 * confirmar e desfazer.
 *
 * Tipos: despesa | receita | transferencia (entre duas contas suas).
 * Botões usam callback_data "acao|chave|arg" (limite do Telegram: 64 bytes).
 */
const Rascunho = (function () {
  const TTL = 21600; // 6 horas, máximo do CacheService
  const PRIORIDADE_APRENDIDA = 10; // regra aprendida vale mais que as regras gerais

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
    const r = Object.assign({ chave: novaChave_(), estado: 'aberto', ids: [], contaDestino: '' }, dados);
    r.categoriaSugerida = r.categoria || '';
    return salvar(r);
  }

  /* ------------------------------------------------------------------ texto */

  function ehTransf_(r) { return r.tipo === 'transferencia'; }
  function faltaPagamento_(r) {
    if (ehTransf_(r)) return !r.conta || !r.contaDestino;
    return !r.conta && !r.cartao;
  }
  function faltaValor_(r) { return !(Number(r.valor) > 0); }

  function nomeConta_(ctx, id) {
    const c = id ? Contexto.acharConta(ctx, id) : null;
    return c ? Telegram.esc(c.nome) : '<i>falta escolher</i>';
  }

  function textoResumo_(r, ctx, titulo) {
    const L = [];
    if (titulo) L.push('<b>' + titulo + '</b>');
    else if (r.cabecalho) L.push('<i>' + Telegram.esc(r.cabecalho) + '</i>');

    const tipo = ehTransf_(r) ? 'Transferência' : (r.tipo === 'receita' ? 'Receita' : 'Despesa');
    L.push('<b>' + tipo + ' · ' + (faltaValor_(r) ? 'valor?' : Formato.brl(r.valor)) + '</b>');
    L.push(Telegram.esc(r.descricao));

    if (ehTransf_(r)) {
      L.push('De: ' + nomeConta_(ctx, r.conta));
      L.push('Para: ' + nomeConta_(ctx, r.contaDestino));
    } else {
      const cat = r.categoria ? Contexto.acharCategoria(ctx, r.categoria) : null;
      L.push('Categoria: ' + (cat ? Telegram.esc(cat.caminho) : '<i>sem categoria</i>'));

      if (r.cartao) {
        const c = Contexto.acharCartao(ctx, r.cartao);
        let fatura = '';
        try { fatura = Formato.competenciaBR(FF.sugerirFaturaCompetencia(r.cartao, r.data)); } catch (e) { /* ignora */ }
        L.push('Pagamento: ' + Telegram.esc(c ? c.nome : '?') + (fatura ? ' · fatura ' + fatura : ''));
      } else {
        L.push((r.tipo === 'receita' ? 'Conta: ' : 'Pagamento: ') + nomeConta_(ctx, r.conta));
      }
    }

    let linhaData = 'Data: ' + Formato.dataBR(r.data);
    if (r.parcelas > 1 && !faltaValor_(r) && !ehTransf_(r)) {
      linhaData += ' · ' + r.parcelas + 'x de ' + Formato.brl(r.valor / r.parcelas);
    }
    L.push(linhaData);
    L.push('Quem: ' + Telegram.esc(r.quem));
    return L.join('\n');
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
    if (ehTransf_(r)) {
      linhas.push([botao_('De', 'mo|' + k), botao_('Para', 'mt|' + k), botao_('Data', 'md|' + k)]);
      linhas.push([botao_('É despesa', 'td|' + k), botao_('Cancelar', 'x|' + k)]);
    } else {
      linhas.push([botao_('Categoria', 'mc|' + k), botao_('Pagamento', 'mp|' + k), botao_('Data', 'md|' + k)]);
      linhas.push([
        botao_(r.tipo === 'receita' ? 'É despesa' : 'É receita', 'tt|' + k),
        botao_('Transferência', 'tf|' + k),
        botao_('Cancelar', 'x|' + k)
      ]);
    }
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

  /** Contas para origem (acao 'so') ou destino ('st') de transferência. */
  function tecladoContas_(r, ctx, acao, excluir) {
    const k = r.chave;
    const itens = ctx.contas
      .filter(c => c.id !== excluir)
      .map(c => botao_(c.nome, acao + '|' + k + '|' + c.id));
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

  /** Texto e botões do estado atual. Se falta conta/pagamento, já abre a escolha. */
  function tela_(r, ctx) {
    if (!faltaValor_(r)) {
      if (ehTransf_(r) && !r.conta) {
        return { texto: textoResumo_(r, ctx) + '\n\n<b>Saiu de qual conta?</b>', botoes: tecladoContas_(r, ctx, 'so', r.contaDestino) };
      }
      if (ehTransf_(r) && !r.contaDestino) {
        return { texto: textoResumo_(r, ctx) + '\n\n<b>Foi para qual conta?</b>', botoes: tecladoContas_(r, ctx, 'st', r.conta) };
      }
      if (!ehTransf_(r) && faltaPagamento_(r)) {
        return { texto: textoResumo_(r, ctx) + '\n\n<b>Pagou com qual?</b>', botoes: tecladoPagamento_(r, ctx) };
      }
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

  function atualizar(r, ctx) {
    const t = tela_(r, ctx);
    Telegram.editar(r.chatId, r.messageId, t.texto, t.botoes);
  }

  /* -------------------------------------------------------------- aprender */

  /** Palavra-chave para a regra: até 3 palavras da descrição, sem acento e sem números. */
  function palavraChave_(descricao) {
    const palavras = Formato.semAcento(String(descricao || '')).toUpperCase()
      .replace(/[^A-Z ]+/g, ' ').trim().split(/\s+/).filter(p => p.length >= 2);
    const chave = palavras.slice(0, 3).join(' ');
    return chave.length >= 3 ? chave : '';
  }

  /** Se a pessoa trocou a categoria sugerida, grava uma regra para acertar na próxima. */
  function aprender_(r, ctx) {
    if (ehTransf_(r) || !r.categoria || r.categoria === r.categoriaSugerida) return '';
    if (/sem nome da loja/i.test(r.descricao)) return '';
    const chave = palavraChave_(r.descricao);
    if (!chave) return '';
    try {
      FF.saveRegraSubstituindo({
        condicao_campo: 'descricao',
        condicao_operador: 'contains',
        condicao_valor: chave,
        acao_campo: 'categoria',
        acao_valor: r.categoria,
        prioridade: PRIORIDADE_APRENDIDA,
        ativo: true
      });
      const cat = Contexto.acharCategoria(ctx, r.categoria);
      return 'Aprendi: "' + chave + '" → ' + (cat ? cat.caminho : 'categoria');
    } catch (e) {
      console.warn('não consegui criar a regra: ' + e);
      return '';
    }
  }

  /* ---------------------------------------------------------------- ações */

  function confirmarTransferencia_(r) {
    const hoje = Formato.hoje();
    const res = FF.criarTransferencia({
      valor: Math.abs(Number(r.valor)),
      conta_origem: r.conta,
      conta_destino: r.contaDestino,
      data: r.data,
      descricao: r.descricao || 'Transferência',
      status: r.data > hoje ? 'agendado' : 'confirmado'
    });
    const tid = res && res.transferencia_id;
    const ano = Number(r.data.slice(0, 4)), mes = Number(r.data.slice(5, 7));
    return FF.listLancamentos({ ano: ano, mes: mes })
      .filter(l => tid && l.transferencia_id === tid)
      .map(l => String(l.id));
  }

  function confirmar_(r, ctx) {
    if (ehTransf_(r)) {
      r.ids = confirmarTransferencia_(r);
    } else {
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
        origem: r.origem || 'telegram',
        quem: r.quem,
        observacao: (r.origem === 'notificacao' ? 'Notificação: ' : 'Telegram: ') + String(r.textoOriginal || '').slice(0, 200)
      };
      let criados;
      if (r.parcelas > 1) {
        criados = FF.criarParcelamento(registro, r.parcelas, 1, 'mensal', 1) || [];
      } else {
        criados = [FF.saveLancamento(registro)];
      }
      r.ids = criados.filter(Boolean).map(l => String(l.id));
    }
    const aprendido = aprender_(r, ctx);
    r.estado = 'salvo';
    salvar(r);
    cache_().put('ultimo_' + r.usuarioId, r.chave, TTL);

    const titulo = r.parcelas > 1 && !ehTransf_(r) ? 'Lançado em ' + r.parcelas + ' parcelas' : 'Lançado';
    let texto = textoResumo_(r, ctx, titulo);
    if (aprendido) texto += '\n\n<i>' + Telegram.esc(aprendido) + '</i>';
    Telegram.editar(r.chatId, r.messageId, texto, [[botao_('Desfazer', 'u|' + r.chave)]]);
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
    const editar = (pergunta, botoes) => Telegram.editar(r.chatId, r.messageId, textoResumo_(r, ctx) + '\n\n<b>' + pergunta + '</b>', botoes);

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
    if (acao === 'v') { atualizar(r, ctx); return ''; }
    if (acao === 'mp') { editar('Pagou com qual?', tecladoPagamento_(r, ctx)); return ''; }
    if (acao === 'sp') {
      const id = arg.slice(1);
      if (arg.charAt(0) === 'c' && Contexto.acharCartao(ctx, id)) { r.cartao = id; r.conta = ''; }
      else if (arg.charAt(0) === 'a' && Contexto.acharConta(ctx, id)) { r.conta = id; r.cartao = ''; }
      salvar(r); atualizar(r, ctx); return '';
    }
    if (acao === 'mc') { editar('Qual categoria?', tecladoCategoriasPai_(r, ctx)); return ''; }
    if (acao === 'cp') {
      const temFilhas = ctx.categorias.some(c => c.pai === arg);
      if (!temFilhas) { r.categoria = arg; salvar(r); atualizar(r, ctx); return ''; }
      editar('Qual categoria?', tecladoCategoriasFilhas_(r, ctx, arg));
      return '';
    }
    if (acao === 'sc') {
      r.categoria = (arg === '-') ? '' : (Contexto.acharCategoria(ctx, arg) ? arg : r.categoria);
      salvar(r); atualizar(r, ctx); return '';
    }
    if (acao === 'md') { editar('Quando foi?', tecladoData_(r)); return ''; }
    if (acao === 'sd') {
      if (Formato.ehDataISO(arg)) r.data = arg;
      salvar(r); atualizar(r, ctx); return '';
    }
    if (acao === 'tt') {
      r.tipo = r.tipo === 'receita' ? 'despesa' : 'receita';
      const cat = r.categoria ? Contexto.acharCategoria(ctx, r.categoria) : null;
      if (cat && cat.tipo !== r.tipo) r.categoria = '';
      salvar(r); atualizar(r, ctx); return '';
    }
    // Transferência entre contas
    if (acao === 'tf') {
      // A conta atual vira origem (despesa) ou destino (receita); cartão não entra
      const contaAtual = r.cartao ? '' : r.conta;
      if (r.tipo === 'receita') { r.contaDestino = contaAtual; r.conta = ''; }
      else { r.conta = contaAtual; r.contaDestino = ''; }
      r.tipo = 'transferencia'; r.cartao = ''; r.categoria = ''; r.parcelas = 1;
      salvar(r); atualizar(r, ctx); return '';
    }
    if (acao === 'td') {
      r.tipo = 'despesa'; r.contaDestino = '';
      salvar(r); atualizar(r, ctx); return '';
    }
    if (acao === 'mo') { editar('Saiu de qual conta?', tecladoContas_(r, ctx, 'so', r.contaDestino)); return ''; }
    if (acao === 'mt') { editar('Foi para qual conta?', tecladoContas_(r, ctx, 'st', r.conta)); return ''; }
    if (acao === 'so' || acao === 'st') {
      if (Contexto.acharConta(ctx, arg)) {
        if (acao === 'so') r.conta = arg; else r.contaDestino = arg;
      }
      salvar(r); atualizar(r, ctx); return '';
    }
    return '';
  }

  return {
    criar: criar,
    ler: ler,
    salvar: salvar,
    mostrarNovo: mostrarNovo,
    atualizar: atualizar,
    desfazer: desfazer,
    tratarBotao: tratarBotao
  };
})();
