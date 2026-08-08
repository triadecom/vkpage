const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchVkInfo } = require('./lib/vkinfo');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
// docs/ в репозитории — «заводские» данные: с них наполняется пустой том при первом запуске
const SEED_DIR = path.join(__dirname, 'docs');
// боевые данные живут в томе (DATA_DIR), поэтому переезжают между деплоями
const DATA_DIR = path.resolve(process.env.DATA_DIR || SEED_DIR);
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
const SECRET_FILE = path.join(DATA_DIR, '.session-secret');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// автообновление из ВК: раньше этим занимался GitHub Actions, теперь сам сервер
const REFRESH_MINUTES = Number(process.env.REFRESH_MINUTES ?? 360);
const SESSION_DAYS = 30;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
};

/* ---------- Данные ---------- */

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return { adminPassword: 'admin' };
  }
}

function adminPassword() {
  return process.env.ADMIN_PASSWORD || loadConfig().adminPassword || 'admin';
}

// Первый запуск на чистом томе: переносим прайс и аватарки из репозитория.
function seedData() {
  if (DATA_DIR === SEED_DIR) return;
  fs.mkdirSync(AVATARS_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE) && fs.existsSync(path.join(SEED_DIR, 'data.json'))) {
    fs.copyFileSync(path.join(SEED_DIR, 'data.json'), DATA_FILE);
    console.log('данные взяты из репозитория (первый запуск)');
  }
  const seedAvatars = path.join(SEED_DIR, 'avatars');
  if (!fs.existsSync(seedAvatars)) return;
  for (const file of fs.readdirSync(seedAvatars)) {
    const target = path.join(AVATARS_DIR, file);
    if (!fs.existsSync(target)) fs.copyFileSync(path.join(seedAvatars, file), target);
  }
}

function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, DATA_FILE);
}

/* ---------- Сессии ---------- */

// Токен подписан секретом с диска и хешем пароля: переживает перезапуск контейнера,
// но перестаёт действовать, как только меняется пароль.
function sessionSecret() {
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE, secret + '\n', { mode: 0o600 });
    return secret;
  }
}

const SECRET = (() => {
  try {
    return sessionSecret();
  } catch {
    // том недоступен на запись — работаем с секретом в памяти
    return crypto.randomBytes(32).toString('hex');
  }
})();

function sign(payload) {
  const pwdHash = crypto.createHash('sha256').update(adminPassword()).digest('hex');
  return crypto.createHmac('sha256', SECRET).update(payload + ':' + pwdHash).digest('hex');
}

