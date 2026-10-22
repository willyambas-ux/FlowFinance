/**
 * Cache.gs — cache em memória usando CacheService (per-user).
 *
 * - TTL padrão: 10 min.
 * - Entradas > ~95KB são silenciosamente descartadas (limite do CacheService).
 * - Invalidação automática é orquestrada pela camada Database.gs.
 * - Para forçar refresh, chame Cache.invalidateAll() ou clearAllCaches() (Main.gs).
 */
const Cache = (function () {
  const TTL_DEFAULT = 600;
  const PREFIX = 'ff:';
  const MAX_VALUE_SIZE = 95000;

  const KNOWN_KEYS = [
    'contas','categorias','centros','cartoes','projetos','regras','recorrencias',
    'lancamentos','orcamentos','fechamentos','tags','contatos','config'
  ];

  function get(key) {
    try {
      const raw = CacheService.getUserCache().get(PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function put(key, value, ttl) {
    try {
      const json = JSON.stringify(value);
      if (json.length > MAX_VALUE_SIZE) return false;
      CacheService.getUserCache().put(PREFIX + key, json, ttl || TTL_DEFAULT);
      return true;
    } catch (e) {
      return false;
    }
  }

  function invalidate(key) {
    try { CacheService.getUserCache().remove(PREFIX + key); } catch (e) {}
  }

  function invalidateAll() {
    try {
      CacheService.getUserCache().removeAll(KNOWN_KEYS.map(k => PREFIX + k));
    } catch (e) {}
  }

  function getOrFetch(key, fetcher, ttl) {
    const cached = get(key);
    if (cached !== null) return cached;
    const fresh = fetcher();
    put(key, fresh, ttl);
    return fresh;
  }

  return {
    get: get,
    put: put,
    invalidate: invalidate,
    invalidateAll: invalidateAll,
    getOrFetch: getOrFetch
  };
})();
