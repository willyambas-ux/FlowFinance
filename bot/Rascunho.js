/**
 * Rascunho.js — o lançamento em revisão no Telegram: guardar, mostrar, ajustar,
 * confirmar e desfazer.
 *
 * Tipos: despesa | receita | transferencia (entre duas contas suas).
 * Botões usam callback_data "acao|chave|arg" (limite do Telegram: 64 bytes).
 */
const Rascunho = (function () {
  // Rascunhos e atalhos ficam na Guarda (cache + Propriedades, alguns dias):
  // dá para validar de manhã a compra feita à noite.
  const PRIORIDADE_APRENDIDA = 10; // regra aprendida vale mais que as regras gerais


  function novaChave_() {
    return Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  }

  function salvar(r) {
    Guarda.put('rasc_' + r.chave, JSON.stringify(r));
    return r;
  }

  function ler(chave) {
    const raw = Guarda.get('rasc_' + chave);
    return raw ? JSON.parse(raw) : null;
  }

  function criar(dados) {
    const r = Object.assign({ chave: novaChave_(), estado: 'aberto', ids: [], contaDestino: '' }, dados);
    if (r.categoriaSugerida === undefined) r.categoriaSugerida = r.categoria || '';
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
    if (!titulo && r.revisar && r.estado === 'aberto') L.push('<i>Já está no app, na fila "Para revisar".</i>');

    const tipo = ehTransf_(r) ? 'Transferência' : (r.tipo === 'receita' ? 'Receita' : 'Despesa');
    L.push('<b>' + tipo + ' · ' + (faltaValor_(r) ? 'valor?' : Formato.brl(r.valor)) + '</b>');
    L.push(Telegram.esc(r.descricao));
    if (r.itensResumo) L.push('<i>' + Telegram.esc(r.itensResumo) + '</i>');
    if (!titulo && r.estado === 'aberto') {
      if (r.sefaz === 'buscando') L.push('<i>⏳ Buscando a nota na SEFAZ…</i>');
      else if (r.sefaz === 'ok') L.push('<i>✓ Itens conferidos na SEFAZ</i>');
      else if (r.sefaz === 'falhou') L.push('<i>SEFAZ indisponível (' + Telegram.esc(r.sefazMotivo || 'erro') + '); itens lidos da foto</i>');
    }

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
    if (r.parecido && r.estado === 'aberto') {
      const p = r.parecido;
      const origem = p.origem === 'notificacao' ? 'notificação' : (p.origem || 'planilha');
      return {
        texto: textoResumo_(r, ctx) + '\n\n<b>Já existe um lançamento parecido:</b>\n' +
          Telegram.esc(p.descricao) + ' · ' + Formato.brl(r.valor) + ' · ' + Formato.dataBR(p.data) +
          ' <i>(' + Telegram.esc(origem) + (p.status === 'revisar' ? ', para revisar' : '') + ')</i>\n' +
          'É o mesmo gasto?',
        botoes: [
          [botao_('Sim, juntar com ele', 'j|' + r.chave)],
          [botao_('Não, é outro gasto', 'n|' + r.chave), botao_('Cancelar', 'x|' + r.chave)]
        ]
      };
    }
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
      // Para achar o rascunho quando a pessoa responder a ele (ex.: mais uma foto do cupom)
      Guarda.put('msgr_' + r.chatId + '_' + r.messageId, r.chave);
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

  /** O lançamento como vai para a planilha. */
  function registro_(r, status) {
    const valor = Math.abs(Number(r.valor));
    return {
      data: r.data,
      descricao: r.descricao,
      valor: r.tipo === 'receita' ? valor : -valor,
      conta: r.cartao ? '' : r.conta,
      cartao: r.cartao || '',
      categoria: r.categoria || '',
      status: status,
      origem: r.origem || 'telegram',
      quem: r.quem,
      observacao: r.observacao || ((r.origem === 'notificacao' ? 'Notificação: ' : 'Telegram: ') + String(r.textoOriginal || '').slice(0, 200))
    };
  }

  /**
   * Notificação do banco: grava já, com status "revisar", para aparecer na fila do
   * app mesmo que ninguém toque no Telegram. Os botões continuam valendo: Confirmar
   * atualiza esse mesmo lançamento; Cancelar apaga.
   */
  function gravarParaRevisar(r) {
    if (ehTransf_(r) || faltaValor_(r)) return r;
    try {
      if (r.parcelas > 1) {
        // Parcelado: todas as parcelas já entram; só a 1ª vai para a fila de revisão
        const criados = FF.criarParcelamento(registro_(r, 'revisar'), r.parcelas, 1, 'mensal', 1) || [];
        r.ids = criados.filter(l => l && l.id).map(l => String(l.id));
        if (r.ids.length > 1) FF.updateLancamentosBatch(r.ids.slice(1), { status: 'agendado' });
      } else {
        const salvo = FF.saveLancamento(registro_(r, 'revisar'));
        r.ids = salvo && salvo.id ? [String(salvo.id)] : [];
      }
      r.revisar = r.ids.length > 0;
      // Para o cupom achar este rascunho e fechá-lo se juntar com ele
      if (r.revisar) Guarda.put('lancrasc_' + r.ids[0], r.chave);
    } catch (e) {
      console.warn('não consegui gravar para revisar: ' + e);
    }
    return salvar(r);
  }

  /**
   * Confirma pelo Telegram um lançamento que já está gravado como "revisar".
   * Devolve false se ele foi apagado ou já revisado no app (e avisa no chat).
   */
  function confirmarRevisar_(r, status) {
    const atual = FF.getLancamento(r.ids[0]);
    if (!atual) {
      r.estado = 'cancelado';
      salvar(r);
      Telegram.editar(r.chatId, r.messageId, '<s>' + Telegram.esc(r.descricao) + '</s>\nEsse lançamento foi apagado no app.', []);
      return false;
    }
    if (atual.status !== 'revisar') {
      r.estado = 'salvo';
      salvar(r);
      Telegram.editar(r.chatId, r.messageId, Telegram.esc(r.descricao) + ' · ' + Formato.brl(r.valor) + '\nJá foi revisado no app.', []);
      return false;
    }
    if (r.parcelas > 1) {
      // Refaz as parcelas com o que foi ajustado no Telegram (cartão, categoria, data)
      FF.deleteLancamentosBatch(r.ids);
      const criados = FF.criarParcelamento(registro_(r, status), r.parcelas, 1, 'mensal', 1) || [];
      r.ids = criados.filter(l => l && l.id).map(l => String(l.id));
      return r.ids.length > 0;
    }
    const novo = registro_(r, status);
    const mesmaFatura = novo.cartao && String(novo.cartao) === String(atual.cartao);
    FF.saveLancamento(Object.assign({}, atual, novo, {
      id: atual.id,
      fatura_competencia: mesmaFatura ? atual.fatura_competencia : ''
    }));
    return true;
  }

  function confirmar_(r, ctx) {
    const hoje = Formato.hoje();
    const status = r.data > hoje ? 'agendado' : 'confirmado';
    if (ehTransf_(r)) {
      r.ids = confirmarTransferencia_(r);
    } else if (r.revisar && r.ids.length) {
      if (!confirmarRevisar_(r, status)) return false;
    } else {
      const registro = registro_(r, status);
      let criados;
      if (r.parcelas > 1) {
        criados = FF.criarParcelamento(registro, r.parcelas, 1, 'mensal', 1) || [];
      } else {
        criados = [FF.saveLancamento(registro)];
      }
      r.ids = criados.filter(Boolean).map(l => String(l.id));
    }
    if (r.ids.length) gravarItens_(r, r.ids[0], r.data);
    const aprendido = aprender_(r, ctx);
    r.estado = 'salvo';
    salvar(r);
    Guarda.put('ultimo_' + r.usuarioId, r.chave);

    const titulo = r.parcelas > 1 && !ehTransf_(r) ? 'Lançado em ' + r.parcelas + ' parcelas' : 'Lançado';
    let texto = textoResumo_(r, ctx, titulo);
    if (aprendido) texto += '\n\n<i>' + Telegram.esc(aprendido) + '</i>';
    if (r.itensGravados) texto += '\n<i>' + r.itensGravados + (r.itensGravados === 1 ? ' item foi' : ' itens foram') + ' para o histórico de preços.</i>';
    Telegram.editar(r.chatId, r.messageId, texto, [[botao_('Desfazer', 'u|' + r.chave)]]);
    return true;
  }

  /**
   * Cupom do mesmo gasto que já está na planilha (ex.: veio da notificação):
   * completa aquele lançamento com loja, itens e categoria, sem criar outro.
   */
  function juntar_(r, ctx) {
    const atual = FF.getLancamento(r.parecido.id);
    if (!atual) {
      r.parecido = null;
      salvar(r); atualizar(r, ctx);
      return 'Não achei mais aquele lançamento';
    }
    const revisar = atual.status === 'revisar';
    const novo = {
      descricao: revisar ? (r.descricao || atual.descricao) : (atual.descricao || r.descricao),
      categoria: revisar ? (r.categoria || atual.categoria) : (atual.categoria || r.categoria),
      observacao: [String(atual.observacao || '').trim(), r.observacao].filter(Boolean).join('\n').slice(0, 1500)
    };
    if (revisar) novo.status = String(atual.data) > Formato.hoje() ? 'agendado' : 'confirmado';
    FF.saveLancamento(Object.assign({}, atual, novo, { id: atual.id }));
    gravarItens_(r, atual.id, String(atual.data).slice(0, 10));

    // O rascunho da notificação, se ainda aberto no Telegram, fica resolvido
    const chaveNotif = Guarda.get('lancrasc_' + atual.id);
    const outro = chaveNotif ? ler(chaveNotif) : null;
    if (outro && outro.estado === 'aberto') {
      outro.estado = 'salvo';
      salvar(outro);
      Telegram.editar(outro.chatId, outro.messageId,
        Telegram.esc(novo.descricao) + ' · ' + Formato.brl(outro.valor) + '\n<i>Completado com a foto do cupom.</i>', []);
    }

    // Mostra o resultado com o pagamento que já estava gravado
    r.antes = atual;
    r.ids = [String(atual.id)];
    r.descricao = novo.descricao;
    r.categoria = novo.categoria;
    r.conta = atual.cartao ? '' : String(atual.conta || '');
    r.cartao = String(atual.cartao || '');
    r.data = String(atual.data).slice(0, 10);
    r.parcelas = 1;
    r.parecido = null;
    r.estado = 'salvo';
    salvar(r);
    Guarda.put('ultimo_' + r.usuarioId, r.chave);
    let texto = textoResumo_(r, ctx, 'Juntado ao lançamento que já existia');
    if (r.itensGravados) texto += '\n<i>' + r.itensGravados + (r.itensGravados === 1 ? ' item foi' : ' itens foram') + ' para o histórico de preços.</i>';
    Telegram.editar(r.chatId, r.messageId, texto, [[botao_('Desfazer', 'u|' + r.chave)]]);
    return 'Juntado';
  }

  /** Itens do cupom vão para a aba Itens (histórico de preços), ligados ao lançamento. */
  function gravarItens_(r, lancamentoId, data) {
    if (!r.itens || !r.itens.length) return;
    try {
      const res = FF.salvarItensCupom(lancamentoId, Object.assign({ data: data }, r.cupomCab || {}), r.itens);
      r.itensGravados = res && res.gravados || 0;
    } catch (e) {
      console.warn('não consegui gravar os itens: ' + e);
    }
  }

  function desfazer(r) {
    if (r.estado !== 'salvo' || !r.ids.length) return false;
    if (r.itensGravados) {
      try { FF.removerItensDoLancamento(r.ids); } catch (e) { console.warn('itens: ' + e); }
    }
    if (r.antes) {
      // Juntado: volta o lançamento como estava, sem apagar
      FF.saveLancamento(Object.assign({}, r.antes, { id: r.antes.id }));
      r.estado = 'desfeito';
      salvar(r);
      Telegram.editar(r.chatId, r.messageId,
        '<s>Cupom ' + Telegram.esc(r.descricao) + ' · ' + Formato.brl(r.valor) + '</s>\nDesfeito: o lançamento voltou a ser como era.', []);
      return true;
    }
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
    if (!r) return 'Passou de ' + Guarda.DIAS + ' dias. Revise no app, na fila "Para revisar".';
    if (String(r.usuarioId) !== String(usuarioId)) return 'Esse lançamento é de outra pessoa.';

    if (acao === 'u') return desfazer(r) ? 'Desfeito' : 'Nada para desfazer';
    if (r.estado !== 'aberto') return 'Esse lançamento já foi resolvido.';

    const ctx = Contexto.carregar();
    const editar = (pergunta, botoes) => Telegram.editar(r.chatId, r.messageId, textoResumo_(r, ctx) + '\n\n<b>' + pergunta + '</b>', botoes);

    if (acao === 'ok') {
      if (faltaPagamento_(r) || faltaValor_(r)) return 'Falta informação';
      return confirmar_(r, ctx) ? 'Lançado' : 'Já resolvido no app';
    }
    if (acao === 'x') {
      let nota = 'Cancelado.';
      if (r.revisar && r.ids.length) {
        const atual = FF.getLancamento(r.ids[0]);
        if (atual && atual.status === 'revisar') {
          FF.deleteLancamentosBatch(r.ids);
          nota = 'Cancelado e apagado da fila de revisão.';
        } else if (atual) {
          nota = 'Já tinha sido revisado no app; ficou como está.';
        }
      }
      r.estado = 'cancelado';
      salvar(r);
      Telegram.editar(r.chatId, r.messageId, '<s>' + Telegram.esc(r.descricao) + '</s>\n' + nota, []);
      return 'Cancelado';
    }
    if (acao === 'j') return r.parecido ? juntar_(r, ctx) : '';
    if (acao === 'n') { r.parecido = null; salvar(r); atualizar(r, ctx); return ''; }
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
    gravarParaRevisar: gravarParaRevisar,
    ler: ler,
    salvar: salvar,
    mostrarNovo: mostrarNovo,
    atualizar: atualizar,
    desfazer: desfazer,
    tratarBotao: tratarBotao
  };
})();
