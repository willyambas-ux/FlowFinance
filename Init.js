/**
 * Init.gs — schema das abas e criação automática (segura para schemas em evolução).
 * Idempotente: rodar várias vezes não duplica nem sobrescreve dados existentes.
 */
const Init = (function () {
  const SCHEMA = {
    'Contas':        ['id','nome','tipo','saldo_inicial','data_saldo_inicial','icone','icone_url','moeda','banco','agencia','numero','limite','contato','telefone','ativo','criado_em','reserva'],
    'Cartoes':       ['id','nome','conta_pagamento','dia_fechamento','dia_vencimento','limite','bandeira','icone','icone_url','ativo','criado_em'],
    'Categorias':    ['id','nome','pai','tipo','icone','criado_em','natureza'],
    'Centros':       ['id','nome','tipo','cor','criado_em'],
    'Projetos':      ['id','nome','valor_meta','data_alvo','conta_vinculada','criado_em'],
    'Tags':          ['id','nome','criado_em'],
    'Contatos':      ['id','nome','tipo','criado_em'],
    'Lancamentos':   ['id','data','descricao','valor','conta','categoria','centro','projeto','contato','tags','status','cartao','parcela_atual','parcela_total','recorrencia_id','transferencia_id','anexo_url','calendar_event_id','conciliado','observacao','origem','fatura_competencia','quem','criado_em'],
    'Recorrencias':  ['id','descricao','valor','conta','cartao','categoria','centro','periodicidade','intervalo','dia','proxima_data','total_ocorrencias','ativo','criado_em'],
    'Orcamentos':    ['id','nome','tipo','referencia','valor','periodo','data_inicio','data_fim','mostrar_restante','criado_em'],
    'Regras':        ['id','condicao_campo','condicao_operador','condicao_valor','acao_campo','acao_valor','prioridade','ativo','criado_em'],
    'Fechamentos':   ['id','data','conta','saldo_real','criado_em'],
    'Config':        ['chave','valor'],
    // Decisões anotadas na reunião do mês (tela grande, Visão do mês)
    'Decisoes':      ['id','data','texto','quem','criado_em']
  };

  function ensureAllSheets() {
    const ss = DB.getSpreadsheet();
    const created = [];
    for (const name in SCHEMA) {
      let sheet = ss.getSheetByName(name);
      if (!sheet) {
        sheet = ss.insertSheet(name);
        created.push(name);
      }
      const expected = SCHEMA[name];
      const existingCols = sheet.getLastColumn();
      const existingHeaders = existingCols > 0
        ? sheet.getRange(1, 1, 1, existingCols).getValues()[0].map(h => String(h).trim())
        : [];

      if (existingHeaders.length === 0 || existingHeaders.every(h => h === '')) {
        // Aba sem cabeçalhos: aplica schema completo
        sheet.getRange(1, 1, 1, expected.length).setValues([expected]);
        sheet.setFrozenRows(1);
        sheet.getRange(1, 1, 1, expected.length)
          .setFontWeight('bold')
          .setBackground('#f1f3f4');
        sheet.autoResizeColumns(1, expected.length);
      } else {
        // Aba já tem cabeçalhos: só adiciona colunas faltantes ao final (preserva dados)
        const missing = expected.filter(h => existingHeaders.indexOf(h) === -1);
        if (missing.length > 0) {
          const startCol = existingHeaders.length + 1;
          sheet.getRange(1, startCol, 1, missing.length).setValues([missing]);
          sheet.getRange(1, startCol, 1, missing.length)
            .setFontWeight('bold')
            .setBackground('#f1f3f4');
        }
      }
    }
    // Remove a aba padrão da planilha se ainda estiver vazia
    const defaultSheet = ss.getSheetByName('Página1') || ss.getSheetByName('Sheet1');
    if (defaultSheet && ss.getSheets().length > 1 && defaultSheet.getLastRow() === 0) {
      ss.deleteSheet(defaultSheet);
    }
    return created;
  }

  function getSchema() {
    return SCHEMA;
  }

  return {
    ensureAllSheets: ensureAllSheets,
    getSchema: getSchema
  };
})();
