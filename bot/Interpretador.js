/**
 * Interpretador.js — envia a mensagem à IA (API do Claude) e devolve um rascunho
 * de lançamento já validado contra as contas, cartões e categorias reais.
 *
 * A IA só interpreta e sugere. Nada é gravado aqui.
 */
const Interpretador = (function () {
  const FERRAMENTA = {
    name: 'registrar_lancamento',
    description: 'Registra a interpretação de uma mensagem como lançamento financeiro.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: {
          type: 'string',
          enum: ['despesa', 'receita', 'nao_e_lancamento'],
          description: 'despesa = gasto ou pagamento; receita = dinheiro recebido; nao_e_lancamento = pergunta, saudação ou outra coisa.'
        },
        valor: { type: ['number', 'null'], description: 'Valor total em reais, positivo.' },
        data: { type: 'string', description: 'Data no formato YYYY-MM-DD.' },
        descricao: { type: 'string', description: 'Nome curto do estabelecimento ou do gasto, sem valor nem forma de pagamento.' },
        conta_id: { type: ['string', 'null'], description: 'id de uma conta da lista, ou null.' },
        cartao_id: { type: ['string', 'null'], description: 'id de um cartão da lista, ou null.' },
        categoria_id: { type: ['string', 'null'], description: 'id da categoria mais específica da lista, ou null.' },
        parcelas: { type: 'integer', description: 'Número de parcelas; 1 se à vista.' },
        confianca: { type: 'number', description: 'Confiança geral de 0 a 1.' },
        duvidas: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              campo: { type: 'string', enum: ['valor', 'pagamento', 'categoria', 'data'] },
              pergunta: { type: 'string' }
            },
            required: ['campo', 'pergunta']
          }
        },
        resposta: { type: 'string', description: 'Só para nao_e_lancamento: resposta curta em português.' }
      },
      required: ['tipo', 'data', 'descricao', 'parcelas', 'confianca', 'duvidas']
    }
  };

  function montarSistema_(ctx, quem) {
    const linhasContas = ctx.contas.map(c => c.id + ' | ' + c.nome + ' | ' + c.tipo + (c.banco ? ' | ' + c.banco : '')).join('\n');
    const linhasCartoes = ctx.cartoes.map(c => c.id + ' | ' + c.nome + (c.bandeira ? ' | ' + c.bandeira : '')).join('\n');
    const linhasCats = ctx.categorias.map(c => c.id + ' | ' + c.caminho + ' | ' + c.tipo).join('\n');

    return [
      'Você interpreta mensagens curtas de um casal brasileiro que registra gastos e receitas num controle financeiro pessoal.',
      'Responda sempre chamando a ferramenta registrar_lancamento.',
      '',
      'Hoje é ' + Formato.hoje() + ' (' + Formato.diaDaSemanaHoje() + '). Quem escreveu: ' + quem + '.',
      '',
      'Regras:',
      '- valor: número positivo em reais. "32,50" = 32.5; "1.200" = 1200; "mil" = 1000. Se não houver valor, use null e inclua uma dúvida com campo "valor".',
      '- tipo: "despesa" para gastos e pagamentos; "receita" para recebimentos (recebi, salário, entrou, pix recebido). Se a mensagem não descreve um lançamento, use "nao_e_lancamento" e responda em "resposta".',
      '- data: YYYY-MM-DD. Sem data na mensagem = hoje. "ontem", "sexta", "dia 5" referem-se ao passado mais recente.',
      '- descricao: nome curto com capitalização normal (ex.: "Nordestão", "Almoço", "Uber"). Sem valor e sem forma de pagamento.',
      '- pagamento: preencha conta_id OU cartao_id, usando SOMENTE ids das listas abaixo, e só quando a mensagem indicar. Crédito = cartão. Débito ou pix = conta corrente do banco citado. Vale, VR ou VA = conta do tipo vale. Se não der para saber com segurança, deixe ambos null e inclua uma dúvida com campo "pagamento". Nunca invente ids.',
      '- Os nomes seguem o padrão "NN tipo BANCO": cc = conta corrente, cred = cartão de crédito, vr = vale, ci = investimento.',
      '- categoria_id: a categoria mais específica da lista cujo tipo combine com o lançamento; null se nenhuma servir bem.',
      '- parcelas: número de parcelas se citado ("em 3x", "10 vezes"); senão 1. O valor é sempre o total.',
      '- duvidas: só o que realmente falta. Lista vazia quando estiver tudo claro.',
      '',
      'CONTAS (id | nome | tipo | banco):',
      linhasContas || '(nenhuma)',
      '',
      'CARTÕES (id | nome | bandeira):',
      linhasCartoes || '(nenhum)',
      '',
      'CATEGORIAS (id | caminho | tipo):',
      linhasCats || '(nenhuma)'
    ].join('\n');
  }

  function chamarIA_(sistema, texto) {
    const chave = Config.chaveIA();
    if (!chave) throw new Error('ANTHROPIC_API_KEY não configurada.');
    const resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': chave,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify({
        model: Config.modelo(),
        max_tokens: 1024,
        system: sistema,
        tools: [FERRAMENTA],
        tool_choice: { type: 'tool', name: FERRAMENTA.name },
        messages: [{ role: 'user', content: texto }]
      }),
      muteHttpExceptions: true
    });
    const status = resp.getResponseCode();
    const corpo = JSON.parse(resp.getContentText());
    if (status !== 200) {
      const msg = corpo && corpo.error ? corpo.error.message : resp.getContentText();
      throw new Error('IA respondeu ' + status + ': ' + msg);
    }
    const uso = corpo.content.find(b => b.type === 'tool_use');
    if (!uso) throw new Error('IA não devolveu a ferramenta esperada.');
    if (corpo.usage) {
      console.log('Tokens IA: entrada ' + corpo.usage.input_tokens + ', saída ' + corpo.usage.output_tokens);
    }
    return uso.input;
  }

  /** Categoria pelas regras da aba Regras (têm prioridade sobre a IA). */
  function categoriaPorRegra_(textoOriginal, descricao) {
    try {
      const alvo = Formato.semAcento(descricao + ' ' + textoOriginal).toUpperCase();
      const r = FF.aplicarRegras({ descricao: alvo });
      return r && r.categoria ? String(r.categoria) : '';
    } catch (e) {
      console.warn('Regras indisponíveis: ' + e);
      return '';
    }
  }

  /**
   * Interpreta o texto e devolve um rascunho validado:
   * { tipo, valor, data, descricao, conta, cartao, categoria, parcelas, duvidas, confianca, resposta }
   */
  function interpretar(texto, quem, ctx) {
    ctx = ctx || Contexto.carregar();
    const bruto = chamarIA_(montarSistema_(ctx, quem), texto);

    const r = {
      tipo: bruto.tipo,
      valor: Number(bruto.valor) > 0 ? Math.round(Number(bruto.valor) * 100) / 100 : null,
      data: Formato.ehDataISO(bruto.data) ? bruto.data : Formato.hoje(),
      descricao: String(bruto.descricao || '').trim().slice(0, 80),
      conta: '',
      cartao: '',
      categoria: '',
      parcelas: Math.max(1, Math.min(48, Math.floor(Number(bruto.parcelas) || 1))),
      confianca: Number(bruto.confianca) || 0,
      duvidas: Array.isArray(bruto.duvidas) ? bruto.duvidas : [],
      resposta: String(bruto.resposta || '')
    };
    if (r.tipo === 'nao_e_lancamento') return r;
    if (!r.descricao) r.descricao = texto.slice(0, 40);

    // Só aceita ids que existem de verdade. Cartão tem prioridade se vierem os dois.
    if (bruto.cartao_id && Contexto.acharCartao(ctx, bruto.cartao_id)) {
      r.cartao = String(bruto.cartao_id);
    } else if (bruto.conta_id && Contexto.acharConta(ctx, bruto.conta_id)) {
      r.conta = String(bruto.conta_id);
    }

    const cat = bruto.categoria_id ? Contexto.acharCategoria(ctx, bruto.categoria_id) : null;
    if (cat && cat.tipo === r.tipo) r.categoria = cat.id;

    const daRegra = categoriaPorRegra_(texto, r.descricao);
    const catRegra = daRegra ? Contexto.acharCategoria(ctx, daRegra) : null;
    if (catRegra && catRegra.tipo === r.tipo) r.categoria = catRegra.id;

    return r;
  }

  return { interpretar: interpretar };
})();
