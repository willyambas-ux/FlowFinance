/**
 * Regras.gs — auto-preenchimento de lançamentos.
 *
 * Cada regra:
 *   SE [condicao_campo] [operador] [condicao_valor]
 *   ENTÃO [acao_campo] = [acao_valor]
 *
 * Operadores: contains, equals, starts_with, ends_with, regex, greater_than, less_than.
 * Campos de condição: descricao, valor, conta, cartao.
 * Campos de ação (MVP): categoria (extensível para centro, projeto, tags).
 *
 * Aplicação:
 *   - Só em lançamentos NOVOS (não em edições).
 *   - Só preenche campos vazios — nunca sobrescreve algo que o usuário definiu.
 *   - Ordem: prioridade decrescente, depois ordem natural.
 */
const SHEET_REGRAS = 'Regras';

function listRegras() {
  return DB.readAll(SHEET_REGRAS);
}

function saveRegra(data) {
  const record = normalizeRegra_(data);
  if (data && data.id) return DB.update(SHEET_REGRAS, data.id, record);
  return DB.insert(SHEET_REGRAS, record);
}

/**
 * Cria/atualiza uma regra REMOVENDO qualquer outra ativa com mesma palavra-chave
 * (mesmo condicao_campo + condicao_valor case-insensitive + acao_campo).
 * Evita regras conflitantes que acumulariam categorizações ambíguas.
 * Retorna { criada, removidas: N }.
 */
function saveRegraSubstituindo(data) {
  data = data || {};
  const novaCv = String(data.condicao_valor || '').trim().toLowerCase();
  const condCampo = data.condicao_campo || 'descricao';
  const acaoCampo = data.acao_campo || 'categoria';
  let removidas = 0;
  if (novaCv) {
    listRegras().forEach(r => {
      if (data.id && String(r.id) === String(data.id)) return; // não remove a própria
      if (!Utils.toBool(r.ativo)) return;
      if (r.condicao_campo !== condCampo) return;
      if (r.acao_campo !== acaoCampo) return;
      if (String(r.condicao_valor || '').trim().toLowerCase() !== novaCv) return;
      DB.remove(SHEET_REGRAS, r.id);
      removidas++;
    });
  }
  return { criada: saveRegra(data), removidas: removidas };
}

function deleteRegra(id) {
  return DB.remove(SHEET_REGRAS, id);
}

function normalizeRegra_(data) {
  data = data || {};
  return {
    condicao_campo: data.condicao_campo || 'descricao',
    condicao_operador: data.condicao_operador || 'contains',
    condicao_valor: String(data.condicao_valor || ''),
    acao_campo: data.acao_campo || 'categoria',
    acao_valor: String(data.acao_valor || ''),
    prioridade: Number(data.prioridade) || 0,
    ativo: data.ativo === undefined ? true : Utils.toBool(data.ativo)
  };
}

/**
 * Aplica regras ativas em ordem de prioridade, preenchendo apenas campos vazios.
 * Não muta o original; retorna um objeto novo.
 */
function aplicarRegras(lanc) {
  if (!lanc) return lanc;
  const regras = listRegras()
    .filter(r => Utils.toBool(r.ativo))
    .sort((a, b) => (Number(b.prioridade) || 0) - (Number(a.prioridade) || 0));

  const out = Object.assign({}, lanc);
  regras.forEach(r => {
    if (!matchCondicao_(r, out)) return;
    if (Utils.isEmpty(out[r.acao_campo])) {
      out[r.acao_campo] = r.acao_valor;
    }
  });
  return out;
}

/**
 * Cria regras de categorização para estabelecimentos brasileiros comuns.
 * Mapeia palavra-chave (na descrição) → subcategoria padrão (por nome).
 * Só cria se a categoria existir e a regra ainda não existir.
 */
