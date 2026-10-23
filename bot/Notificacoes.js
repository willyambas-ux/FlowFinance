/**
 * Notificacoes.js — recebe as notificações de compra que o MacroDroid captura no
 * Android e transforma em rascunho de lançamento no Telegram (você confirma).
 *
 * Chamada: POST <WEBAPP_URL>?secret=<WEBHOOK_SECRET>&origem=notificacao&uid=<id do Telegram>
 * Corpo (formulário ou JSON): app, titulo, texto
 */
const Notificacoes = (function () {
  const JANELA_DUPLICADA_SEG = 900; // 15 min: mesma compra avisada por dois apps

  // Só passa o que é gasto de verdade; boletos, promoções e avisos ficam de fora
  const EH_GASTO = /compra.{0,40}aprovad|aprovad.{0,25}compra|voce enviou um pix|pix (enviado|realizado|efetuado)|transferencia (enviada|realizada|efetuada)|pagamento (aprovado|realizado|efetuado)/;
  const EH_CARTEIRA = /carteira|wallet/;
  const EH_RECEBIDO = /voce recebeu|pix recebido|recebeu um pix|transferencia recebida/;

  // Palavra no app/texto -> sigla usada no fim do nome da conta ou do cartão
  const BANCOS = [
    { re: /\bxp\b/, sigla: 'XP' },
    { re: /itau|\biti\b|iti_/, sigla: 'IT' },
    { re: /banco do brasil|\bbb\b|ourocard/, sigla: 'BB' },
    { re: /caixa/, sigla: 'CX' },
    { re: /pluxee|sodexo/, sigla: 'PX' }
  ];

  function norm_(s) {
    return Formato.semAcento(String(s || '')).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function valor_(s) {
    const m = String(s || '').match(/R\$\s?([\d.]+,\d{2})/);
    return m ? Number(m[1].replace(/\./g, '').replace(',', '.')) : null;
  }

  /** "AMAZON SERVICOS DE VAREJO DO BRASIL LTDA" -> "Amazon Servicos De Varejo Do Brasil" */
  function limparLocal_(s) {
    let t = String(s || '').trim()
      .replace(/^DL\*/i, '')                       // intermediário de pagamento
      .replace(/\s+\d{3,}$/, '')                   // código da loja: "EXTRA 7424"
      .replace(/\s+(LTDA|S\/?A|ME|EPP|EIRELI)\.?$/i, '')
      .trim();
    if (!t) return '';
    if (t === t.toUpperCase()) {
      t = t.toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());
    }
    return t.slice(0, 60);
  }

  function dataDe_(dia, mes) {
    const hoje = Formato.hoje();
    let ano = Number(hoje.slice(0, 4));
    let iso = ano + '-' + String(mes).padStart(2, '0') + '-' + String(dia).padStart(2, '0');
    if (iso > hoje) iso = (ano - 1) + iso.slice(4); // virada de ano
    return iso;
  }

  /**
   * Lê uma notificação. Devolve null se não for gasto.
   * { valor, local, data, meio: 'cartao'|'conta', generico, base }
   */
  function extrair(app, titulo, texto) {
    const sem = Formato.semAcento(String(texto || ''));
    const nApp = norm_(app);
    const n = norm_(titulo + ' ' + texto);
    const valor = valor_(texto) || valor_(titulo);
    if (!valor) return null;

    const ex = { valor: valor, local: '', data: Formato.hoje(), meio: 'cartao', direcao: 'saida', generico: false, base: n + ' ' + nApp };

    if (EH_RECEBIDO.test(n)) {
      // "Você recebeu R$ 1,00 de WILLYAM, CPF ..." / "Você recebeu um Pix de FULANO no valor de R$ ..."
      const m = sem.match(/recebeu (?:um pix )?(?:de R\$\s?[\d.,]+ )?de (.+?)(?:,| CPF| no valor|\.|$)/i) ||
                sem.match(/recebeu R\$\s?[\d.,]+ de (.+?)(?:,| CPF|\.|$)/i);
      ex.direcao = 'entrada';
      ex.meio = 'conta';
      ex.local = m ? limparLocal_(m[1]) : '';
      if (!ex.local) { ex.local = 'Pix recebido'; }
      return ex;
    }

    if (EH_CARTEIRA.test(nApp)) {
      // Carteira do Google: título = loja; texto = "R$ 26,28 com NCC_Iti_Platinum • 4741"
      ex.local = limparLocal_(titulo);
    } else if (!EH_GASTO.test(n)) {
      return null;
    } else {
      let m;
      if ((m = sem.match(/enviou um pix para (.+?)(?:\s+\d{11,14})?\s+no valor/i))) {
        ex.local = limparLocal_(m[1]);
        ex.meio = 'conta';
      } else if ((m = sem.match(/aprovada de R\$\s?[\d.,]+ em (.+?) no dia (\d{2})\/(\d{2})/i))) {
        ex.local = limparLocal_(m[1]);
        ex.data = dataDe_(m[2], m[3]);
      } else if ((m = sem.match(/R\$\s?[\d.,]+ APROVADA em (.+?)(?: via|\.|$)/i))) {
        ex.local = limparLocal_(m[1]);
      } else if ((m = sem.match(/ em ([^.,]{2,40}?)(?: no dia| via|\.|,|$)/i))) {
        ex.local = limparLocal_(m[1]);
      }
      if (/pix|transferencia/.test(n) && !/compra/.test(n)) ex.meio = 'conta';
    }

    if (!ex.local || /^dl$/i.test(ex.local)) {
      ex.generico = true;
      ex.local = ex.local ? 'Compra DL (sem nome da loja)' : 'Compra (sem nome da loja)';
    }
    return ex;
  }

  function siglaDe_(nome) {
    const partes = String(nome || '').trim().split(/\s+/);
    return (partes[partes.length - 1] || '').toUpperCase();
  }

  /** Escolhe o cartão ou a conta pelo banco citado no app/texto. */
  function destino(ctx, ex) {
    const banco = BANCOS.find(b => b.re.test(ex.base));
    if (!banco) return { conta: '', cartao: '' };

    if (banco.sigla === 'PX') { // vale-refeição/alimentação é conta do tipo vale
      const vale = ctx.contas.find(c => c.tipo === 'vale' && siglaDe_(c.nome).indexOf('PX') === 0);
      return { conta: vale ? vale.id : '', cartao: '' };
    }
    if (ex.meio === 'cartao') {
      const cartao = ctx.cartoes.find(c => siglaDe_(c.nome).indexOf(banco.sigla) === 0);
      if (cartao) return { conta: '', cartao: cartao.id };
    }
    const conta = ctx.contas.find(c => (c.tipo === 'corrente' || c.tipo === 'vale') && siglaDe_(c.nome) === banco.sigla);
    return { conta: conta ? conta.id : '', cartao: '' };
  }

  function categoria_(ctx, ex, quem) {
    if (ex.generico) return '';
    try {
      const r = FF.aplicarRegras({ descricao: Formato.semAcento(ex.local).toUpperCase() });
      const cat = r && r.categoria ? Contexto.acharCategoria(ctx, r.categoria) : null;
      if (cat && cat.tipo === 'despesa') return cat.id;
    } catch (e) { /* segue para a IA */ }
    try {
      const lido = Interpretador.interpretar('compra de ' + Formato.brl(ex.valor) + ' em ' + ex.local, quem, ctx);
      return lido.categoria || '';
    } catch (e) {
      console.warn('categoria por IA falhou: ' + e);
      return '';
    }
  }

  /** A pessoa do Pix é o próprio usuário? Compara o primeiro nome (e NOMES_PROPRIOS, se houver). */
  function ehProprio_(quem, pessoa) {
    const alvo = norm_(pessoa);
    if (!alvo) return false;
    const nomes = [quem];
    try { (JSON.parse(Config.get('NOMES_PROPRIOS', '[]')) || []).forEach(n => nomes.push(n)); } catch (e) { /* ignora */ }
    return nomes.some(n => {
      const nn = norm_(n);
      if (!nn) return false;
      return alvo === nn || alvo.indexOf(nn + ' ') === 0 || nn.split(' ')[0] === alvo.split(' ')[0] && nn.split(' ')[0].length >= 4;
    });
  }

  function novoRascunho_(base, uid, quem, app, titulo, texto) {
    return Rascunho.criar(Object.assign({
      parcelas: 1,
      duvidas: [],
      chatId: uid,
      usuarioId: uid,
      quem: quem,
      origem: 'notificacao',
      cabecalho: 'Notificação · ' + (app || 'banco'),
      textoOriginal: (titulo ? titulo + ': ' : '') + texto
    }, base));
  }

  /** Ponto de entrada (chamado pelo doPost). */
  function processar(p) {
    const uid = String(p.uid || '');
    const quem = Config.nomeDoUsuario(uid);
    if (!quem) { console.warn('notificação de uid não liberado: ' + uid); return 'uid'; }

    const app = String(p.app || ''), titulo = String(p.titulo || ''), texto = String(p.texto || '');
    const ex = extrair(app, titulo, texto);
    if (!ex) { console.log('ignorada: ' + app + ' | ' + titulo + ' | ' + texto); return 'ignorada'; }

    // Mesma compra avisada por dois apps (ou duas vezes): fica a primeira.
    // A direção entra na chave: saída e entrada do mesmo valor são coisas diferentes.
    const cache = CacheService.getScriptCache();
    const cents = Math.round(ex.valor * 100);
    const marca = 'notif_' + uid + '_' + ex.direcao + '_' + cents;
    if (cache.get(marca)) { console.log('duplicada: ' + app + ' ' + ex.valor); return 'duplicada'; }
    cache.put(marca, '1', JANELA_DUPLICADA_SEG);

    const ctx = Contexto.carregar();
    const dest = destino(ctx, ex);
    const proprio = ex.meio === 'conta' && ehProprio_(quem, ex.local);
    const chaveTransf = 'transf_' + uid + '_' + cents;
    const chaveEntrada = 'entrada_' + uid + '_' + cents;

    // Pix para você mesmo: transferência entre contas
    if (ex.direcao === 'saida' && proprio) {
      const r = novoRascunho_({
        tipo: 'transferencia', valor: ex.valor, data: ex.data,
        descricao: 'Transferência entre contas',
        conta: dest.conta, contaDestino: cache.get(chaveEntrada) || '', cartao: '', categoria: ''
      }, uid, quem, app, titulo, texto);
      if (r.contaDestino === r.conta) r.contaDestino = '';
      Rascunho.mostrarNovo(r, ctx);
      cache.put(chaveTransf, r.chave, JANELA_DUPLICADA_SEG);
      return 'transferencia';
    }

    // Pix recebido de você mesmo: completa a transferência que saiu da outra conta
    if (ex.direcao === 'entrada' && proprio) {
      const chave = cache.get(chaveTransf);
      const r = chave ? Rascunho.ler(chave) : null;
      if (r && r.estado === 'aberto' && !r.contaDestino && dest.conta && dest.conta !== r.conta) {
        r.contaDestino = dest.conta;
        Rascunho.salvar(r);
        Rascunho.atualizar(r, ctx);
        return 'transferencia-completa';
      }
      // A saída ainda não chegou (ou veio de banco não monitorado): guarda a conta de destino
      if (dest.conta) cache.put(chaveEntrada, dest.conta, JANELA_DUPLICADA_SEG);
      return 'entrada-aguardando';
    }

    // Dinheiro recebido de outra pessoa: receita
    if (ex.direcao === 'entrada') {
      const r = novoRascunho_({
        tipo: 'receita', valor: ex.valor, data: ex.data,
        descricao: ex.local === 'Pix recebido' ? 'Pix recebido' : 'Pix de ' + ex.local,
        conta: dest.conta, cartao: '', categoria: ''
      }, uid, quem, app, titulo, texto);
      Rascunho.mostrarNovo(r, ctx);
      return 'receita';
    }

    const r = novoRascunho_({
      tipo: 'despesa', valor: ex.valor, data: ex.data, descricao: ex.local,
      conta: dest.conta, cartao: dest.cartao, categoria: categoria_(ctx, ex, quem)
    }, uid, quem, app, titulo, texto);
    Rascunho.mostrarNovo(r, ctx);
    return 'ok';
  }

  return { processar: processar, extrair: extrair, destino: destino };
})();
