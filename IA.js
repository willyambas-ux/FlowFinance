/**
 * IA.js — interpreta uma frase ("mercado nordestão 187,40 no crédito xp") e
 * devolve um rascunho de lançamento validado contra as contas, cartões e
 * categorias reais. Usado pelo lançamento rápido do web app.
 *
 * A IA só interpreta. Quem grava é appSalvarLancamento (App.js), depois que a
 * pessoa confere e confirma.
 *
 * Propriedades do script (FlowFinance, não do bot):
 *   ANTHROPIC_API_KEY  chave da API do Claude (a mesma do bot serve)
 *   MODELO_IA          opcional; padrão IA_MODELO_PADRAO
 *
 * O bot do Telegram ainda usa a própria cópia (bot/Interpretador.js), que também
 * responde perguntas. As regras de interpretação abaixo seguem as dele.
 */
const IA_MODELO_PADRAO = 'claude-haiku-5-5';

const IA = (function () {
  const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

  const FERRAMENTA = {
    name: 'registrar_lancamento',
    description: 'Registra a interpretação de uma frase como lançamento financeiro.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: {
          type: 'string',
          enum: ['despesa', 'receita', 'transferencia', 'nao_e_lancamento'],
          description: 'despesa = gasto ou pagamento; receita = dinheiro recebido; transferencia = dinheiro entre duas contas da própria pessoa; nao_e_lancamento = qualquer outra coisa.'
        },
        valor: { type: ['number', 'null'], description: 'Valor total em reais, positivo.' },
        data: { type: 'string', description: 'Data no formato YYYY-MM-DD.' },
        descricao: { type: 'string', description: 'Nome curto do estabelecimento ou do gasto, sem valor nem forma de pagamento.' },
        conta_id: { type: ['string', 'null'], description: 'id de uma conta da lista, ou null. Em transferência, a conta de onde saiu.' },
        conta_destino_id: { type: ['string', 'null'], description: 'Só em transferência: id da conta para onde foi.' },
        cartao_id: { type: ['string', 'null'], description: 'id de um cartão da lista, ou null.' },
        categoria_id: { type: ['string', 'null'], description: 'id da categoria mais específica da lista, ou null.' },
        parcelas: { type: 'integer', description: 'Número de parcelas; 1 se à vista.' },
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
      required: ['tipo']
    }
  };

  function semAcento_(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  function ehDataISO_(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

  function ativo_(v) {
    if (v === '' || v === null || v === undefined) return true;
    return v === true || String(v).toLowerCase() === 'true';
  }

  /** Contas, cartões e categorias no formato que o prompt e a validação usam. */
  function contexto() {
    const contas = listContas()
      .filter(c => ativo_(c.ativo) && c.tipo !== 'emprestimo')
      .map(c => ({ id: String(c.id), nome: String(c.nome), tipo: String(c.tipo || ''), banco: String(c.banco || '') }));
    const cartoes = listCartoes()
      .filter(c => ativo_(c.ativo))
      .map(c => ({ id: String(c.id), nome: String(c.nome), bandeira: String(c.bandeira || '') }));
    const brutas = listCategorias();
    const porId = {};
    brutas.forEach(c => { porId[String(c.id)] = c; });
    const categorias = brutas
      .filter(c => c.tipo === 'despesa' || c.tipo === 'receita')
      .map(c => {
        const pai = c.pai ? porId[String(c.pai)] : null;
        return {
          id: String(c.id), nome: String(c.nome), pai: c.pai ? String(c.pai) : '', tipo: String(c.tipo),
          caminho: pai ? (String(pai.nome) + ' › ' + String(c.nome)) : String(c.nome)
        };
      });
    return { contas: contas, cartoes: cartoes, categorias: categorias };
  }

  function achar_(lista, id) { return id ? (lista.find(x => x.id === String(id)) || null) : null; }

  function sistema_(ctx, quem) {
    const hoje = Utils.today();
    const diaSemana = DIAS[new Date(hoje + 'T12:00:00').getDay()];
    return [
      'Você interpreta frases curtas de um casal brasileiro que registra gastos e receitas num controle financeiro pessoal.',
      'Responda sempre chamando a ferramenta registrar_lancamento.',
      '',
      'Hoje é ' + hoje + ' (' + diaSemana + ').' + (quem ? ' Quem escreveu: ' + quem + '.' : ''),
      '',
      'Regras:',
      '- valor: número positivo em reais. "32,50" = 32.5; "1.200" = 1200; "mil" = 1000. Sem valor: null e uma dúvida com campo "valor".',
      '- tipo: "despesa" para gastos e pagamentos; "receita" para recebimentos (recebi, salário, entrou, pix recebido). Se não for lançamento, use "nao_e_lancamento" e responda em "resposta".',
      '- transferencia: "transferi", "passei", "mandei pix pra minha conta" entre contas da própria pessoa. Preencha conta_id (origem) e conta_destino_id (destino); categoria_id null. Pagamento a pessoa ou loja não é transferência.',
      '- data: YYYY-MM-DD. Sem data na frase = hoje. "ontem", "sexta", "dia 5" referem-se ao passado mais recente.',
      '- descricao: nome curto com capitalização normal (ex.: "Nordestão", "Almoço", "Uber"). Sem valor e sem forma de pagamento.',
      '- pagamento: preencha conta_id OU cartao_id, usando SOMENTE ids das listas abaixo, e só quando a frase indicar. Crédito = cartão. Débito ou pix = conta corrente do banco citado. Vale, VR ou VA = conta do tipo vale. Na dúvida, deixe ambos null e inclua uma dúvida com campo "pagamento". Nunca invente ids.',
      '- Os nomes seguem o padrão "NN tipo BANCO": cc = conta corrente, cred = cartão de crédito, vr = vale, ci = investimento.',
      '- categoria_id: a categoria mais específica da lista cujo tipo combine com o lançamento; null se nenhuma servir bem.',
      '- parcelas: número de parcelas se citado ("em 3x", "10 vezes"); senão 1. O valor é sempre o total.',
      '- duvidas: só o que realmente falta. Lista vazia quando estiver tudo claro.',
      '',
      'CONTAS (id | nome | tipo | banco):',
      ctx.contas.map(c => c.id + ' | ' + c.nome + ' | ' + c.tipo + (c.banco ? ' | ' + c.banco : '')).join('\n') || '(nenhuma)',
      '',
      'CARTÕES (id | nome | bandeira):',
      ctx.cartoes.map(c => c.id + ' | ' + c.nome + (c.bandeira ? ' | ' + c.bandeira : '')).join('\n') || '(nenhum)',
      '',
      'CATEGORIAS (id | caminho | tipo):',
      ctx.categorias.map(c => c.id + ' | ' + c.caminho + ' | ' + c.tipo).join('\n') || '(nenhuma)'
    ].join('\n');
  }

  function chamar_(sistema, texto) {
    const props = PropertiesService.getScriptProperties();
    const chave = props.getProperty('ANTHROPIC_API_KEY');
    if (!chave) {
      throw new Error('Falta a chave da IA: crie a propriedade ANTHROPIC_API_KEY no projeto FlowFinance ' +
        '(Configurações do projeto › Propriedades do script). A mesma chave do bot serve.');
    }
    const resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': chave, 'anthropic-version': '2023-06-01' },
      payload: JSON.stringify({
        model: props.getProperty('MODELO_IA') || IA_MODELO_PADRAO,
        max_tokens: 1024,
        system: sistema,
        tools: [FERRAMENTA],
        tool_choice: { type: 'tool', name: FERRAMENTA.name },
        messages: [{ role: 'user', content: texto }]
      }),
      muteHttpExceptions: true
    });
    const status = resp.getResponseCode();
    let corpo;
    try { corpo = JSON.parse(resp.getContentText()); } catch (e) { corpo = null; }
    if (status !== 200) {
      const msg = corpo && corpo.error ? corpo.error.message : resp.getContentText().slice(0, 200);
      throw new Error('A IA respondeu ' + status + ': ' + msg);
    }
    const uso = (corpo.content || []).find(b => b.type === 'tool_use');
    if (!uso) throw new Error('A IA não devolveu a interpretação.');
    return uso.input;
  }

  /** Categoria pelas regras da aba Regras (têm prioridade sobre a IA). */
  function categoriaPorRegra_(texto, descricao) {
    try {
      const r = aplicarRegras({ descricao: semAcento_(descricao + ' ' + texto).toUpperCase() });
      return r && r.categoria ? String(r.categoria) : '';
    } catch (e) {
      return '';
    }
  }

  /**
   * { tipo, valor, data, descricao, conta, conta_destino, cartao, categoria,
   *   categoria_por_regra, parcelas, duvidas, resposta }
   */
  function interpretar(texto, quem, ctx) {
    texto = String(texto || '').trim();
    if (!texto) throw new Error('Escreva o lançamento.');
    ctx = ctx || contexto();
    const bruto = chamar_(sistema_(ctx, quem), texto);

    const r = {
      tipo: ['despesa', 'receita', 'transferencia', 'nao_e_lancamento'].indexOf(bruto.tipo) !== -1 ? bruto.tipo : 'despesa',
      valor: Number(bruto.valor) > 0 ? Math.round(Number(bruto.valor) * 100) / 100 : null,
      data: ehDataISO_(bruto.data) ? bruto.data : Utils.today(),
      descricao: String(bruto.descricao || '').trim().slice(0, 80),
      conta: '', conta_destino: '', cartao: '', categoria: '',
      categoria_por_regra: false,
      parcelas: Math.max(1, Math.min(48, Math.floor(Number(bruto.parcelas) || 1))),
      duvidas: Array.isArray(bruto.duvidas) ? bruto.duvidas.slice(0, 4) : [],
      resposta: String(bruto.resposta || '')
    };
    if (r.tipo === 'nao_e_lancamento') return r;

    if (r.tipo === 'transferencia') {
      r.conta = achar_(ctx.contas, bruto.conta_id) ? String(bruto.conta_id) : '';
      r.conta_destino = achar_(ctx.contas, bruto.conta_destino_id) ? String(bruto.conta_destino_id) : '';
      if (r.conta_destino === r.conta) r.conta_destino = '';
      r.parcelas = 1;
      if (!r.descricao) r.descricao = 'Transferência entre contas';
      return r;
    }
    if (!r.descricao) r.descricao = texto.slice(0, 40);

    // Só aceita ids que existem. Cartão tem prioridade se vierem os dois.
    if (achar_(ctx.cartoes, bruto.cartao_id)) r.cartao = String(bruto.cartao_id);
    else if (achar_(ctx.contas, bruto.conta_id)) r.conta = String(bruto.conta_id);

    const cat = achar_(ctx.categorias, bruto.categoria_id);
    if (cat && cat.tipo === r.tipo) r.categoria = cat.id;

    const catRegra = achar_(ctx.categorias, categoriaPorRegra_(texto, r.descricao));
    if (catRegra && catRegra.tipo === r.tipo) { r.categoria = catRegra.id; r.categoria_por_regra = true; }
    return r;
  }

  return { interpretar: interpretar, contexto: contexto, semAcento: semAcento_ };
})();
