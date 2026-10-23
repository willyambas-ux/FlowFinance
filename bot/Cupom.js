/**
 * Cupom.js — lê a foto de um cupom fiscal (NFC-e), nota ou comprovante (Pix,
 * maquininha) e monta o rascunho do lançamento.
 *
 * Se já existe na planilha um lançamento do mesmo valor em data próxima (por
 * exemplo, o que veio da notificação do banco), o rascunho oferece "Juntar":
 * o cupom completa esse lançamento em vez de criar outro.
 */
const Cupom = (function () {
  const LIMITE_BYTES = 4.5 * 1024 * 1024; // a API aceita até 5 MB por imagem
  const DIAS_PROCURA = 2;                   // procura o mesmo valor até 2 dias antes/depois

  const FERRAMENTA = {
    name: 'ler_cupom',
    description: 'Registra o que foi lido na imagem de um cupom, nota fiscal ou comprovante de pagamento.',
    input_schema: {
      type: 'object',
      properties: {
        e_comprovante: { type: 'boolean', description: 'true se a imagem é um cupom, nota ou comprovante de pagamento/recebimento.' },
        tipo: { type: 'string', enum: ['despesa', 'receita'], description: 'receita só se a pessoa recebeu o dinheiro.' },
        loja: { type: 'string', description: 'Nome curto e amigável do estabelecimento, com capitalização normal (ex.: "Marsel Center"). Sem LTDA, ME, S/A, códigos.' },
        razao_social: { type: ['string', 'null'] },
        cnpj: { type: ['string', 'null'] },
        valor_total: { type: ['number', 'null'], description: 'Valor efetivamente pago, já com descontos (ex.: "Valor a pagar").' },
        data: { type: ['string', 'null'], description: 'Data da compra/pagamento, YYYY-MM-DD.' },
        hora: { type: ['string', 'null'], description: 'HH:MM' },
        forma_pagamento: { type: ['string', 'null'], enum: ['credito', 'debito', 'pix', 'dinheiro', 'vale', 'boleto', 'outro', null] },
        parcelas: { type: 'integer', description: '1 se à vista.' },
        itens: {
          type: 'array',
          description: 'Itens da nota (no máximo 30). Vazio em comprovantes sem itens.',
          items: {
            type: 'object',
            properties: {
              descricao: { type: 'string' },
              quantidade: { type: ['number', 'null'] },
              valor: { type: ['number', 'null'], description: 'Valor total do item.' }
            },
            required: ['descricao']
          }
        },
        desconto: { type: ['number', 'null'] },
        chave_acesso: { type: ['string', 'null'], description: 'Chave de acesso da NFC-e/NF-e, só os 44 dígitos.' },
        conta_id: { type: ['string', 'null'], description: 'id de conta da lista, só se a legenda ou o comprovante indicar com segurança.' },
        cartao_id: { type: ['string', 'null'], description: 'id de cartão da lista, só se a legenda indicar com segurança.' },
        categoria_id: { type: ['string', 'null'], description: 'Categoria mais específica da lista, pensando nos itens e no tipo de loja.' },
        legivel: { type: 'boolean', description: 'false se a foto está ilegível demais para confiar no valor.' }
      },
      required: ['e_comprovante', 'legivel']
    }
  };

  function sistema_(ctx, quem, legenda) {
    return [
      'Você lê fotos de cupons fiscais, notas (NFC-e/DANFE), comprovantes de maquininha e de Pix de um casal brasileiro que controla as finanças.',
      'Responda sempre chamando a ferramenta ler_cupom.',
      '',
      'Hoje é ' + Formato.hoje() + '. Quem mandou a foto: ' + quem + '.',
      legenda ? 'Legenda escrita pela pessoa (tem prioridade sobre a imagem para pagamento e categoria): "' + legenda + '"' : 'A foto veio sem legenda.',
      '',
      'Regras:',
      '- valor_total: o que foi pago de fato (depois de descontos). Use ponto decimal.',
      '- forma_pagamento: "CARTÃO CRÉDITO" = credito; "DÉBITO" = debito; "PIX" = pix; vale-refeição/alimentação = vale.',
      '- Comprovante em que a pessoa é a pagadora é despesa. Só é receita se ela recebeu.',
      '- Datas em formato brasileiro (dd/mm/aa) viram YYYY-MM-DD.',
      '- conta_id/cartao_id: use SOMENTE ids das listas e só com indicação clara (legenda "xp", "itaú", nome do banco no comprovante). Na dúvida, null.',
      '- Os nomes seguem "NN tipo BANCO": cc = conta corrente, cred = cartão de crédito, vr = vale, ci = investimento.',
      '- Se não for comprovante (foto de outra coisa), e_comprovante = false.',
      '',
      Interpretador.listas(ctx)
    ].join('\n');
  }

  /** Arquivo da mensagem: maior foto, ou documento de imagem/PDF. */
  function arquivoDaMensagem(msg) {
    if (msg.photo && msg.photo.length) {
      const maior = msg.photo.slice().sort((a, b) => (b.file_size || b.width * b.height) - (a.file_size || a.width * a.height))[0];
      return { fileId: maior.file_id, mime: 'image/jpeg' };
    }
    const doc = msg.document;
    if (doc && /^image\/(jpeg|png|webp|gif)$|^application\/pdf$/.test(String(doc.mime_type || ''))) {
      return { fileId: doc.file_id, mime: doc.mime_type };
    }
    return null;
  }

  function lerImagem_(arquivo, ctx, quem, legenda) {
    const blob = Telegram.baixar(arquivo.fileId, LIMITE_BYTES, 'foto');
    const dados = Utilities.base64Encode(blob.getBytes());
    const bloco = arquivo.mime === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: dados } }
      : { type: 'image', source: { type: 'base64', media_type: arquivo.mime, data: dados } };
    return Interpretador.chamarIA(sistema_(ctx, quem, legenda), [
      bloco,
      { type: 'text', text: 'Leia este comprovante.' + (legenda ? ' Legenda: ' + legenda : '') }
    ], FERRAMENTA, 2048);
  }

  function num_(v) {
    const n = Number(v);
    return isFinite(n) ? n : null;
  }

  /** Texto que vai para a observação do lançamento. */
  function observacao_(b) {
    const L = ['Cupom: ' + (b.razao_social || b.loja || '')];
    if (b.cnpj) L.push('CNPJ ' + b.cnpj);
    if (b.hora) L.push(b.hora);
    const itens = Array.isArray(b.itens) ? b.itens : [];
    if (itens.length) {
      L.push(itens.slice(0, 15).map(i => {
        const q = num_(i.quantidade);
        const v = num_(i.valor);
        return String(i.descricao || '').trim() + (q && q !== 1 ? ' x' + q : '') + (v ? ' ' + Formato.brl(v) : '');
      }).join('; ') + (itens.length > 15 ? '; +' + (itens.length - 15) + ' itens' : ''));
    }
    if (num_(b.desconto)) L.push('desconto ' + Formato.brl(num_(b.desconto)));
    if (b.chave_acesso) L.push('chave NFC-e ' + String(b.chave_acesso).replace(/\D/g, ''));
    return L.join(' | ').slice(0, 900);
  }

  /** Linha curta dos itens para o Telegram. */
  function resumoItens_(b) {
    const itens = Array.isArray(b.itens) ? b.itens : [];
    if (!itens.length) return '';
    const nomes = itens.slice(0, 3).map(i => {
      const q = num_(i.quantidade);
      return String(i.descricao || '').trim().toLowerCase() + (q && q !== 1 ? ' ×' + q : '');
    });
    return itens.length + (itens.length === 1 ? ' item: ' : ' itens: ') + nomes.join(', ') + (itens.length > 3 ? '…' : '');
  }

  /**
   * Procura um lançamento já gravado do mesmo valor e sentido, em data próxima,
   * Prefere os da fila "revisar" e a data mais perto.
   * deCupom = false: só os que não vieram de cupom (o cupom procura a notificação).
   * deCupom = true: só os que vieram de cupom (a notificação procura o cupom).
   */
  function acharParecido(valor, tipo, data, deCupom) {
    const alvo = Math.round(Math.abs(valor) * 100);
    const base = new Date(data + 'T12:00:00');
    const meses = {};
    [-DIAS_PROCURA, DIAS_PROCURA, 0].forEach(d => {
      const x = new Date(base.getTime() + d * 86400000);
      meses[x.getFullYear() + '-' + (x.getMonth() + 1)] = [x.getFullYear(), x.getMonth() + 1];
    });
    let todos = [];
    Object.keys(meses).forEach(k => {
      todos = todos.concat(FF.listLancamentos({ ano: meses[k][0], mes: meses[k][1] }) || []);
    });
    const dist = l => Math.abs((new Date(String(l.data).slice(0, 10) + 'T12:00:00') - base) / 86400000);
    const candidatos = todos.filter(l => {
      const v = Number(l.valor);
      if (Math.round(Math.abs(v) * 100) !== alvo) return false;
      if ((tipo === 'receita') !== (v > 0)) return false;
      if (l.transferencia_id) return false;
      const veioDeCupom = l.origem === 'cupom' || /(^|\n)Cupom:/.test(String(l.observacao || ''));
      if (veioDeCupom !== !!deCupom) return false;
      return dist(l) <= DIAS_PROCURA;
    });
    candidatos.sort((a, b) => {
      const ra = a.status === 'revisar' ? 0 : 1, rb = b.status === 'revisar' ? 0 : 1;
      return ra - rb || dist(a) - dist(b);
    });
    return candidatos[0] || null;
  }

  /**
   * Ponto de entrada: foto ou documento recebido no Telegram.
   */
  function processar(msg, chatId, usuarioId, quem) {
    const arquivo = arquivoDaMensagem(msg);
    if (!arquivo) return false;
    Telegram.digitando(chatId);
    const legenda = String(msg.caption || '').trim();
    const ctx = Contexto.carregar();

    let b;
    try {
      b = lerImagem_(arquivo, ctx, quem, legenda);
    } catch (err) {
      console.error('cupom: ' + (err && err.stack ? err.stack : err));
      Telegram.enviar(chatId, 'Não consegui ler a foto: ' + Telegram.esc(String(err.message || err)));
      return true;
    }

    if (!b.e_comprovante) {
      Telegram.enviar(chatId, 'Não reconheci um cupom ou comprovante nessa foto. Se for um gasto, mande a foto do cupom ou escreva, como "almoço 32,50 débito itaú".');
      return true;
    }

    const tipo = b.tipo === 'receita' ? 'receita' : 'despesa';
    const valor = num_(b.valor_total) > 0 ? Math.round(num_(b.valor_total) * 100) / 100 : null;
    const r = {
      tipo: tipo,
      valor: b.legivel === false && !valor ? null : valor,
      data: Formato.ehDataISO(b.data) && b.data <= Formato.hoje(30) ? b.data : Formato.hoje(),
      descricao: String(b.loja || b.razao_social || 'Cupom').trim().slice(0, 80),
      conta: '', cartao: '', categoria: '',
      parcelas: Math.max(1, Math.min(48, Math.floor(num_(b.parcelas) || 1))),
      duvidas: [],
      chatId: chatId,
      usuarioId: usuarioId,
      quem: quem,
      origem: 'cupom',
      cabecalho: 'Cupom · ' + String(b.loja || b.razao_social || 'foto').trim() + (b.forma_pagamento ? ' · ' + rotuloPagamento_(b.forma_pagamento) : ''),
      itensResumo: resumoItens_(b),
      observacao: observacao_(b),
      textoOriginal: legenda
    };

    if (b.cartao_id && Contexto.acharCartao(ctx, b.cartao_id)) r.cartao = String(b.cartao_id);
    else if (b.conta_id && Contexto.acharConta(ctx, b.conta_id)) r.conta = String(b.conta_id);
    // Crédito só existe em cartão; se há um cartão só, é ele
    if (!r.cartao && !r.conta && b.forma_pagamento === 'credito' && ctx.cartoes.length === 1) r.cartao = ctx.cartoes[0].id;
    // Vale: se há uma conta de vale só, é ela
    if (!r.cartao && !r.conta && b.forma_pagamento === 'vale') {
      const vales = ctx.contas.filter(c => /\bvr\b|vale/i.test(c.nome + ' ' + c.tipo));
      if (vales.length === 1) r.conta = vales[0].id;
    }

    const cat = b.categoria_id ? Contexto.acharCategoria(ctx, b.categoria_id) : null;
    if (cat && cat.tipo === tipo) r.categoria = cat.id;
    const daRegra = Interpretador.categoriaPorRegra(legenda, r.descricao + ' ' + (b.razao_social || ''));
    const catRegra = daRegra ? Contexto.acharCategoria(ctx, daRegra) : null;
    if (catRegra && catRegra.tipo === tipo) r.categoria = catRegra.id;

    if (r.valor) {
      try {
        const par = acharParecido(r.valor, tipo, r.data, false);
        if (par) {
          r.parecido = {
            id: String(par.id),
            descricao: String(par.descricao || ''),
            data: String(par.data).slice(0, 10),
            status: String(par.status || ''),
            origem: String(par.origem || '')
          };
        }
      } catch (e) {
        console.warn('procura de parecido falhou: ' + e);
      }
    }

    const rasc = Rascunho.criar(r);
    Rascunho.mostrarNovo(rasc, ctx);
    return true;
  }

  function rotuloPagamento_(f) {
    return { credito: 'crédito', debito: 'débito', pix: 'Pix', dinheiro: 'dinheiro', vale: 'vale', boleto: 'boleto' }[f] || 'outro';
  }

  return { processar: processar, arquivoDaMensagem: arquivoDaMensagem, acharParecido: acharParecido, FERRAMENTA: FERRAMENTA };
})();
