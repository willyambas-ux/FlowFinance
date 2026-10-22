/**
 * Formato.js — datas, dinheiro e texto.
 */
const Formato = (function () {
  const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

  function fuso_() { return Session.getScriptTimeZone(); }

  /** Data de hoje (ou deslocada em dias) como YYYY-MM-DD no fuso do script. */
  function hoje(deslocamentoDias) {
    const d = new Date();
    if (deslocamentoDias) d.setDate(d.getDate() + deslocamentoDias);
    return Utilities.formatDate(d, fuso_(), 'yyyy-MM-dd');
  }

  function diaDaSemanaHoje() {
    const n = Number(Utilities.formatDate(new Date(), fuso_(), 'u')); // 1 = segunda ... 7 = domingo
    return DIAS[n % 7];
  }

  function ehDataISO(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  }

  /** '2026-10-21' -> '21/10/2026' */
  function dataBR(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? (m[3] + '/' + m[2] + '/' + m[1]) : String(iso || '');
  }

  /** '2026-11' -> 'nov/2026' */
  function competenciaBR(yyyymm) {
    const m = String(yyyymm || '').match(/^(\d{4})-(\d{2})/);
    return m ? (MESES[Number(m[2]) - 1] + '/' + m[1]) : '';
  }

  /** 1234.5 -> 'R$ 1.234,50' (sempre positivo; o sinal é dito pelo tipo) */
  function brl(v) {
    const n = Math.abs(Number(v) || 0);
    const partes = n.toFixed(2).split('.');
    const inteiro = partes[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return 'R$ ' + inteiro + ',' + partes[1];
  }

  function semAcento(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  return {
    hoje: hoje,
    diaDaSemanaHoje: diaDaSemanaHoje,
    ehDataISO: ehDataISO,
    dataBR: dataBR,
    competenciaBR: competenciaBR,
    brl: brl,
    semAcento: semAcento
  };
})();
