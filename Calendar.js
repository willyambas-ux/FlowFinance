/**
 * Calendar.gs — integração com Google Calendar.
 *
 * Cria um calendário dedicado "FlowFinance" e lança contas a pagar
 * (despesas pendentes/agendadas) como eventos all-day no dia do vencimento.
 *
 * - Eventos somem quando status muda para confirmado/conciliado.
 * - Sync de uma direção: FlowFinance → Calendar.
 * - Cada lançamento guarda `calendar_event_id` pra atualizar/remover depois.
 */

const CALENDAR_NAME = 'FlowFinance';
const PROP_CALENDAR_ID = 'FLOWFINANCE_CALENDAR_ID';
const PROP_CALENDAR_AUTOSYNC = 'FLOWFINANCE_CALENDAR_AUTOSYNC';

function getOrCreateFlowFinanceCalendar_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty(PROP_CALENDAR_ID);
  if (id) {
    try {
      const cal = CalendarApp.getCalendarById(id);
      if (cal) return cal;
    } catch (e) {}
  }
  const existentes = CalendarApp.getCalendarsByName(CALENDAR_NAME);
  let cal;
  if (existentes && existentes.length > 0) {
    cal = existentes[0];
  } else {
    cal = CalendarApp.createCalendar(CALENDAR_NAME, {
      summary: 'Contas a pagar do FlowFinance',
      color: CalendarApp.Color.RED
    });
  }
  props.setProperty(PROP_CALENDAR_ID, cal.getId());
  return cal;
}

function getCalendarSyncInfo() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(PROP_CALENDAR_ID);
  let nome = null;
  if (id) {
    try {
      const cal = CalendarApp.getCalendarById(id);
      nome = cal ? cal.getName() : null;
    } catch (e) {}
  }
  return {
    initialized: !!id && !!nome,
    autoSync: props.getProperty(PROP_CALENDAR_AUTOSYNC) === 'true',
    calendarId: id || null,
    calendarName: nome,
    calendarUrl: 'https://calendar.google.com/calendar/u/0/r'
  };
}

function setCalendarAutoSync(enabled) {
  PropertiesService.getScriptProperties().setProperty(
    PROP_CALENDAR_AUTOSYNC, enabled ? 'true' : 'false'
  );
  return { autoSync: !!enabled };
}

function _ehContaAPagar(l) {
  if (!l) return false;
  if (l.transferencia_id) return false; // transferências/pagamentos de fatura não viram lembrete
  const v = Number(l.valor) || 0;
  if (v >= 0) return false; // só despesas
  return l.status === 'pendente' || l.status === 'agendado';
}

function _tituloEvento(l) {
  const v = Math.abs(Number(l.valor) || 0);
  const valor = v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const prefixo = l.status === 'agendado' ? 'Agendado' : 'Pagar';
  return prefixo + ': ' + (l.descricao || '(sem descrição)') + ' — ' + valor;
}

function _descricaoEvento(l) {
  const linhas = [];
  const v = Math.abs(Number(l.valor) || 0);
  linhas.push('Valor: R$ ' + v.toFixed(2).replace('.', ','));
  if (l.conta) {
    const conta = DB.findById('Contas', l.conta);
    if (conta) linhas.push('Conta: ' + conta.nome);
  }
  if (l.cartao) {
    const cartao = DB.findById('Cartoes', l.cartao);
    if (cartao) linhas.push('Cartão: ' + cartao.nome);
  }
  if (l.categoria) {
    const cat = DB.findById('Categorias', l.categoria);
    if (cat) linhas.push('Categoria: ' + cat.nome);
  }
  if (l.centro) {
    const c = DB.findById('Centros', l.centro);
    if (c) linhas.push('Centro: ' + c.nome);
  }
  linhas.push('Status: ' + (l.status || 'pendente'));
  if (l.observacao) linhas.push('Obs: ' + l.observacao);
  linhas.push('');
  linhas.push('— Gerado automaticamente pelo FlowFinance');
  return linhas.join('\n');
}

/**
 * Sincroniza UM lançamento com o calendar. Cria/atualiza/remove conforme o caso.
 * Retorna o novo calendar_event_id (string vazia se removido / não aplicável).
 */
