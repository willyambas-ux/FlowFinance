/**
 * Utils.gs — helpers compartilhados (datas, números, ids).
 */
const Utils = (function () {
  function uuid() {
    return Utilities.getUuid();
  }

  function today() {
    return formatDate(new Date());
  }

  function formatDate(date) {
    if (!date) return '';
    if (!(date instanceof Date)) date = new Date(date);
    if (isNaN(date.getTime())) return '';
    return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  function toNumber(v) {
    if (typeof v === 'number') return v;
    if (v === null || v === undefined || v === '') return 0;
    const s = String(v).replace(/\./g, '').replace(',', '.').replace(/[^\d.\-]/g, '');
    const n = Number(s);
    return isNaN(n) ? 0 : n;
  }

  function monthRange(year, month) {
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0);
    return { start: formatDate(start), end: formatDate(end) };
  }

  function isEmpty(v) {
    return v === null || v === undefined || v === '';
  }

  function toBool(v) {
    if (typeof v === 'boolean') return v;
    if (v === undefined || v === null || v === '') return false;
    const s = String(v).toLowerCase();
    return s === 'true' || s === '1' || s === 'sim';
  }

  /**
   * Status em que o dinheiro já entrou ou saiu de verdade.
   * 'revisar' = aconteceu (veio de notificação do banco), mas falta você conferir
   * categoria/conta; por isso já conta no saldo.
   */
  function statusRealizado(status) {
    return status === 'confirmado' || status === 'conciliado' || status === 'revisar';
  }

  /** Data em 'yyyy-MM-dd', venha ela como Date (planilha) ou como texto. */
  function dataISO(v) {
    if (!v) return '';
    if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? '' : formatDate(v);
    return String(v).slice(0, 10);
  }

  /**
   * Marco zero da conta: o saldo inicial é o saldo no FIM do dia data_saldo_inicial.
   * Lançamentos até essa data (inclusive) já estão dentro dele e não entram de novo
   * no saldo; ficam só como histórico para relatórios.
   */
  function antesDoMarco(l, conta) {
    const marco = conta ? dataISO(conta.data_saldo_inicial) : '';
    return !!marco && dataISO(l.data) <= marco;
  }

  return {
    statusRealizado: statusRealizado,
    dataISO: dataISO,
    antesDoMarco: antesDoMarco,
    uuid: uuid,
    today: today,
    formatDate: formatDate,
    toNumber: toNumber,
    monthRange: monthRange,
    isEmpty: isEmpty,
    toBool: toBool
  };
})();
