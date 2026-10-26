/**
 * Notificacoes.js — recebe as notificações de compra que o MacroDroid captura no
 * Android e transforma em lançamento com status "revisar": ele já entra na
 * planilha (fila "Para revisar" do app) e aparece no Telegram com os botões.
 * Transferências entre contas suas continuam só como rascunho no Telegram.
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
  // Compra que não aconteceu: não vira lançamento
  const EH_RECUSADA = /recusad|negad|nao aprovad|nao autorizad|cancelad|bloquead|saldo insuficiente/;

  // Palavra no app/texto -> sigla usada no fim do nome da conta ou do cartão
  const BANCOS = [
    { re: /\bxp\b/, sigla: 'XP' },
    { re: /itau|\biti\b|iti_/, sigla: 'IT' },
    { re: /banco do brasil|\bbb\b|ourocard/, sigla: 'BB' },
    { re: /caixa/, sigla: 'CX' },
    { re: /pluxee|sodexo/, sigla: 'PX' },
    { re: /nubank|\bnu\b/, sigla: 'NU' }
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
   * Compra parcelada: "em 12x", "12x de R$ 50,90", "em 3 parcelas", "10 vezes".
   * Devolve { n, porParcela } ou null. porParcela = o valor citado é o de cada parcela.
   */
  function parcelas_(n) {
    let m = n.match(/\b(\d{1,2})\s?x\s+de\s+r\$/);
    if (m) return { n: Number(m[1]), porParcela: true };
    m = n.match(/(?:\bem\s+|\b)(\d{1,2})\s?x\b/) || n.match(/\bem\s+(\d{1,2})\s+(?:parcelas|vezes)\b/);
    if (m) return { n: Number(m[1]), porParcela: false };
    return null;
  }

  /** Tira do nome da loja o pedaço das parcelas: "12x em QCONCURSOS" -> "QCONCURSOS". */
  function semParcelas_(s) {
    return String(s || '')
      .replace(/^\s*\d{1,2}\s?x\s+(?:de\s+R\$\s?[\d.,]+\s+)?(?:em\s+)?/i, '')
      .replace(/\s+(?:em\s+)?\d{1,2}\s?x\s*$/i, '')
      .replace(/\s+em\s+\d{1,2}\s+(?:parcelas|vezes)\s*$/i, '')
      .trim();
  }

  /**
   * Lê uma notificação. Devolve null se não for gasto.
   * { valor, local, data, meio: 'cartao'|'conta', generico, base, parcelas }
   * valor é sempre o total da compra; parcelas = 1 se à vista.
   */
  function extrair(app, titulo, texto) {
    const sem = Formato.semAcento(String(texto || ''));
    const nApp = norm_(app);
    const n = norm_(titulo + ' ' + texto);
    const valor = valor_(texto) || valor_(titulo);
    if (!valor) return null;

    if (EH_RECUSADA.test(n)) return null;
    const ex = { valor: valor, local: '', data: Formato.hoje(), meio: 'cartao', direcao: 'saida', generico: false, base: n + ' ' + nApp, parcelas: 1 };

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
      if ((m = sem.match(/enviou um pix para (.+?)(?:\s+\d{11,14})?\s+no valor/i)) ||
          (m = sem.match(/enviou R\$\s?[\d.,]+ (?:via pix )?para (.+?)(?:,| CPF| CNPJ|\.|$)/i))) {
        ex.local = 'Pix para ' + limparLocal_(m[1]);
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
    // Cartão de débito tira direto da conta
    if (/\bdebito\b/.test(n)) ex.meio = 'conta';

    // Parcelado: só no crédito; o valor guardado é o total
    const par = ex.meio === 'cartao' ? parcelas_(n) : null;
    if (par && par.n > 1 && par.n <= 48) {
      ex.parcelas = par.n;
      if (par.porParcela) ex.valor = Math.round(ex.valor * par.n * 100) / 100;
    }
    ex.local = limparLocal_(semParcelas_(ex.local)) || ex.local;

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
    const alvo = norm_(pessoa).replace(/^pix para /, '');
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

  function lancadoPorCupom_(ex) {
    try {
      return Cupom.acharParecido(ex.valor, ex.direcao === 'entrada' ? 'receita' : 'despesa', ex.data, true);
    } catch (e) {
      console.warn('procura de cupom falhou: ' + e);
      return null;
    }
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

    // Já lançado pela foto do cupom (a foto chegou antes da notificação)
    const jaDoCupom = lancadoPorCupom_(ex);
    if (jaDoCupom) {
      Telegram.enviar(uid, '<i>Notificação · ' + Telegram.esc(app || 'banco') + '</i>\n' + Formato.brl(ex.valor) +
        ' já está lançado pela foto do cupom: ' + Telegram.esc(jaDoCupom.descricao) + '.');
      return 'ja-lancado';
    }

    // Dinheiro recebido de outra pessoa: receita
    if (ex.direcao === 'entrada') {
      const r = novoRascunho_({
        tipo: 'receita', valor: ex.valor, data: ex.data,
        descricao: ex.local === 'Pix recebido' ? 'Pix recebido' : 'Pix de ' + ex.local,
        conta: dest.conta, cartao: '', categoria: ''
      }, uid, quem, app, titulo, texto);
      Rascunho.gravarParaRevisar(r);
      Rascunho.mostrarNovo(r, ctx);
      return 'receita';
    }

    const r = novoRascunho_({
      tipo: 'despesa', valor: ex.valor, data: ex.data, descricao: ex.local, parcelas: ex.parcelas || 1,
      conta: dest.conta, cartao: dest.cartao, categoria: categoria_(ctx, ex, quem)
    }, uid, quem, app, titulo, texto);
    Rascunho.gravarParaRevisar(r);
    Rascunho.mostrarNovo(r, ctx);
    return 'ok';
  }

  return { processar: processar, extrair: extrair, destino: destino };
})();
