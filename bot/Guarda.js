/**
 * Guarda.js — memória do bot que dura mais que o cache.
 *
 * O CacheService guarda no máximo 6 horas. Uma compra feita à noite já tinha
 * sumido de manhã ("Esse lançamento expirou"). Aqui cada valor vai para o cache
 * (rápido) e também para as Propriedades do script, com validade de DIAS dias.
 * A leitura tenta o cache e, se não achar, as Propriedades.
 *
 * Limites das Propriedades: 9 KB por valor e 500 KB no total. Valor maior que
 * isso (cupom com muitos itens) fica só no cache, como antes. A limpeza dos
 * vencidos roda de vez em quando, durante as gravações.
 */
const Guarda = (function () {
  const DIAS = 4;
  const VALIDADE_MS = DIAS * 86400000;
  const CACHE_SEG = 21600; // máximo do CacheService
  const PREFIXO = 'g_';
  const LIMITE_BYTES = 8800;

  function cache_() { return CacheService.getScriptCache(); }
  function props_() { return PropertiesService.getScriptProperties(); }

  function bytes_(s) {
    try { return Utilities.newBlob(s).getBytes().length; } catch (e) { return encodeURIComponent(s).length; }
  }

  function put(chave, valor) {
    const v = String(valor);
    try { cache_().put(chave, v, CACHE_SEG); } catch (e) { console.warn('cache: ' + e); }
    const reg = JSON.stringify({ v: v, e: Date.now() + VALIDADE_MS });
    if (bytes_(reg) <= LIMITE_BYTES) {
      try { props_().setProperty(PREFIXO + chave, reg); } catch (e) { console.warn('guarda: ' + e); }
    }
    if (Math.random() < 0.05) limpar();
  }

  function get(chave) {
    let v = null;
    try { v = cache_().get(chave); } catch (e) { v = null; }
    if (v !== null && v !== undefined) return v;
    let raw = null;
    try { raw = props_().getProperty(PREFIXO + chave); } catch (e) { raw = null; }
    if (!raw) return null;
    try {
      const o = JSON.parse(raw);
      if (!o || Number(o.e) < Date.now()) { props_().deleteProperty(PREFIXO + chave); return null; }
      try { cache_().put(chave, o.v, CACHE_SEG); } catch (e) { /* só acelera a próxima leitura */ }
      return o.v;
    } catch (e) {
      return null;
    }
  }

  function remover(chave) {
    try { cache_().remove(chave); } catch (e) { /* ignora */ }
    try { props_().deleteProperty(PREFIXO + chave); } catch (e) { /* ignora */ }
  }

  /** Apaga das Propriedades o que já venceu. Devolve quantos apagou. */
  function limpar() {
    let apagados = 0;
    try {
      const p = props_();
      const todas = p.getProperties();
      const agora = Date.now();
      Object.keys(todas).forEach(k => {
        if (k.indexOf(PREFIXO) !== 0) return;
        let vencido = true;
        try { vencido = Number(JSON.parse(todas[k]).e) < agora; } catch (e) { vencido = true; }
        if (vencido) { p.deleteProperty(k); apagados++; }
      });
    } catch (e) {
      console.warn('limpeza da guarda: ' + e);
    }
    return apagados;
  }

  return { put: put, get: get, remover: remover, limpar: limpar, DIAS: DIAS };
})();
