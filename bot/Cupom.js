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
          description: 'Todos os itens da nota (até 100). Vazio em comprovantes sem itens.',
          items: {
            type: 'object',
            properties: {
              descricao: { type: 'string', description: 'Texto do item como está no cupom.' },
              produto: { type: 'string', description: 'Nome padronizado e legível, sem marca nem código, para comparar preços entre lojas (ex.: "Lápis grafite 4B", "Arroz branco tipo 1 5kg", "Leite integral 1L").' },
              marca: { type: ['string', 'null'] },
              categoria_item: { type: 'string', description: 'Grupo > subgrupo do produto, em português (ex.: "Papelaria > Lápis", "Mercearia > Arroz", "Bebidas > Café", "Hortifrúti > Frutas", "Limpeza > Detergente", "Farmácia > Analgésico").' },
              quantidade: { type: ['number', 'null'] },
              unidade: { type: ['string', 'null'], description: 'un, kg, g, l, ml ou pct, como no cupom.' },
              valor_unitario: { type: ['number', 'null'] },
              valor: { type: ['number', 'null'], description: 'Valor total do item (quantidade × unitário).' }
            },
            required: ['descricao', 'produto']
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

  function sistema_(ctx, quem, legenda, fonte) {
    return [
      'Você lê fotos de cupons fiscais, notas (NFC-e/DANFE), comprovantes de maquininha e de Pix de um casal brasileiro que controla as finanças.',
      fonte === 'sefaz'
        ? 'Desta vez você recebe o TEXTO da página oficial da NFC-e no portal da SEFAZ (fonte exata): copie valores, quantidades e itens como estão. Se a página for erro, captcha ou não tiver a nota, e_comprovante = false. ' +
          'Se vier em campos do XML da nota: xFant/xNome = loja/razão social; dhEmi = data; xProd = item; qCom = quantidade; uCom = unidade; vUnCom = preço unitário; vProd = total do item; vDesc = desconto do item (valor do item = vProd - vDesc); vNF = valor pago; tPag: 01 dinheiro, 03 crédito, 04 débito, 10/11 vale, 17 pix.'
        : '',
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
      '- itens: leia todos os itens visíveis. Em produto, padronize o nome para comparar o mesmo produto entre lojas; use o mesmo padrão sempre.',
      '- categoria_id: pense no que foi comprado (a maioria dos itens) e no tipo de loja. Ex.: lápis, caderno = material escolar ou papelaria; comida de supermercado = mercado. Mensalidade é só pagamento à escola. Se nenhuma categoria da lista servir bem, use null.',
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

  const MAX_FOTOS = 6;
  const LIMITE_TOTAL = 18 * 1024 * 1024; // base64 de todas as fotos numa chamada

  /** Lê uma ou várias fotos (partes do mesmo cupom) numa chamada só. */
  function lerImagens_(arquivos, ctx, quem, legenda) {
    const blocos = [];
    let total = 0;
    arquivos.slice(0, MAX_FOTOS).forEach(arquivo => {
      const blob = Telegram.baixar(arquivo.fileId, LIMITE_BYTES, 'foto');
      const dados = Utilities.base64Encode(blob.getBytes());
      total += dados.length;
      if (total > LIMITE_TOTAL) return;
      blocos.push(arquivo.mime === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: dados } }
        : { type: 'image', source: { type: 'base64', media_type: arquivo.mime, data: dados } });
    });
    const varias = blocos.length > 1;
    const pedido = varias
      ? 'Estas ' + blocos.length + ' imagens são partes do MESMO cupom, em ordem (de cima para baixo) e podem se sobrepor na emenda. ' +
        'Junte tudo numa leitura só: todos os itens uma vez cada (item que aparece no fim de uma foto e no começo da seguinte, com mesma descrição e valor, conta uma vez só). ' +
        'O total, a forma de pagamento e a chave de acesso costumam estar na última parte.'
      : 'Leia este comprovante.';
    return Interpretador.chamarIA(sistema_(ctx, quem, legenda, 'foto'),
      blocos.concat([{ type: 'text', text: pedido + (legenda ? ' Legenda: ' + legenda : '') }]),
      FERRAMENTA, varias ? 8192 : 4096);
  }

  /** Consulta a nota na SEFAZ e lê o texto da página com a IA. */
  function lerSefaz_(url, ctx, quem, legenda) {
    const texto = Sefaz.buscarTexto(url);
    return Interpretador.chamarIA(sistema_(ctx, quem, legenda, 'sefaz'), [
      { type: 'text', text: 'Texto da página da NFC-e (SEFAZ):\n\n' + texto }
    ], FERRAMENTA, 8192);
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

  /** Itens no formato da aba Itens (histórico de preços). */
  function itensParaGravar_(b) {
    const itens = Array.isArray(b.itens) ? b.itens.slice(0, 100) : [];
    const totalBruto = itens.reduce((s, i) => s + (num_(i.valor) || 0), 0);
    const desconto = num_(b.desconto) || 0;
    return itens.filter(i => String(i.produto || i.descricao || '').trim()).map(i => {
      const total = num_(i.valor);
      const qtd = num_(i.quantidade) > 0 ? num_(i.quantidade) : 1;
      // Desconto do cupom rateado pelo valor de cada item: o preço que vale é o pago
      const parte = desconto && totalBruto > 0 && total ? desconto * total / totalBruto : 0;
      const pago = total ? Math.round((total - parte) * 100) / 100 : null;
      return {
        descricao_cupom: String(i.descricao || '').trim(),
        produto: String(i.produto || i.descricao || '').trim(),
        marca: String(i.marca || '').trim(),
        categoria_item: String(i.categoria_item || '').trim(),
        quantidade: qtd,
        unidade: String(i.unidade || 'un').trim().toLowerCase(),
        valor_unitario: pago ? Math.round(pago / qtd * 10000) / 10000 : num_(i.valor_unitario),
        valor_total: pago,
        desconto: Math.round(parte * 100) / 100
      };
    });
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

  function aplicarPagamento_(r, b, ctx) {
    if (r.conta || r.cartao) return;
    if (b.cartao_id && Contexto.acharCartao(ctx, b.cartao_id)) r.cartao = String(b.cartao_id);
    else if (b.conta_id && Contexto.acharConta(ctx, b.conta_id)) r.conta = String(b.conta_id);
    // Crédito só existe em cartão; se há um cartão só, é ele
    if (!r.cartao && !r.conta && b.forma_pagamento === 'credito' && ctx.cartoes.length === 1) r.cartao = ctx.cartoes[0].id;
    // Vale: se há uma conta de vale só, é ela
    if (!r.cartao && !r.conta && b.forma_pagamento === 'vale') {
      const vales = ctx.contas.filter(c => /\bvr\b|vale/i.test(c.nome + ' ' + c.tipo));
      if (vales.length === 1) r.conta = vales[0].id;
    }
  }

  function aplicarCategoria_(r, b, ctx) {
    const cat = b.categoria_id ? Contexto.acharCategoria(ctx, b.categoria_id) : null;
    if (cat && cat.tipo === r.tipo) r.categoria = cat.id;
    const daRegra = Interpretador.categoriaPorRegra(r.textoOriginal || '', r.descricao + ' ' + (b.razao_social || ''));
    const catRegra = daRegra ? Contexto.acharCategoria(ctx, daRegra) : null;
    if (catRegra && catRegra.tipo === r.tipo) r.categoria = catRegra.id;
    r.categoriaSugerida = r.categoria || '';
  }

  function procurarParecido_(r) {
    r.parecido = null;
    if (!r.valor) return;
    try {
      const par = acharParecido(r.valor, r.tipo, r.data, false);
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

  /** Copia para o rascunho o que foi lido (da foto ou da SEFAZ). */
  function aplicarLeitura_(r, b, ctx) {
    const valor = num_(b.valor_total) > 0 ? Math.round(num_(b.valor_total) * 100) / 100 : null;
    if (valor && !(b.legivel === false)) r.valor = valor;
    if (Formato.ehDataISO(b.data) && b.data <= Formato.hoje(30)) r.data = b.data;
    const loja = String(b.loja || b.razao_social || '').trim();
    if (loja) r.descricao = loja.slice(0, 80);
    if (b.forma_pagamento) r.formaPagamento = b.forma_pagamento;
    const nFotos = (r.fotos || []).length;
    r.cabecalho = 'Cupom · ' + (loja || 'foto') + (r.formaPagamento ? ' · ' + rotuloPagamento_(r.formaPagamento) : '') + (nFotos > 1 ? ' · ' + nFotos + ' fotos' : '');
    r.parcelas = Math.max(1, Math.min(48, Math.floor(num_(b.parcelas) || r.parcelas || 1)));
    r.itensResumo = resumoItens_(b);
    r.observacao = observacao_(b);
    r.itens = itensParaGravar_(b);
    r.cupomCab = {
      loja: loja,
      cnpj: String(b.cnpj || (r.cupomCab && r.cupomCab.cnpj) || ''),
      chave_nfce: String(b.chave_acesso || (r.cupomCab && r.cupomCab.chave_nfce) || '').replace(/\D/g, ''),
      quem: r.quem
    };
    aplicarPagamento_(r, b, ctx);
    aplicarCategoria_(r, b, ctx);
  }

  function rascunhoVazio_(chatId, usuarioId, quem, legenda) {
    return {
      tipo: 'despesa', valor: null, data: Formato.hoje(), descricao: 'Cupom',
      conta: '', cartao: '', categoria: '', parcelas: 1, duvidas: [],
      chatId: chatId, usuarioId: usuarioId, quem: quem,
      origem: 'cupom', textoOriginal: legenda
    };
  }

  /**
   * Completa o rascunho com os dados oficiais da SEFAZ. Devolve true se conseguiu.
   * Se falhar, o rascunho fica com o que foi lido da foto.
   */
  function completarPelaSefaz_(r, url, ctx) {
    try {
      const b = lerSefaz_(url, ctx, r.quem, r.textoOriginal || '');
      if (!b.e_comprovante || !(num_(b.valor_total) > 0)) throw new Error('a página não trouxe a nota');
      if (!b.chave_acesso) b.chave_acesso = Sefaz.chaveDaUrl(url);
      const valorAntes = r.valor;
      aplicarLeitura_(r, b, ctx);
      if (r.valor !== valorAntes || !r.parecido) procurarParecido_(r);
      r.sefaz = 'ok';
      return true;
    } catch (err) {
      console.warn('SEFAZ: ' + (err && err.message ? err.message : err));
      r.sefaz = 'falhou';
      r.sefazMotivo = String(err && err.message ? err.message : err).slice(0, 120);
      return false;
    }
  }

  const TTL_GRUPO = 21600;

  /** Rascunho de cupom ainda aberto a que esta foto pertence (álbum ou resposta). */
  function rascunhoDaFoto_(msg, chatId) {
    const cache = CacheService.getScriptCache();
    let chave = '';
    if (msg.media_group_id) chave = cache.get('grupo_' + chatId + '_' + msg.media_group_id) || '';
    if (!chave && msg.reply_to_message) chave = cache.get('msgr_' + chatId + '_' + msg.reply_to_message.message_id) || '';
    const r = chave ? Rascunho.ler(chave) : null;
    return r && r.estado === 'aberto' && r.origem === 'cupom' ? r : null;
  }

  /** Consulta a SEFAZ quando dá (chave válida de NFC-e e portal que atende o Google). */
  function urlSefaz_(b) {
    const chave = String(b.chave_acesso || '').replace(/\D/g, '');
    const url = Sefaz.ehNfce(chave) ? Sefaz.urlDaChave(chave) : '';
    return url && Sefaz.consultavel(url) ? url : '';
  }

  /**
   * Ponto de entrada: foto ou documento recebido no Telegram.
   * Várias fotos do mesmo cupom (álbum, ou respondendo ao rascunho) viram uma leitura só.
   */
  function processar(msg, chatId, usuarioId, quem) {
    const arquivo = arquivoDaMensagem(msg);
    if (!arquivo) return false;
    Telegram.digitando(chatId);
    const legenda = String(msg.caption || '').trim();
    const ctx = Contexto.carregar();
    const cache = CacheService.getScriptCache();
    const grupo = msg.media_group_id ? 'grupo_' + chatId + '_' + msg.media_group_id : '';

    // Foto que continua um cupom já aberto
    const existente = rascunhoDaFoto_(msg, chatId);
    if (existente) return acrescentarFoto_(existente, arquivo, legenda, ctx);

    // Partes de um álbum que ainda não formaram um cupom reconhecível
    let fotos = [arquivo];
    const pendKey = grupo ? grupo + '_pend' : '';
    if (pendKey) {
      try { fotos = JSON.parse(cache.get(pendKey) || '[]').concat([arquivo]); } catch (e) { fotos = [arquivo]; }
    }

    let b;
    try {
      b = lerImagens_(fotos, ctx, quem, legenda);
    } catch (err) {
      console.error('cupom: ' + (err && err.stack ? err.stack : err));
      Telegram.enviar(chatId, 'Não consegui ler a foto: ' + Telegram.esc(String(err.message || err)));
      return true;
    }

    if (!b.e_comprovante) {
      if (pendKey && fotos.length === 1) {
        // Primeira foto do álbum pode ser só o meio do cupom: espera as próximas
        cache.put(pendKey, JSON.stringify(fotos), TTL_GRUPO);
        return true;
      }
      Telegram.enviar(chatId, 'Não reconheci um cupom ou comprovante ' + (fotos.length > 1 ? 'nessas fotos' : 'nessa foto') + '. Se for um gasto, mande a foto do cupom ou escreva, como "almoço 32,50 débito itaú".');
      return true;
    }

    const r = rascunhoVazio_(chatId, usuarioId, quem, legenda);
    r.tipo = b.tipo === 'receita' ? 'receita' : 'despesa';
    r.fotos = fotos;
    aplicarLeitura_(r, b, ctx);
    procurarParecido_(r);

    const url = urlSefaz_(b);
    if (url) r.sefaz = 'buscando';

    const rasc = Rascunho.criar(r);
    if (grupo) {
      cache.put(grupo, rasc.chave, TTL_GRUPO);
      if (pendKey) cache.remove(pendKey);
    }
    Rascunho.mostrarNovo(rasc, ctx);
    if (url) {
      Telegram.digitando(chatId);
      completarPelaSefaz_(rasc, url, ctx);
      Rascunho.salvar(rasc);
      Rascunho.atualizar(rasc, ctx);
    }
    return true;
  }

  /** Mais uma foto do mesmo cupom: relê todas juntas e atualiza o rascunho. */
  function acrescentarFoto_(r, arquivo, legenda, ctx) {
    r.fotos = (r.fotos || []).concat([arquivo]);
    if (r.fotos.length > MAX_FOTOS) {
      Telegram.enviar(r.chatId, 'Esse cupom já tem ' + MAX_FOTOS + ' fotos, o máximo que eu leio de uma vez.');
      return true;
    }
    if (legenda && !r.textoOriginal) r.textoOriginal = legenda;
    let b;
    try {
      b = lerImagens_(r.fotos, ctx, r.quem, r.textoOriginal || '');
    } catch (err) {
      console.error('cupom (mais fotos): ' + (err && err.stack ? err.stack : err));
      Telegram.enviar(r.chatId, 'Não consegui ler a foto nova: ' + Telegram.esc(String(err.message || err)));
      return true;
    }
    if (!b.e_comprovante) { Rascunho.salvar(r); return true; }

    // O que a pessoa já escolheu no rascunho continua valendo
    const escolhida = r.categoria !== r.categoriaSugerida ? r.categoria : null;
    if (r.sefaz !== 'ok') {
      aplicarLeitura_(r, b, ctx);
      if (escolhida !== null) r.categoria = escolhida;
      procurarParecido_(r);
    }
    const url = r.sefaz ? '' : urlSefaz_(b);
    if (url) {
      completarPelaSefaz_(r, url, ctx);
      if (escolhida !== null) r.categoria = escolhida;
    }
    Rascunho.salvar(r);
    Rascunho.atualizar(r, ctx);
    return true;
  }

  /**
   * Link da NFC-e (QR lido pela câmera e compartilhado) ou a chave de 44 dígitos
   * digitada. Devolve false se o texto não for nenhum dos dois.
   */
  function processarTexto(texto, chatId, usuarioId, quem) {
    let url = Sefaz.urlDoTexto(texto);
    if (!url) {
      const chave = Sefaz.chaveDoTexto(texto);
      url = chave ? Sefaz.urlDaChave(chave) : '';
    }
    if (!url) return false;

    Telegram.digitando(chatId);
    const ctx = Contexto.carregar();
    const r = rascunhoVazio_(chatId, usuarioId, quem, '');
    if (!completarPelaSefaz_(r, url, ctx)) {
      Telegram.enviar(chatId, 'Não consegui consultar essa nota na SEFAZ: ' + Telegram.esc(r.sefazMotivo || 'erro') +
        '.\nMande a foto do cupom que eu leio por ela.');
      return true;
    }
    const rasc = Rascunho.criar(r);
    Rascunho.mostrarNovo(rasc, ctx);
    return true;
  }

  function rotuloPagamento_(f) {
    return { credito: 'crédito', debito: 'débito', pix: 'Pix', dinheiro: 'dinheiro', vale: 'vale', boleto: 'boleto' }[f] || 'outro';
  }

  return { processar: processar, processarTexto: processarTexto, arquivoDaMensagem: arquivoDaMensagem, acharParecido: acharParecido, FERRAMENTA: FERRAMENTA };
})();
