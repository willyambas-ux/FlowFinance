/**
 * Recorrencias.gs — templates de lançamentos repetitivos (mensal/semanal/anual).
 *
 * Modelo:
 *   - Cada recorrência tem `proxima_data` (próxima ocorrência ainda não gerada).
 *   - `gerarRecorrencias(dataAlvo)` cria lançamentos físicos até `dataAlvo`, avançando `proxima_data`.
 *   - Idempotente: usa par (recorrencia_id, data) para evitar duplicação.
 *   - Ao salvar uma recorrência ativa, gera automaticamente os próximos 12 meses.
 */
const SHEET_RECORRENCIAS = 'Recorrencias';

function listRecorrencias() {
  return DB.readAll(SHEET_RECORRENCIAS);
}

function saveRecorrencia(data) {
  const isNew = !(data && data.id);
  const record = normalizeRecorrencia_(data);
  const saved = isNew
    ? DB.insert(SHEET_RECORRENCIAS, record)
    : DB.update(SHEET_RECORRENCIAS, data.id, record);

  if (Utils.toBool(saved.ativo)) {
    try {
      const totalOcc = Number(saved.total_ocorrencias) || 0;
      let target;
      if (isNew && totalOcc > 0) {
        // Calcula data final exata para totalOcc ocorrências
        target = saved.proxima_data;
        for (let i = 0; i < totalOcc - 1; i++) {
          target = avancarData_(target, saved.periodicidade, saved.dia, saved.intervalo);
        }
      } else {
        target = addMonthsAhead_(12);
      }
      gerarRecorrencias(target);
      if (isNew && totalOcc > 0) {
        // Limite atingido: desativa para não gerar além
        DB.update(SHEET_RECORRENCIAS, saved.id, { ativo: false });
      }
    } catch (e) { /* não bloqueia salvamento */ }
  }
  return saved;
}

function deleteRecorrencia(id) {
  return DB.remove(SHEET_RECORRENCIAS, id);
}

function normalizeRecorrencia_(data) {
  data = data || {};
  const cartao = String(data.cartao || '').trim();
  const conta = String(data.conta || '').trim();
  return {
    descricao: String(data.descricao || '').trim(),
    valor: Utils.toNumber(data.valor),
    conta: cartao ? '' : conta,
    cartao: cartao,
    categoria: data.categoria || '',
    centro: data.centro || '',
    periodicidade: data.periodicidade || 'mensal',
    intervalo: Math.max(1, Math.floor(Number(data.intervalo) || 1)),
    dia: Math.max(1, Math.min(31, Number(data.dia) || 1)),
    proxima_data: data.proxima_data || Utils.today(),
    total_ocorrencias: Math.max(0, Math.floor(Number(data.total_ocorrencias) || 0)),
    ativo: data.ativo === undefined ? true : Utils.toBool(data.ativo)
  };
}

/**
 * Gera lançamentos a partir das recorrências ativas até `dataAlvo` (default: +3 meses).
 * Retorna { criados: N }.
 */
function gerarRecorrencias(dataAlvo) {
  const targetStr = dataAlvo || addMonthsAhead_(3);
  const recs = DB.readAll(SHEET_RECORRENCIAS).filter(r => Utils.toBool(r.ativo));
  if (recs.length === 0) return { criados: 0 };

  const lancs = DB.readAll(SHEET_LANCAMENTOS);
  const existentes = {};
  lancs.forEach(l => {
    if (l.recorrencia_id) existentes[l.recorrencia_id + '|' + l.data] = true;
  });

  const hoje = Utils.today();
  let criados = 0;
  recs.forEach(rec => {
    let proxima = rec.proxima_data;
    let guard = 0;
    while (proxima && proxima <= targetStr && guard < 600) {
      const key = rec.id + '|' + proxima;
      if (!existentes[key]) {
        const statusInicial = proxima >= hoje ? 'agendado' : 'pendente';
        saveLancamento({
          data: proxima,
          descricao: rec.descricao,
          valor: rec.valor,
          conta: rec.conta || '',
          cartao: rec.cartao || '',
          categoria: rec.categoria || '',
          centro: rec.centro || '',
          status: statusInicial,
          recorrencia_id: rec.id
        });
        existentes[key] = true;
        criados++;
      }
      proxima = avancarData_(proxima, rec.periodicidade, rec.dia, rec.intervalo);
      guard++;
    }
    if (proxima && proxima !== rec.proxima_data) {
      DB.update(SHEET_RECORRENCIAS, rec.id, { proxima_data: proxima });
    }
  });

  return { criados: criados };
}

/**
 * Avança uma data por `intervalo` períodos da `periodicidade`.
 *   diaria  → +N dias
 *   semanal → +N * 7 dias
 *   mensal  → +N meses (preservando o `dia`, clampado ao último dia do mês alvo)
 *   anual   → +N anos
 */
function avancarData_(dataStr, periodicidade, dia, intervalo) {
  const intv = Math.max(1, Math.floor(Number(intervalo) || 1));
  const s = String(dataStr);
  const d = new Date(s + (s.length === 10 ? 'T00:00:00' : ''));
  if (periodicidade === 'diaria') {
    d.setDate(d.getDate() + intv);
    return Utils.formatDate(d);
  }
  if (periodicidade === 'semanal') {
    d.setDate(d.getDate() + 7 * intv);
    return Utils.formatDate(d);
  }
  if (periodicidade === 'anual') {
    d.setFullYear(d.getFullYear() + intv);
    return Utils.formatDate(d);
  }
  // mensal
  d.setDate(1);
  d.setMonth(d.getMonth() + intv);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(Number(dia) || 1, lastDay));
  return Utils.formatDate(d);
}

function addMonthsAhead_(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return Utils.formatDate(d);
}
