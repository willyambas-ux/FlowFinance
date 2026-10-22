/**
 * Auth.gs — autenticação local (UX lock) por usuário Google.
 *
 * Modelo:
 *  - Cada usuário Google autorizado tem uma entrada com hash+salt da senha do app.
 *  - Senhas armazenadas em ScriptProperties (não visíveis na planilha).
 *  - O primeiro a acessar quando não há usuários define a primeira senha (vira admin).
 *  - Usuários autorizados podem adicionar/remover outros e trocar a própria senha.
 *  - Timeout de inatividade configurável (default 15 min).
 *
 * Segurança: este é um "trinco" de UX em cima da autenticação Google. Não é
 * blindagem completa (alguém autenticado no Google pode em tese chamar funções
 * via console). Para personal use entre 2 pessoas confiáveis é adequado.
 */

const AUTH_USERS_KEY = 'FF_AUTH_USERS';
const AUTH_TIMEOUT_KEY = 'FF_AUTH_TIMEOUT_MINUTES';
const AUTH_DEFAULT_TIMEOUT = 15;

function _authGetUsers_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(AUTH_USERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function _authSetUsers_(users) {
  PropertiesService.getScriptProperties().setProperty(AUTH_USERS_KEY, JSON.stringify(users));
}

function _authHash_(password, salt) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(salt) + ':' + String(password),
    Utilities.Charset.UTF_8
  );
  return bytes.map(b => (b < 0 ? b + 256 : b).toString(16))
    .map(s => s.length === 1 ? '0' + s : s).join('');
}

function _authGenSalt_() {
  return Utilities.getUuid().replace(/-/g, '');
}

function _authCurrentEmail_() {
  return Session.getActiveUser().getEmail();
}

function _authGetTimeout_() {
  const raw = PropertiesService.getScriptProperties().getProperty(AUTH_TIMEOUT_KEY);
  const v = Number(raw);
  return (!isNaN(v) && v > 0) ? v : AUTH_DEFAULT_TIMEOUT;
}

/* ============================================================================
 * Funções top-level expostas para o cliente.
 * ========================================================================== */

function getAuthStatus() {
  const email = _authCurrentEmail_();
  const users = _authGetUsers_();
  return {
    email: email,
    setup_needed: users.length === 0,
    is_authorized: users.some(u => u.email === email),
    timeout_minutes: _authGetTimeout_(),
    total_users: users.length
  };
}

function setupFirstUser(password) {
  if (!password || String(password).length < 4) {
    return { ok: false, error: 'Senha deve ter pelo menos 4 caracteres.' };
  }
  const users = _authGetUsers_();
  if (users.length > 0) {
    return { ok: false, error: 'Sistema já tem usuários cadastrados.' };
  }
  const email = _authCurrentEmail_();
  const salt = _authGenSalt_();
  users.push({
    email: email,
    hash: _authHash_(password, salt),
    salt: salt,
    created_at: new Date().toISOString()
  });
  _authSetUsers_(users);
  return { ok: true, email: email };
}

function login(password) {
  const email = _authCurrentEmail_();
  const users = _authGetUsers_();
  const user = users.find(u => u.email === email);
  if (!user) return { ok: false, error: 'Email não autorizado: ' + email };
  if (_authHash_(password, user.salt) !== user.hash) {
    return { ok: false, error: 'Senha incorreta.' };
  }
  return { ok: true, email: email };
}

function changeMyPassword(oldPassword, newPassword) {
  if (!newPassword || String(newPassword).length < 4) {
    return { ok: false, error: 'Nova senha deve ter pelo menos 4 caracteres.' };
  }
  const email = _authCurrentEmail_();
  const users = _authGetUsers_();
  const idx = users.findIndex(u => u.email === email);
  if (idx === -1) return { ok: false, error: 'Usuário não autorizado.' };
  if (_authHash_(oldPassword, users[idx].salt) !== users[idx].hash) {
    return { ok: false, error: 'Senha atual incorreta.' };
  }
  const newSalt = _authGenSalt_();
  users[idx].salt = newSalt;
  users[idx].hash = _authHash_(newPassword, newSalt);
  _authSetUsers_(users);
  return { ok: true };
}

function listAuthUsers() {
  return _authGetUsers_().map(u => ({
    email: u.email,
    created_at: u.created_at || ''
  }));
}

function addAuthUser(email, password) {
  email = String(email || '').trim().toLowerCase();
  if (!email || email.indexOf('@') === -1) {
    return { ok: false, error: 'Email inválido.' };
  }
  if (!password || String(password).length < 4) {
    return { ok: false, error: 'Senha deve ter pelo menos 4 caracteres.' };
  }
  const callerEmail = _authCurrentEmail_();
  const users = _authGetUsers_();
  if (users.length > 0 && !users.some(u => u.email === callerEmail)) {
    return { ok: false, error: 'Apenas usuários autorizados podem adicionar outros.' };
  }
  if (users.some(u => u.email === email)) {
    return { ok: false, error: 'Email já cadastrado.' };
  }
  const salt = _authGenSalt_();
  users.push({
    email: email,
    hash: _authHash_(password, salt),
    salt: salt,
    created_at: new Date().toISOString(),
    added_by: callerEmail
  });
  _authSetUsers_(users);
  return { ok: true, email: email };
}

function removeAuthUser(email) {
  email = String(email || '').trim().toLowerCase();
  const callerEmail = _authCurrentEmail_();
  const users = _authGetUsers_();
  if (!users.some(u => u.email === callerEmail)) {
    return { ok: false, error: 'Apenas usuários autorizados podem remover outros.' };
  }
  const filtered = users.filter(u => u.email !== email);
  if (filtered.length === users.length) {
    return { ok: false, error: 'Email não encontrado.' };
  }
  if (filtered.length === 0) {
    return { ok: false, error: 'Não é possível remover o último usuário.' };
  }
  _authSetUsers_(filtered);
  return { ok: true };
}

function setAuthTimeout(minutes) {
  const m = Math.max(1, Math.min(240, Math.floor(Number(minutes)) || AUTH_DEFAULT_TIMEOUT));
  PropertiesService.getScriptProperties().setProperty(AUTH_TIMEOUT_KEY, String(m));
  return { ok: true, timeout_minutes: m };
}