function seedRegrasComuns() {
  const cats = listCategorias();
  function catId(nome) {
    const c = cats.find(x => String(x.nome).toLowerCase() === String(nome).toLowerCase());
    return c ? c.id : '';
  }

  // [palavra-chave que aparece na descrição] → [nome da subcategoria]
  const mapa = [
    // Transporte
    { kw: 'UBER',        cat: 'Uber/Táxi' },
    { kw: 'UBERRIDES',   cat: 'Uber/Táxi' },
    { kw: '99 ',         cat: 'Uber/Táxi' },
    { kw: 'POSTO',       cat: 'Combustível' },
    { kw: 'IPVA',        cat: 'IPVA / Licenciamento' },
    { kw: 'LAVAJATO',    cat: 'Manutenção veículo' },
    { kw: 'ESTACIONAMENTO', cat: 'Estacionamento' },
    // Alimentação
    { kw: 'IFD',         cat: 'Delivery' },   // iFood
    { kw: 'IFOOD',       cat: 'Delivery' },
    { kw: 'RAPPI',       cat: 'Delivery' },
    { kw: 'SUPERMERCADO',cat: 'Supermercado' },
    { kw: 'NORDESTAO',   cat: 'Supermercado' },
    { kw: 'SACOLAO',     cat: 'Supermercado' },
    { kw: 'MERCADINHO',  cat: 'Supermercado' },
    { kw: 'MERCADO',     cat: 'Supermercado' },
    { kw: 'ATACAD',      cat: 'Supermercado' },
    { kw: 'KFC',         cat: 'Restaurante' },
    { kw: 'BRASAS',      cat: 'Restaurante' },
    { kw: 'BURGER',      cat: 'Restaurante' },
    { kw: 'MC DONALD',   cat: 'Restaurante' },
    { kw: 'MCDONALD',    cat: 'Restaurante' },
    { kw: 'PADARIA',     cat: 'Padaria' },
    { kw: 'PANIFIC',     cat: 'Padaria' },
    { kw: 'OGGI',        cat: 'Café' },
    { kw: 'CAFE',        cat: 'Café' },
    // Saúde
    { kw: 'DROGASIL',    cat: 'Farmácia' },
    { kw: 'DROGARIA',    cat: 'Farmácia' },
    { kw: 'GRANADO',     cat: 'Farmácia' },
    { kw: 'PHARMA',      cat: 'Farmácia' },
    { kw: 'FARMACIA',    cat: 'Farmácia' },
    { kw: 'PAGUE MENOS', cat: 'Farmácia' },
    // Lazer / assinaturas digitais
    { kw: 'NETFLIX',     cat: 'Streaming' },
    { kw: 'YOUTUB',      cat: 'Streaming' },
    { kw: 'SPOTIFY',     cat: 'Streaming' },
    { kw: 'DISNEY',      cat: 'Streaming' },
    { kw: 'PRIME VIDEO', cat: 'Streaming' },
    { kw: 'GAME PASS',   cat: 'Streaming' },
    { kw: 'XBOX',        cat: 'Streaming' },
    { kw: 'OPENAI',      cat: 'Streaming' },
    { kw: 'CHATGPT',     cat: 'Streaming' },
    { kw: 'HOME ASSISTANT', cat: 'Streaming' },
    // Vestuário
    { kw: 'CENTAURO',    cat: 'Calçados' },
    { kw: 'CEA ',        cat: 'Roupas' },
    { kw: 'RENNER',      cat: 'Roupas' },
    { kw: 'RIACHUELO',   cat: 'Roupas' },
    // Educação
    { kw: 'ESCOLINHA',   cat: 'Mensalidade' },
    { kw: 'COLEGIO',     cat: 'Mensalidade' },
    { kw: 'ESTRATEGIA',  cat: 'Cursos' },
    // Compras gerais
    { kw: 'AMAZON',      cat: 'Hobbies' },
    { kw: 'MERCADOLIVRE',cat: 'Hobbies' },
    { kw: 'ALIEXPRESS',  cat: 'Hobbies' }
  ];

  const jaTem = {};
  listRegras().forEach(r => {
    if (r.condicao_campo === 'descricao' && r.acao_campo === 'categoria') {
      jaTem[String(r.condicao_valor).trim().toLowerCase()] = true;
    }
  });

  let criadas = 0, puladas = 0;
  const semCategoria = [];
  mapa.forEach(m => {
    const id = catId(m.cat);
    if (!id) { puladas++; if (semCategoria.indexOf(m.cat) === -1) semCategoria.push(m.cat); return; }
    if (jaTem[m.kw.trim().toLowerCase()]) { puladas++; return; }
    saveRegra({
      condicao_campo: 'descricao',
      condicao_operador: 'contains',
      condicao_valor: m.kw.trim(),
      acao_campo: 'categoria',
      acao_valor: id,
      prioridade: 0,
      ativo: true
    });
    criadas++;
  });
  return { criadas: criadas, puladas: puladas, sem_categoria: semCategoria };
}

function matchCondicao_(regra, lanc) {
  const valor = lanc[regra.condicao_campo];
  const ref = String(regra.condicao_valor || '');
  const op = regra.condicao_operador;

  if (op === 'greater_than') return Number(valor) > Number(ref);
  if (op === 'less_than')    return Number(valor) < Number(ref);

  const v = String(valor == null ? '' : valor).toLowerCase();
  const r = ref.toLowerCase();

  if (op === 'contains')    return v.indexOf(r) !== -1;
  if (op === 'equals')      return v === r;
  if (op === 'starts_with') return v.indexOf(r) === 0;
  if (op === 'ends_with')   return v.length >= r.length && v.lastIndexOf(r) === v.length - r.length;
  if (op === 'regex') {
    try { return new RegExp(ref, 'i').test(String(valor == null ? '' : valor)); }
    catch (e) { return false; }
  }
  return false;
}
