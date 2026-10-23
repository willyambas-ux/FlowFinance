/**
 * Consultas.js — responde perguntas sobre as finanças usando as funções do
 * FlowFinance (biblioteca FF). Só lê; nunca grava.
 *
 * Tipos: gastos | saldo | vencimentos | fatura | resumo | orcamentos
 * Parâmetros (todos opcionais): categoria, conta, cartao, mes ('YYYY-MM'), dias
 */
const Consultas = (function () {
  const MAX_LINHAS = 15;

  function anoMes_(yyyymm) {
    const m = String(yyyymm || '').match(/^(\d{4})-(\d{2})$/);
    const base = m ? m : Formato.hoje().slice(0, 7).match(/^(\d{4})-(\d{2})$/);
    return { ano: Number(base[1]), mes: Number(base[2]), yyyymm: base[1] + '-' + base[2] };
  }

  function fimDoMes_(am) {
    const ultimo = new Date(am.ano, am.mes, 0).getDate();
    return am.yyyymm + '-' + String(ultimo).padStart(2, '0');
  }

  /** Conjunto com a categoria e todas as descendentes. */
  function familia_(ctx, catId) {
    const set = new Set([String(catId)]);
    let mudou = true;
    while (mudou) {
      mudou = false;
      ctx.categorias.forEach(c => {
        if (c.pai && set.has(c.pai) && !set.has(c.id)) { set.add(c.id); mudou = true; }
      });
    }
    return set;
  }

  /** Categoria "de topo" para agrupar (pai, se houver). */
  function topo_(ctx, catId) {
    const c = catId ? Contexto.acharCategoria(ctx, catId) : null;
    if (!c) return 'Sem categoria';
    if (!c.pai) return c.nome;
    const pai = Contexto.acharCategoria(ctx, c.pai);
    return pai ? pai.nome : c.nome;
  }

  function lancsDoMes_(am) {
    return FF.listLancamentos({ ano: am.ano, mes: am.mes })
      .filter(l => !l.transferencia_id)
      .map(l => Object.assign({}, l, { valor: Number(l.valor) || 0, data: String(l.data || '').slice(0, 10) }));
  }

  function filtrarPagamento_(lancs, q) {
    if (q.cartao) return lancs.filter(l => String(l.cartao) === q.cartao);
    if (q.conta) return lancs.filter(l => String(l.conta) === q.conta);
    return lancs;
  }

  function nomePagamento_(ctx, q) {
    if (q.cartao) { const c = Contexto.acharCartao(ctx, q.cartao); return c ? c.nome : ''; }
    if (q.conta) { const c = Contexto.acharConta(ctx, q.conta); return c ? c.nome : ''; }
    return '';
  }

  /* ------------------------------------------------------------- gastos */

  function gastos(ctx, q) {
    const am = anoMes_(q.mes);
    const hoje = Formato.hoje();
    let lancs = filtrarPagamento_(lancsDoMes_(am), q).filter(l => l.valor < 0);

    let titulo = 'Gastos';
    if (q.categoria) {
      const fam = familia_(ctx, q.categoria);
      lancs = lancs.filter(l => fam.has(String(l.categoria)));
      const cat = Contexto.acharCategoria(ctx, q.categoria);
      titulo = cat ? cat.caminho : 'Categoria';
    }
    const pag = nomePagamento_(ctx, q);
    if (pag) titulo += ' · ' + pag;

    const feitos = lancs.filter(l => l.data <= hoje);
    const previstos = lancs.filter(l => l.data > hoje);
    const soma = arr => arr.reduce((s, l) => s + Math.abs(l.valor), 0);

    const L = ['<b>' + Telegram.esc(titulo) + ' · ' + Formato.competenciaBR(am.yyyymm) + '</b>'];
    L.push('Até hoje: <b>' + Formato.brl(soma(feitos)) + '</b> (' + feitos.length + ' lançamento' + (feitos.length === 1 ? '' : 's') + ')');
    if (previstos.length) L.push('Previsto até o fim do mês: + ' + Formato.brl(soma(previstos)));

    if (q.categoria) {
      // Últimos lançamentos da categoria
      const ultimos = feitos.slice().sort((a, b) => b.data.localeCompare(a.data)).slice(0, 5);
      if (ultimos.length) {
        L.push('');
        ultimos.forEach(l => L.push(Formato.dataBR(l.data).slice(0, 5) + '  ' + Telegram.esc(l.descricao) + '  ' + Formato.brl(l.valor)));
      }
    } else {
      // Maiores grupos
      const grupos = {};
      feitos.forEach(l => {
        const g = topo_(ctx, l.categoria);
        grupos[g] = (grupos[g] || 0) + Math.abs(l.valor);
      });
      const top = Object.keys(grupos).sort((a, b) => grupos[b] - grupos[a]).slice(0, 6);
      if (top.length) {
        L.push('');
        top.forEach(g => L.push(Telegram.esc(g) + ': ' + Formato.brl(grupos[g])));
      }
    }
    return L.join('\n');
  }

  /* -------------------------------------------------------------- saldo */

  function saldo(ctx, q) {
    const hoje = Formato.hoje();
    const am = anoMes_('');
    const atuais = FF.getSaldosContas(hoje);
    const fimMes = FF.getSaldosContas(fimDoMes_(am));
    const ids = q.conta ? [q.conta] : ctx.contas.filter(c => c.tipo !== 'investimento').map(c => c.id);

    const L = ['<b>Saldos</b> (confirmados até hoje · previsto em ' + Formato.dataBR(fimDoMes_(am)).slice(0, 5) + ')'];
    let total = 0, totalPrev = 0;
    ids.forEach(id => {
      const a = atuais.find(s => String(s.id) === String(id));
      const p = fimMes.find(s => String(s.id) === String(id));
      if (!a) return;
      total += a.confirmado; totalPrev += p ? p.projetado : a.confirmado;
      L.push(Telegram.esc(a.nome) + ': <b>' + sinal_(a.confirmado) + '</b>' + (p ? ' · ' + sinal_(p.projetado) : ''));
    });
    if (ids.length > 1) L.push('', 'Total: <b>' + sinal_(total) + '</b> · ' + sinal_(totalPrev));
    return L.join('\n');
  }

  function sinal_(v) {
    return (v < 0 ? '−' : '') + Formato.brl(v);
  }

  /* -------------------------------------------------------- vencimentos */

  function vencimentos(ctx, q) {
    const dias = Math.max(1, Math.min(60, Number(q.dias) || 7));
    const lista = FF.getContasAPagar(dias);
    if (!lista.length) return 'Nada a pagar nos próximos ' + dias + ' dias.';
    const total = lista.reduce((s, l) => s + Math.abs(Number(l.valor) || 0), 0);
    const L = ['<b>A pagar nos próximos ' + dias + ' dias: ' + Formato.brl(total) + '</b>'];
    lista.slice(0, MAX_LINHAS).forEach(l => {
      L.push(Formato.dataBR(l.data).slice(0, 5) + '  ' + Telegram.esc(l.descricao) + '  ' + Formato.brl(l.valor));
    });
    if (lista.length > MAX_LINHAS) L.push('… e mais ' + (lista.length - MAX_LINHAS));
    return L.join('\n');
  }

  /* ------------------------------------------------------------- fatura */

  function fatura(ctx, q) {
    const hoje = Formato.hoje();
    const cartoes = q.cartao ? ctx.cartoes.filter(c => c.id === q.cartao) : ctx.cartoes;
    if (!cartoes.length) return 'Não achei esse cartão.';
    const L = [];
    cartoes.forEach(c => {
      const comp = q.mes || FF.sugerirFaturaCompetencia(c.id, hoje);
      const am = anoMes_(comp);
      const f = FF.getFatura(c.id, am.ano, am.mes);
      const status = { aberta: 'aberta', fechada: 'fechada, a pagar', paga: 'paga' }[f.status] || f.status;
      L.push('<b>' + Telegram.esc(c.nome) + ' · fatura ' + Formato.competenciaBR(am.yyyymm) + '</b>');
      L.push(Formato.brl(f.total) + ' · ' + status + ' · vence ' + Formato.dataBR(f.ciclo.vencimento).slice(0, 5));
      L.push('Compras de ' + Formato.dataBR(f.ciclo.inicio).slice(0, 5) + ' a ' + Formato.dataBR(f.ciclo.fim).slice(0, 5) + ' (' + f.lancamentos.length + ')');
      L.push('');
    });
    return L.join('\n').trim();
  }

  /* ------------------------------------------------------------- resumo */

  function resumo(ctx, q) {
    const am = anoMes_(q.mes);
    const hoje = Formato.hoje();
    const lancs = lancsDoMes_(am);
    const soma = (f) => lancs.filter(f).reduce((s, l) => s + Math.abs(l.valor), 0);

    const recFeito = soma(l => l.valor > 0 && l.data <= hoje);
    const recPrev = soma(l => l.valor > 0 && l.data > hoje);
    const despFeito = soma(l => l.valor < 0 && l.data <= hoje);
    const despPrev = soma(l => l.valor < 0 && l.data > hoje);

    const L = ['<b>Resumo de ' + Formato.competenciaBR(am.yyyymm) + '</b>'];
    L.push('Entrou: <b>' + Formato.brl(recFeito) + '</b>' + (recPrev ? ' (+ ' + Formato.brl(recPrev) + ' previsto)' : ''));
    L.push('Saiu: <b>' + Formato.brl(despFeito) + '</b>' + (despPrev ? ' (+ ' + Formato.brl(despPrev) + ' previsto)' : ''));
    const resultado = (recFeito + recPrev) - (despFeito + despPrev);
    L.push('Resultado previsto do mês: <b>' + sinal_(resultado) + '</b>');

    const grupos = {};
    lancs.filter(l => l.valor < 0).forEach(l => {
      const g = topo_(ctx, l.categoria);
      grupos[g] = (grupos[g] || 0) + Math.abs(l.valor);
    });
    const top = Object.keys(grupos).sort((a, b) => grupos[b] - grupos[a]).slice(0, 5);
    if (top.length) {
      L.push('', 'Maiores gastos do mês:');
      top.forEach(g => L.push(Telegram.esc(g) + ': ' + Formato.brl(grupos[g])));
    }
    return L.join('\n');
  }

  /* --------------------------------------------------------- orçamentos */

  function orcamentos(ctx, q) {
    const am = anoMes_(q.mes);
    const lista = FF.getOrcamentosProgresso(am.ano, am.mes);
    if (!lista.length) return 'Nenhum orçamento ativo em ' + Formato.competenciaBR(am.yyyymm) + '.';
    const L = ['<b>Orçamentos · ' + Formato.competenciaBR(am.yyyymm) + '</b>'];
    lista.forEach(o => {
      const alerta = o.percentual >= 100 ? ' · estourou' : (o.percentual >= 90 ? ' · atenção' : '');
      L.push(Telegram.esc(o.nome) + ': ' + Formato.brl(o.consumido) + ' de ' + Formato.brl(o.orcado) + ' (' + o.percentual + '%)' + alerta);
    });
    return L.join('\n');
  }

  const TIPOS = { gastos: gastos, saldo: saldo, vencimentos: vencimentos, fatura: fatura, resumo: resumo, orcamentos: orcamentos };

  function responder(q, ctx) {
    ctx = ctx || Contexto.carregar();
    q = q || {};
    const f = TIPOS[q.tipo] || resumo;
    return f(ctx, q);
  }

  return { responder: responder, TIPOS: Object.keys(TIPOS) };
})();