function issueToken() {
  const exp = String(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  return exp + '.' + sign(exp);
}

function isAuthed(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const [exp, sig] = token.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = Buffer.from(sign(exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// Простая защита от перебора пароля: админка открыта всему интернету.
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const LOCK_MS = 15 * 60 * 1000;

function clientIp(req) {
  const forwarded = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function loginBlocked(ip) {
  const record = attempts.get(ip);
  if (!record) return false;
  if (Date.now() > record.until) {
    attempts.delete(ip);
    return false;
  }
  return record.fails >= MAX_ATTEMPTS;
}

function noteFailedLogin(ip) {
  const record = attempts.get(ip) || { fails: 0, until: 0 };
  record.fails += 1;
  record.until = Date.now() + LOCK_MS;
  attempts.set(ip, record);
}

function passwordMatches(given) {
  const expected = Buffer.from(adminPassword());
  const actual = Buffer.from(String(given));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/* ---------- HTTP-мелочи ---------- */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req)) || 'null');
  } catch {
    return undefined;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function sendData(res) {
  res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  fs.createReadStream(DATA_FILE).pipe(res);
}

/* ---------- API ---------- */

// Обновление всех сообществ из ВК: подписчики, охваты, аватарки.
// Название и вручную выставленный охват не трогаем — это правки админа.
async function refreshAll() {
  const snapshot = readData();
  const updates = new Map();
  let failed = 0;

  for (const pub of snapshot.publics) {
    if (!pub.url) continue;
    try {
      updates.set(pub.id, await fetchVkInfo(pub.url, AVATARS_DIR));
    } catch {
      failed += 1;
    }
  }

  // перечитываем файл: пока ходили в ВК, админка могла что-то сохранить
  const data = readData();
  let updated = 0;
  for (const pub of data.publics) {
    const info = updates.get(pub.id);
    if (!info) continue;
    let changed = false;
    if (!pub.name && info.name) { pub.name = info.name; changed = true; }
    if (info.subscribers && info.subscribers !== pub.subscribers) { pub.subscribers = info.subscribers; changed = true; }
    if (info.reach && !pub.reachManual && info.reach !== pub.reach) { pub.reach = info.reach; changed = true; }
    if (info.avatar && info.avatar !== pub.avatar) { pub.avatar = info.avatar; changed = true; }
    if (changed) updated += 1;
  }
  if (updated) {
    data.settings.updatedAt = new Date().toISOString().slice(0, 10);
    saveData(data);
  }
  return { updated, failed, checked: updates.size + failed };
}

// Обход всех сообществ занимает минуту и больше, поэтому крутится в фоне,
// а админка спрашивает статус — так запрос не упирается в таймауты прокси.
let refreshState = { running: false, startedAt: 0, finishedAt: 0, updated: 0, failed: 0, checked: 0, error: '' };

function startRefresh() {
  if (refreshState.running) return refreshState;
  refreshState = { running: true, startedAt: Date.now(), finishedAt: 0, updated: 0, failed: 0, checked: 0, error: '' };
  refreshAll()
    .then((result) => {
      refreshState = { ...refreshState, ...result, running: false, finishedAt: Date.now() };
      console.log(`[ВК] обновлено ${result.updated}, не ответили ${result.failed}`);
    })
    .catch((err) => {
      refreshState = { ...refreshState, running: false, finishedAt: Date.now(), error: String(err.message).slice(0, 200) };
      console.log('[ВК] обновление не удалось: ' + err.message);
    });
  return refreshState;
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/data') {
    return sendData(res);
  }

  if (req.method === 'POST' && pathname === '/api/login') {
    const ip = clientIp(req);
    if (loginBlocked(ip)) {
      return sendJson(res, 429, { error: 'Слишком много попыток — подождите 15 минут' });
    }
    const body = await readJson(req);
    if (!body || typeof body.password !== 'string') {
      return sendJson(res, 400, { error: 'Нужен пароль' });
    }
    if (passwordMatches(body.password)) {
      attempts.delete(ip);
      return sendJson(res, 200, { token: issueToken() });
    }
    noteFailedLogin(ip);
    return sendJson(res, 401, { error: 'Неверный пароль' });
  }

  if (!isAuthed(req)) return sendJson(res, 401, { error: 'Нужна авторизация' });

  if (req.method === 'GET' && pathname === '/api/vkinfo') {
    const target = new URL(req.url, 'http://localhost').searchParams.get('url') || '';
    try {
      return sendJson(res, 200, await fetchVkInfo(target, AVATARS_DIR));
    } catch (err) {
      return sendJson(res, 502, { error: err.message || 'Не получилось получить данные' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/refresh') {
    return sendJson(res, 200, startRefresh());
  }

  if (req.method === 'GET' && pathname === '/api/refresh-status') {
    return sendJson(res, 200, refreshState);
  }

  if (req.method === 'PUT' && pathname === '/api/data') {
    const data = await readJson(req);
    if (!data || typeof data.settings !== 'object' || !Array.isArray(data.publics)) {
      return sendJson(res, 400, { error: 'Некорректные данные' });
    }
    data.settings.updatedAt = new Date().toISOString().slice(0, 10);
    saveData(data);
    return sendJson(res, 200, { ok: true, updatedAt: data.settings.updatedAt });
  }

  sendJson(res, 404, { error: 'Не найдено' });
}

/* ---------- Статика ---------- */

// Сначала код сайта (public/), затем данные и аватарки из тома, затем docs/ —
// там лежат файлы вроде оферты, которые в томе не появляются.
const STATIC_ROOTS = DATA_DIR === SEED_DIR ? [PUBLIC_DIR, SEED_DIR] : [PUBLIC_DIR, DATA_DIR, SEED_DIR];

function serveStatic(res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin' || pathname === '/admin/') pathname = '/admin.html';
  if (pathname === '/data.json') return sendData(res);

  const tryRoot = (index) => {
    if (index >= STATIC_ROOTS.length) return sendJson(res, 404, { error: 'Не найдено' });
    const root = STATIC_ROOTS[index];
    const filePath = path.normalize(path.join(root, pathname));
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      return sendJson(res, 403, { error: 'Запрещено' });
    }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) return tryRoot(index + 1);
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        // страницу и код держим свежими, картинки и файлы можно кешировать
        'Cache-Control': ['.html', '.js', '.css'].includes(ext) ? 'no-cache' : 'public, max-age=86400',
      });
      fs.createReadStream(filePath).pipe(res);
    });
  };
  tryRoot(0);
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
    else serveStatic(res, pathname);
  } catch {
    if (!res.headersSent) sendJson(res, 500, { error: 'Ошибка сервера' });
    else res.end();
  }
});

/* ---------- Старт ---------- */

seedData();

server.listen(PORT, () => {
  console.log(`Прайс-страница:  http://localhost:${PORT}`);
  console.log(`Админка:         http://localhost:${PORT}/admin`);
  console.log(`Данные:          ${DATA_FILE}`);
  if (process.env.ADMIN_PASSWORD) console.log('Пароль админки:  из переменной ADMIN_PASSWORD');
  else console.log('Пароль админки:  из config.json');

  if (REFRESH_MINUTES > 0) {
    console.log(`Обновление из ВК: каждые ${REFRESH_MINUTES} мин (REFRESH_MINUTES=0 — выключить)`);
    setTimeout(startRefresh, 60 * 1000);
    setInterval(startRefresh, REFRESH_MINUTES * 60 * 1000);
  }
});