function syncLancamentoCalendar_(lanc, cal) {
  if (!lanc) return '';
  cal = cal || getOrCreateFlowFinanceCalendar_();
  const eventId = lanc.calendar_event_id || '';

  if (_ehContaAPagar(lanc)) {
    const dataStr = String(lanc.data || Utils.today());
    const data = new Date(dataStr + (dataStr.length === 10 ? 'T12:00:00' : ''));
    const titulo = _tituloEvento(lanc);
    const desc = _descricaoEvento(lanc);

    if (eventId) {
      try {
        const ev = cal.getEventById(eventId);
        if (ev) {
          ev.setTitle(titulo);
          ev.setDescription(desc);
          ev.setAllDayDate(data);
          return eventId;
        }
      } catch (e) { /* fall through pra recriar */ }
    }
    const ev = cal.createAllDayEvent(titulo, data, { description: desc });
    return ev.getId();
  }

  // Não é mais conta a pagar — remove evento se existia
  if (eventId) {
    try {
      const ev = cal.getEventById(eventId);
      if (ev) ev.deleteEvent();
    } catch (e) {}
  }
  return '';
}

/**
 * Sincroniza em lote todas as contas a pagar dos próximos `diasFrente` dias (default 90).
 * Retorna { criados, atualizados, removidos }.
 */
function sincronizarContasAPagar(diasFrente) {
  const cal = getOrCreateFlowFinanceCalendar_();
  const dias = Math.max(1, Math.min(365, Number(diasFrente) || 90));
  const hoje = Utils.today();
  const fim = new Date();
  fim.setDate(fim.getDate() + dias);
  const fimStr = Utils.formatDate(fim);

  const lancs = DB.readAll(SHEET_LANCAMENTOS);
  let criados = 0, atualizados = 0, removidos = 0;

  lancs.forEach(l => {
    const dentroDoRange = l.data >= hoje && l.data <= fimStr;
    const elegivel = _ehContaAPagar(l) && dentroDoRange;
    const tinhaEvento = !!l.calendar_event_id;

    if (elegivel) {
      const wasNew = !tinhaEvento;
      const novoId = syncLancamentoCalendar_(l, cal);
      if (novoId !== l.calendar_event_id) {
        DB.update(SHEET_LANCAMENTOS, l.id, { calendar_event_id: novoId });
      }
      if (wasNew) criados++;
      else        atualizados++;
    } else if (tinhaEvento) {
      try {
        const ev = cal.getEventById(l.calendar_event_id);
        if (ev) ev.deleteEvent();
      } catch (e) {}
      DB.update(SHEET_LANCAMENTOS, l.id, { calendar_event_id: '' });
      removidos++;
    }
  });

  return { criados: criados, atualizados: atualizados, removidos: removidos };
}

/**
 * Remove todos os eventos do calendário FlowFinance e limpa as referências.
 */
function removerTodosEventosCalendar() {
  const cal = getOrCreateFlowFinanceCalendar_();
  const ini = new Date(); ini.setFullYear(ini.getFullYear() - 1);
  const fim = new Date(); fim.setFullYear(fim.getFullYear() + 2);
  const events = cal.getEvents(ini, fim);
  let count = 0;
  events.forEach(ev => {
    try { ev.deleteEvent(); count++; } catch (e) {}
  });
  const lancs = DB.readAll(SHEET_LANCAMENTOS).filter(l => l.calendar_event_id);
  lancs.forEach(l => {
    DB.update(SHEET_LANCAMENTOS, l.id, { calendar_event_id: '' });
  });
  return { removidos: count };
}

/**
 * Helper interno para usar nos hooks de save/delete em Lancamentos.gs.
 * Não lança — falhas no Calendar não devem bloquear o save do lançamento.
 */
function _autoSyncIfEnabled(lanc) {
  try {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(PROP_CALENDAR_AUTOSYNC) !== 'true') return null;
    const cal = getOrCreateFlowFinanceCalendar_();
    const novoId = syncLancamentoCalendar_(lanc, cal);
    return novoId;
  } catch (e) {
    return null;
  }
}

function _removeCalendarEventForLanc(lanc) {
  try {
    if (!lanc || !lanc.calendar_event_id) return;
    const cal = getOrCreateFlowFinanceCalendar_();
    const ev = cal.getEventById(lanc.calendar_event_id);
    if (ev) ev.deleteEvent();
  } catch (e) {}
}
