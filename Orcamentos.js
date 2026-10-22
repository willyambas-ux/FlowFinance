/**
 * Orcamentos.gs — limites de gasto por categoria ou centro, por período (mensal).
 *
 * Schema:
 *   - tipo: 'categoria' | 'centro'
 *   - referencia: id da categoria ou centro
 *   - valor: limite no período (positivo)
 *   - periodo: 'mensal' (único valor suportado nesta fase)
 */
const SHEET_ORCAMENTOS = 'Orcamentos';

function listOrcamentos() {
  return DB.readAll(SHEET_ORCAMENTOS);
}

function saveOrcamento(data) {
  const record = normalizeOrcamento_(data);
  if (data && data.id) return DB.update(SHEET_ORCAMENTOS, data.id, record);
  return DB.insert(SHEET_ORCAMENTOS, record);
}

function deleteOrcamento(id) {
  return DB.remove(SHEET_ORCAMENTOS, id);
}

function normalizeOrcamento_(data) {
  data = data || {};
  const tipo = (data.tipo || 'categoria').toLowerCase();
  return {
    nome: String(data.nome || '').trim(),
    tipo: tipo === 'centro' ? 'centro' : 'categoria',
    referencia: data.referencia || '',
    valor: Math.abs(Utils.toNumber(data.valor)),
    periodo: data.periodo || 'mensal',
    data_inicio: _yyyyMM_(data.data_inicio || _todayYYYYMM_()),
    data_fim:    data.data_fim ? _yyyyMM_(data.data_fim) : '',
    mostrar_restante: data.mostrar_restante === undefined ? false : Utils.toBool(data.mostrar_restante)
  };
}

function _todayYYYYMM_() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function _yyyyMM_(s) {
  // Aceita "YYYY-MM" ou "YYYY-MM-DD" (devolve só "YYYY-MM")
  s = String(s || '').trim();
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 7);
  return '';
}

function _yyyyMMFromAnoMes_(ano, mes) {
  return ano + '-' + String(mes).padStart(2, '0');
}

/**
 * Calcula progresso de cada orçamento no mês informado.
 * Retorna: [{ id, tipo, referencia, nome, orcado, consumido, restante, percentual }]
 */
function getOrcamentosProgresso(ano, mes) {
  const yymm = _yyyyMMFromAnoMes_(ano, mes);
  const orcamentos = listOrcamentos().filter(o => {
    // Google Sheets pode converter "2026-06" pra Date e devolver "2026-06-01".
    // Comparamos só yyyy-MM (primeiros 7 chars) pra ser robusto.
    const ini = String(o.data_inicio || '').slice(0, 7);
    const fim = String(o.data_fim || '').slice(0, 7);
    if (ini && ini > yymm) return false;
    if (fim && fim < yymm) return false;
    return true;
  });
  if (orcamentos.length === 0) return [];

  const lancs = listLancamentos({ ano: ano, mes: mes }).filter(l => !l.transferencia_id);
  const categorias = listCategorias();
  const centros = listCentros();

  // Index pai → [filhos diretos]
  const filhosDireto = {};
  categorias.filter(c => c.pai).forEach(c => {
    (filhosDireto[c.pai] = filhosDireto[c.pai] || []).push(c.id);
  });
  // Retorna Set com TODOS os descendentes (até 5 níveis) de uma categoria
  function descendentesDe_(catId) {
    const set = new Set();
    function rec(id, depth) {
      if (depth > 5) return;
      (filhosDireto[id] || []).forEach(childId => {
        if (set.has(childId)) return;
        set.add(childId);
        rec(childId, depth + 1);
      });
    }
    rec(catId, 0);
    return set;
  }

  return orcamentos.map(o => {
    const orcado = Math.abs(Number(o.valor) || 0);
    let consumido = 0;
    let nome = '—';
    let qtdSubs = 0;
    const byStatus = { pendente: 0, agendado: 0, confirmado: 0, conciliado: 0 };

    function accStatus_(l) {
      const v = Math.abs(Number(l.valor) || 0);
      const st = l.status || 'pendente';
      if (Object.prototype.hasOwnProperty.call(byStatus, st)) byStatus[st] += v;
      consumido += v;
    }

    if (o.tipo === 'categoria') {
      const ids = descendentesDe_(o.referencia);
      qtdSubs = ids.size;
      ids.add(o.referencia); // inclui a própria categoria
      lancs.forEach(l => {
        if (l.categoria && ids.has(l.categoria)) accStatus_(l);
      });
      const cat = categorias.find(c => String(c.id) === String(o.referencia));
      nome = cat ? cat.nome : '—';
    } else {
      lancs.forEach(l => {
        if (l.centro === o.referencia) accStatus_(l);
      });
      const c = centros.find(x => String(x.id) === String(o.referencia));
      nome = c ? c.nome : '—';
    }

    const percentual = orcado > 0 ? Math.round((consumido / orcado) * 100) : 0;
    return {
      id: o.id,
      tipo: o.tipo,
      referencia: o.referencia,
      nome: o.nome ? o.nome : nome,
      ref_nome: nome,
      orcado: orcado,
      consumido: consumido,
      restante: orcado - consumido,
      percentual: percentual,
      data_inicio: String(o.data_inicio || '').slice(0, 7),
      data_fim:    String(o.data_fim    || '').slice(0, 7),
      inclui_subs: qtdSubs > 0,
      consumido_por_status: byStatus,
      mostrar_restante: Utils.toBool(o.mostrar_restante)
    };
  }).sort((a, b) => b.percentual - a.percentual);
}
