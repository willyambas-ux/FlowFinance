/**
 * Seed.gs — popula categorias, subcategorias e centros padrão.
 *
 * Idempotente: só insere itens que ainda não existem (compara por nome,
 * case-insensitive, e pai para subcategorias).
 * Usa batchInsert (rápido).
 */

const CENTROS_PADRAO = [
  { nome: 'Receita fixa',     tipo: 'fixa',     cor: '#00a37c' },
  { nome: 'Receita variável', tipo: 'variavel', cor: '#1abc9c' },
  { nome: 'Receita eventual', tipo: 'eventual', cor: '#16a085' },
  { nome: 'Despesa fixa',     tipo: 'fixa',     cor: '#e53935' },
  { nome: 'Despesa variável', tipo: 'variavel', cor: '#e67e22' },
  { nome: 'Despesa eventual', tipo: 'eventual', cor: '#f1c40f' }
];

const CATEGORIAS_PADRAO = [
  // Receitas
  { nome: 'Salário',            tipo: 'receita', icone: 'work',
    subs: ['Salário líquido', '13º salário', 'Férias', 'PLR / Bônus', 'Comissões'] },
  { nome: 'Trabalho autônomo',  tipo: 'receita', icone: 'business_center',
    subs: ['Freelance', 'Consultoria', 'Serviços prestados'] },
  { nome: 'Investimentos',      tipo: 'receita', icone: 'trending_up',
    subs: ['Rendimentos', 'Dividendos', 'Resgates', 'Juros'] },
  { nome: 'Outras receitas',    tipo: 'receita', icone: 'add_circle',
    subs: ['Reembolso', 'Presentes recebidos', 'Vendas', 'Aluguel recebido'] },

  // Despesas
  { nome: 'Moradia',            tipo: 'despesa', icone: 'home',
    subs: ['Aluguel', 'Condomínio', 'IPTU', 'Luz', 'Gás', 'Água',
           'Internet/TV', 'Diarista', 'Manutenção'] },
  { nome: 'Alimentação',        tipo: 'despesa', icone: 'restaurant',
    subs: ['Supermercado', 'Restaurante', 'Delivery', 'Padaria', 'Café', 'Feira'] },
  { nome: 'Transporte',         tipo: 'despesa', icone: 'directions_car',
    subs: ['Combustível', 'Uber/Táxi', 'Estacionamento', 'Manutenção veículo',
           'IPVA / Licenciamento', 'Seguro veicular', 'Transporte público', 'Pedágio'] },
  { nome: 'Saúde',              tipo: 'despesa', icone: 'medical_services',
    subs: ['Plano de saúde', 'Consultas', 'Exames', 'Farmácia', 'Academia',
           'Terapia', 'Dentista'] },
  { nome: 'Educação',           tipo: 'despesa', icone: 'school',
    subs: ['Mensalidade', 'Cursos', 'Livros e materiais', 'Idiomas'] },
  { nome: 'Lazer',              tipo: 'despesa', icone: 'sports_esports',
    subs: ['Cinema/Teatro', 'Streaming', 'Viagem', 'Hobbies', 'Bares', 'Eventos'] },
  { nome: 'Vestuário',          tipo: 'despesa', icone: 'checkroom',
    subs: ['Roupas', 'Calçados', 'Acessórios'] },
  { nome: 'Pessoais',           tipo: 'despesa', icone: 'face',
    subs: ['Higiene', 'Beleza', 'Presentes para outros', 'Pet'] },
  { nome: 'Impostos e taxas',   tipo: 'despesa', icone: 'receipt_long',
    subs: ['IR', 'Tarifas bancárias', 'Multas', 'Anuidades'] },
  { nome: 'Outras despesas',    tipo: 'despesa', icone: 'more_horiz',
    subs: ['Doações', 'Emergência'] },

  // Transferências (categoria especial, sem subs)
  { nome: 'Pagamento de cartão', tipo: 'transferencia', icone: 'credit_card', subs: [] },
  { nome: 'Transferência entre contas', tipo: 'transferencia', icone: 'swap_horiz', subs: [] }
];

function seedDefaultCategoriasECentros() {
  let centrosCriados = 0, catsCriadas = 0;
  const nowISO = new Date().toISOString();
  const norm = (s) => String(s || '').trim().toLowerCase();

  // ----- Centros -----
  const centrosEx = listCentros();
  const centroNovos = CENTROS_PADRAO
    .filter(c => !centrosEx.find(x => norm(x.nome) === norm(c.nome)))
    .map(c => {
      const rec = normalizeCentro_(c);
      return Object.assign({ id: Utils.uuid(), criado_em: nowISO }, rec);
    });
  if (centroNovos.length) {
    DB.batchInsert(SHEET_CENTROS, centroNovos);
    centrosCriados = centroNovos.length;
  }

  // ----- Categorias (pais primeiro, depois subs) -----
  const catsEx = listCategorias();
  const novosPais = [];
  const paiIds = {}; // nome→id (existente ou novo)

  CATEGORIAS_PADRAO.forEach(c => {
    const exPai = catsEx.find(x => norm(x.nome) === norm(c.nome) && !x.pai);
    if (exPai) {
      paiIds[norm(c.nome)] = exPai.id;
    } else {
      const id = Utils.uuid();
      paiIds[norm(c.nome)] = id;
      const rec = normalizeCategoria_({ nome: c.nome, tipo: c.tipo, icone: c.icone });
      novosPais.push(Object.assign({ id: id, criado_em: nowISO }, rec));
    }
  });

  if (novosPais.length) {
    DB.batchInsert(SHEET_CATEGORIAS, novosPais);
    catsCriadas += novosPais.length;
  }

  // Recarrega após inserir os pais (pra checar subs corretamente)
  const catsExAfter = listCategorias();
  const novosSubs = [];
  CATEGORIAS_PADRAO.forEach(c => {
    const paiId = paiIds[norm(c.nome)];
    if (!paiId || !c.subs) return;
    c.subs.forEach(subNome => {
      const ex = catsExAfter.find(x =>
        norm(x.nome) === norm(subNome) && String(x.pai) === String(paiId)
      );
      if (!ex) {
        const rec = normalizeCategoria_({ nome: subNome, tipo: c.tipo, icone: 'label', pai: paiId });
        novosSubs.push(Object.assign({ id: Utils.uuid(), criado_em: nowISO }, rec));
      }
    });
  });

  if (novosSubs.length) {
    DB.batchInsert(SHEET_CATEGORIAS, novosSubs);
    catsCriadas += novosSubs.length;
  }

  // Invalida caches do client após
  return { centros_criados: centrosCriados, categorias_criadas: catsCriadas };
}

/**
 * Migration: marca lançamentos pendentes com data futura como "agendado".
 * Útil pra dados criados antes da regra automática.
 */
function marcarFuturosComoAgendado() {
  const hoje = Utils.today();
  const lancs = DB.readAll(SHEET_LANCAMENTOS).filter(l =>
    l.status === 'pendente' && l.data > hoje
  );
  let count = 0;
  lancs.forEach(l => {
    DB.update(SHEET_LANCAMENTOS, l.id, { status: 'agendado' });
    count++;
  });
  return { atualizados: count };
}
