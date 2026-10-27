/**
 * ConsumoBot.js — o que chega por foto e não é gasto do dia:
 *  - foto do medidor (hidrômetro, gás): vira leitura na aba Consumo;
 *  - conta de luz, gás ou condomínio: vira registro de consumo e acerta a conta a pagar.
 *
 * A leitura vem da mesma chamada de IA do cupom (campo "documento" da ferramenta).
 * Comandos: /agua 523,100 · /gas 12,345 (anota ou corrige a leitura de hoje) · /consumo
 */
const ConsumoBot = (function () {
  const EMOJI = { luz: '⚡', agua: '💧', gas: '🔥', condominio: '🏢' };
  const NOMES = { luz: 'luz', agua: 'água', gas: 'gás', condominio: 'condomínio' };

  function num_(v, casas) {
    const n = Number(v);
    if (!isFinite(n)) return '—';
    const p = n.toFixed(casas === undefined ? 2 : casas).split('.');
    return p[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (p[1] ? ',' + p[1] : '');
  }

  function litros_(m3) { return num_(m3 * 1000, 0) + ' L'; }

  /** Texto da resposta a uma leitura registrada. */
  function textoLeitura_(r) {
    const un = r.unidade;
    const L = [EMOJI[r.servico] + ' <b>Leitura ' + (r.corrigida ? 'corrigida' : 'anotada') + ' · ' + NOMES[r.servico] + '</b>',
      num_(r.leitura, 3) + ' ' + un + ' em ' + Formato.dataBR(r.data)];
    if (!r.anterior) {
      L.push('', 'É a primeira leitura. Mande outra daqui a uns dias que eu calculo o consumo.');
      return L.join('\n');
    }
    L.push('', 'Desde ' + Formato.dataBR(r.anterior.data) + ' (' + r.dias + (r.dias === 1 ? ' dia' : ' dias') + '): <b>' + num_(r.consumo, 3) + ' ' + un + '</b>');
    if (r.por_dia !== null) {
      L.push('Por dia: ' + (un === 'm³' ? litros_(r.por_dia) : num_(r.por_dia, 2) + ' ' + un) +
        ' · no ritmo de 30 dias: ' + num_(r.projecao_30, 1) + ' ' + un);
    }
    if (r.variacao_pct !== null && r.media_por_dia) {
      const media = un === 'm³' ? litros_(r.media_por_dia) : num_(r.media_por_dia, 2) + ' ' + un;
      if (r.variacao_pct >= 25) L.push('', '⚠️ ' + r.variacao_pct + '% acima da média (' + media + '/dia).' + (r.servico === 'agua' ? ' Vale olhar descargas, torneiras e o registro.' : ''));
      else if (r.variacao_pct <= -20) L.push('', 'Abaixo da média (' + media + '/dia): ' + Math.abs(r.variacao_pct) + '% a menos. 👍');
      else L.push('', 'Dentro da média (' + media + '/dia).');
    }
    return L.join('\n');
  }

  function registrarLeitura_(servico, leitura, data, origem, quem) {
    return FF.registrarLeituraConsumo({ servico: servico, leitura: leitura, data: data || Formato.hoje(), origem: origem, quem: quem });
  }

  /** Foto do medidor. */
  function tratarMedidor_(b, chatId, quem, legenda) {
    const m = b.medidor || {};
    let servico = String(m.servico || '').toLowerCase();
    if (/agua|água|hidro/i.test(legenda)) servico = 'agua';
    else if (/g[aá]s/i.test(legenda)) servico = 'gas';
    if (['agua', 'gas', 'luz'].indexOf(servico) === -1) servico = 'agua';
    const leitura = Number(m.leitura);
    if (!(leitura >= 0) || m.confiavel === false || b.legivel === false) {
      Telegram.enviar(chatId, EMOJI[servico] + ' Não consegui ler o medidor com segurança' + (isFinite(leitura) && leitura >= 0 ? ' (li ' + num_(leitura, 3) + ')' : '') +
        '. Tire a foto de frente, com luz, mostrando todos os números, ou mande <code>/' + (servico === 'gas' ? 'gas' : 'agua') + ' 523,100</code> com o número.');
      return true;
    }
    try {
      const r = registrarLeitura_(servico, leitura, '', 'bot', quem);
      if (r.repetida) { Telegram.enviar(chatId, 'Essa leitura (' + num_(leitura, 3) + ') já estava anotada hoje.'); return true; }
      Telegram.enviar(chatId, textoLeitura_(r) + '\n\n<i>Li errado? Mande</i> <code>/' + (servico === 'gas' ? 'gas' : 'agua') + ' número</code> <i>que eu corrijo.</i>');
    } catch (e) {
      Telegram.enviar(chatId, '⚠️ ' + Telegram.esc(String(e.message || e)));
    }
    return true;
  }

  /** Uma conta de consumo (luz, gás, condomínio). Devolve as linhas da resposta. */
  function tratarConta_(c, quem) {
    const servico = String(c.servico || '').toLowerCase();
    const res = FF.registrarFaturaConsumo({
      servico: servico, referencia: c.referencia, consumo: c.consumo, dias: c.dias,
      valor: c.valor_total, valor_pagar: c.valor_pagar, vencimento: c.vencimento,
      valor_agua: c.valor_agua, referencia_agua: c.referencia_agua, periodo_agua: c.periodo_agua,
      historico: c.historico || [], fornecedor: c.fornecedor || '', quem: quem
    });
    const L = [];
    const titulo = EMOJI[servico] + ' <b>Conta de ' + (NOMES[servico] || servico) + (c.referencia ? ' · ' + Formato.competenciaBR(c.referencia) : '') + '</b>';
    L.push(titulo);
    const partes = [];
    if (c.consumo) partes.push(num_(c.consumo, servico === 'luz' ? 0 : 3) + ' ' + (servico === 'luz' ? 'kWh' : 'm³'));
    if (c.valor_total) partes.push(Formato.brl(c.valor_total));
    if (c.vencimento) partes.push('vence ' + Formato.dataBR(c.vencimento));
    if (partes.length) L.push(partes.join(' · '));
    if (servico === 'condominio' && c.valor_agua) L.push('Água no boleto: ' + Formato.brl(c.valor_agua) + (c.periodo_agua ? ' (' + Telegram.esc(c.periodo_agua) + ')' : ''));
    if (c.valor_pagar && c.valor_total && Math.abs(c.valor_pagar - c.valor_total) > 0.009) L.push('Pagando até o vencimento: ' + Formato.brl(c.valor_pagar));
    if (res.conta) {
      const a = res.conta.antes;
      L.push('Conta a pagar acertada: ' + Telegram.esc(res.conta.descricao) + ' ' + Formato.dataBR(res.conta.data) + ' → ' + Formato.brl(res.conta.valor) +
        (Math.abs(a.valor - res.conta.valor) > 0.009 ? ' <i>(era ' + Formato.brl(a.valor) + ')</i>' : ''));
    }
    return { linhas: L, res: res };
  }

  /** Comparação com a média, para fechar a mensagem da conta. */
  function comparacao_(servicos) {
    try {
      const d = FF.appConsumo();
      return servicos.map(s => {
        const x = d.servicos.find(v => v.id === s);
        if (!x || x.variacao_pct === null) return '';
        const base = x.base_variacao === 'consumo' ? 'consumo' : 'valor';
        if (x.variacao_pct >= 15) return '⚠️ ' + x.nome + ': ' + base + ' ' + x.variacao_pct + '% acima da média dos meses anteriores.';
        if (x.variacao_pct <= -10) return x.nome + ': ' + base + ' ' + Math.abs(x.variacao_pct) + '% abaixo da média. 👍';
        return x.nome + ': ' + base + ' dentro da média.';
      }).filter(Boolean).join('\n');
    } catch (e) {
      return '';
    }
  }

  /**
   * Contas lidas da foto/PDF. Contas já vencidas há mais de 5 dias só entram no
   * histórico; as que estão para vencer e não têm conta fixa viram rascunho de despesa.
   */
  function tratarContas_(b, chatId, usuarioId, quem, ctx) {
    const contas = (b.contas_consumo || []).filter(c => c && c.servico);
    if (!contas.length) return false;
    const blocos = [];
    const servicos = {};
    const semConta = [];
    contas.forEach(c => {
      try {
        const t = tratarConta_(c, quem);
        blocos.push(t.linhas.join('\n'));
        const s = c.servico === 'condominio' ? 'agua' : c.servico;
        servicos[s] = true;
        const venc = String(c.vencimento || '');
        const aVencer = Formato.ehDataISO(venc) && venc >= Formato.hoje(-5);
        if (!t.res.conta && aVencer && (Number(c.valor_pagar) || Number(c.valor_total)) > 0) semConta.push({ c: c, categoria: t.res.categoria });
      } catch (e) {
        blocos.push('⚠️ ' + Telegram.esc(String(e.message || e)));
      }
    });
    const comp = comparacao_(Object.keys(servicos));
    Telegram.enviar(chatId, blocos.join('\n\n') + (comp ? '\n\n' + comp : '') + '\n\n<i>Registrado na tela Consumo da casa.</i>');

    // Conta a vencer sem conta fixa correspondente: rascunho para lançar
    semConta.forEach(x => {
      const c = x.c;
      const r = Rascunho.criar({
        tipo: 'despesa', valor: Math.round((Number(c.valor_pagar) || Number(c.valor_total)) * 100) / 100,
        data: c.vencimento, descricao: String(c.fornecedor || ('Conta de ' + (NOMES[c.servico] || c.servico))).slice(0, 80),
        conta: '', cartao: '', categoria: x.categoria || '', parcelas: 1, duvidas: [],
        chatId: chatId, usuarioId: usuarioId, quem: quem, origem: 'cupom',
        cabecalho: 'Conta a pagar · ' + (NOMES[c.servico] || c.servico),
        textoOriginal: 'Conta de ' + (NOMES[c.servico] || c.servico) + ' ' + (c.referencia || '')
      });
      Rascunho.mostrarNovo(r, ctx);
    });
    return true;
  }

  /** Ponto de entrada a partir do Cupom: devolve true se tratou a imagem. */
  function tratar(b, chatId, usuarioId, quem, legenda, ctx) {
    if (b.documento === 'medidor') return tratarMedidor_(b, chatId, quem, legenda || '');
    if (b.documento === 'conta_consumo') return tratarContas_(b, chatId, usuarioId, quem, ctx);
    return false;
  }

  /** /agua 523,100 · /gas 12,3 */
  function comandoLeitura(servico, texto, chatId, quem) {
    const m = String(texto || '').match(/(\d[\d.]*,\d+|\d+(?:\.\d+)?)/);
    if (!m) {
      Telegram.enviar(chatId, 'Mande o número do medidor junto: <code>/' + (servico === 'gas' ? 'gas' : 'agua') + ' 523,100</code>');
      return;
    }
    const bruto = m[1];
    const leitura = bruto.indexOf(',') !== -1 ? Number(bruto.replace(/\./g, '').replace(',', '.')) : Number(bruto);
    try {
      const r = registrarLeitura_(servico, leitura, '', 'telegram', quem);
      if (r.repetida) { Telegram.enviar(chatId, 'Essa leitura já estava anotada hoje.'); return; }
      Telegram.enviar(chatId, textoLeitura_(r));
    } catch (e) {
      Telegram.enviar(chatId, '⚠️ ' + Telegram.esc(String(e.message || e)));
    }
  }

  /** /consumo: o último mês de cada serviço. */
  function resumo(chatId) {
    const d = FF.appConsumo();
    const L = ['<b>Consumo da casa</b>'];
    d.servicos.forEach(s => {
      const u = s.ultimo;
      let linha = EMOJI[s.id] + ' ' + s.nome + ': ';
      if (!u) linha += 'sem contas ainda';
      else {
        linha += Formato.competenciaBR(u.referencia) + ' · ' + (u.valor !== null ? Formato.brl(u.valor) : '—') +
          (u.consumo !== null ? ' · ' + num_(u.consumo, s.unidade === 'kWh' ? 0 : 1) + ' ' + s.unidade + (u.estimado ? ' (est.)' : '') : '');
        if (s.variacao_pct !== null) linha += ' · ' + (s.variacao_pct > 0 ? '+' : '') + s.variacao_pct + '% vs média';
      }
      L.push(linha);
      if (s.alerta) L.push('   ⚠️ ' + Telegram.esc(s.alerta));
      if (s.id === 'agua' && s.leituras.length) {
        const l = s.leituras[0];
        L.push('   última leitura ' + Formato.dataBR(l.data) + ': ' + num_(l.leitura, 3) + ' m³' + (l.por_dia !== null ? ' · ' + litros_(l.por_dia) + '/dia' : ''));
      }
    });
    L.push('', '<i>Mande a foto do hidrômetro ou de uma conta de luz, gás ou condomínio que eu registro.</i>');
    Telegram.enviar(chatId, L.join('\n'));
  }

  return { tratar: tratar, comandoLeitura: comandoLeitura, resumo: resumo };
})();
