/**
 * Transferencias.gs — transferência entre contas (ou conta ↔ cartão como pagamento de fatura).
 *
 * Modelo:
 *   - Cria 2 lançamentos com mesmo `transferencia_id`:
 *       perna 1: saída na origem (valor negativo)
 *       perna 2: entrada no destino (valor positivo)
 *   - Lançamentos com transferencia_id são excluídos de receitas/despesas em agregações
 *     (são neutros para o patrimônio).
 */

function criarTransferencia(data) {
  data = data || {};
  const valor = Math.abs(Utils.toNumber(data.valor));
  if (valor <= 0) throw new Error('Valor deve ser maior que zero.');

  const origem = String(data.conta_origem || '').trim();
  const destino = String(data.conta_destino || '').trim();
  if (!origem || !destino) throw new Error('Informe conta de origem e conta de destino.');
  if (origem === destino) throw new Error('Origem e destino devem ser contas diferentes.');

  const tid = Utils.uuid();
  const dataLanc = data.data || Utils.today();
  const desc = String(data.descricao || 'Transferência').trim();
  const status = data.status || 'pendente';

  // Quem lançou e de onde veio (opcionais) seguem nas duas pernas
  const extras = {};
  ['origem', 'quem', 'observacao'].forEach(k => { if (data[k]) extras[k] = data[k]; });

  saveLancamento(Object.assign({
    data: dataLanc,
    descricao: desc + ' (saída)',
    valor: -valor,
    conta: origem,
    status: status,
    transferencia_id: tid
  }, extras));
  saveLancamento(Object.assign({
    data: dataLanc,
    descricao: desc + ' (entrada)',
    valor: valor,
    conta: destino,
    status: status,
    transferencia_id: tid
  }, extras));

  return { transferencia_id: tid };
}

/**
 * Cria N transferências consecutivas (parcelado).
 * Diferente de criarParcelamento (que DIVIDE o valor), aqui CADA transferência tem
 * o valor inteiro — útil pra aportes mensais, mensalidades transferidas, etc.
 *
 * @param {Object} data - {data, descricao, valor, conta_origem, conta_destino, status}
 * @param {number} total - quantidade de transferências
 * @param {number} inicial - primeira (1 = começa em data; útil pra registrar a partir da N-ésima)
 * @param {string} periodicidade - 'diaria' | 'semanal' | 'mensal' | 'anual'
 * @param {number} intervalo - a cada N períodos
 */
function criarTransferenciaSerie(data, total, inicial, periodicidade, intervalo) {
  total = Math.max(1, Math.floor(Number(total) || 1));
  inicial = Math.max(1, Math.min(total, Math.floor(Number(inicial) || 1)));
  intervalo = Math.max(1, Math.floor(Number(intervalo) || 1));
  const period = periodicidade || 'mensal';
  if (total === 1) return [criarTransferencia(data)];

  const baseData = data.data || Utils.today();
  const baseDate = new Date(baseData + (String(baseData).length === 10 ? 'T00:00:00' : ''));
  const baseDesc = String(data.descricao || 'Transferência').trim();
  const serieId = Utils.uuid();

  const criados = [];
  for (let i = inicial; i <= total; i++) {
    const offset = i - inicial;
    const d = offsetData_(baseDate, period, intervalo, offset);
    const sufixo = ' (' + i + '/' + total + ')';
    const tid = Utils.uuid();
    const dataStr = Utils.formatDate(d);
    const valor = Math.abs(Utils.toNumber(data.valor));
    const status = data.status || 'pendente';

    // Perna 1: saída
    saveLancamento({
      data: dataStr,
      descricao: baseDesc + ' (saída)' + sufixo,
      valor: -valor,
      conta: data.conta_origem,
      status: status,
      transferencia_id: tid,
      recorrencia_id: serieId,
      parcela_atual: i,
      parcela_total: total
    });
    // Perna 2: entrada
    saveLancamento({
      data: dataStr,
      descricao: baseDesc + ' (entrada)' + sufixo,
      valor: valor,
      conta: data.conta_destino,
      status: status,
      transferencia_id: tid,
      recorrencia_id: serieId,
      parcela_atual: i,
      parcela_total: total
    });
    criados.push({ transferencia_id: tid, parcela: i });
  }
  return criados;
}

/**
 * Verifica se um lançamento é perna de transferência (ou pagamento de fatura).
 */
function ehTransferencia(l) {
  return !!(l && l.transferencia_id);
}
