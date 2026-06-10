const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { fetchVkInfo } = require('./lib/vkinfo');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DOCS_DIR = path.join(__dirname, 'docs');
// канонические данные и аватарки живут в docs/ — эту же папку раздаёт GitHub Pages
const DATA_FILE = path.join(DOCS_DIR, 'data.json');
const AVATARS_DIR = path.join(DOCS_DIR, 'avatars');
const CONFIG_FILE = path.join(__dirname, 'config.json');

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

const sessions = new Set();

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    // поллинг по умолчанию выключен — данные круглосуточно обновляет GitHub Actions
    const config = { adminPassword: 'admin', pollMinutes: 0 };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
    return config;
  }
}

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
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function isAuthed(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return token !== '' && sessions.has(token);
}

function saveData(data) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, DATA_FILE);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: __dirname }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').trim()));
      else resolve(stdout);
    });
  });
}

// Собирает статическую часть сайта в docs/ (данные и аватарки уже там).
// Админка публикуется тоже — в облаке она работает через GitHub API.
function buildDocs() {
  fs.mkdirSync(path.join(DOCS_DIR, 'admin'), { recursive: true });
  for (const f of ['index.html', 'styles.css', 'app.js']) {
    fs.copyFileSync(path.join(PUBLIC_DIR, f), path.join(DOCS_DIR, f));
  }
  const adminHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html'), 'utf8')
    .replace('href="/styles.css"', 'href="../styles.css"')
    .replace('src="/admin.js"', 'src="admin.js"');
  fs.writeFileSync(path.join(DOCS_DIR, 'admin', 'index.html'), adminHtml);
  fs.copyFileSync(path.join(PUBLIC_DIR, 'admin.js'), path.join(DOCS_DIR, 'admin', 'admin.js'));
  fs.writeFileSync(path.join(DOCS_DIR, '.nojekyll'), '');
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/data') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    fs.createReadStream(DATA_FILE).pipe(res);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/login') {
    const body = await readJson(req);
    if (!body || typeof body.password !== 'string') {
      return sendJson(res, 400, { error: 'Нужен пароль' });
    }
    if (body.password === loadConfig().adminPassword) {
      const token = crypto.randomBytes(24).toString('hex');
      sessions.add(token);
      return sendJson(res, 200, { token });
    }
    return sendJson(res, 401, { error: 'Неверный пароль' });
  }

  if (req.method === 'GET' && pathname === '/api/vkinfo') {
    if (!isAuthed(req)) return sendJson(res, 401, { error: 'Нужна авторизация' });
    const target = new URL(req.url, 'http://localhost').searchParams.get('url') || '';
    try {
      return sendJson(res, 200, await fetchVkInfo(target, AVATARS_DIR));
    } catch (err) {
      return sendJson(res, 502, { error: err.message || 'Не получилось получить данные' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/publish') {
    if (!isAuthed(req)) return sendJson(res, 401, { error: 'Нужна авторизация' });
    try {
      buildDocs();
      await run('git', ['add', '-A']);
      const status = await run('git', ['status', '--porcelain']);
      if (status.trim()) {
        await run('git', ['commit', '-m', 'Обновление прайса']);
      }
      // подтягиваем облачные правки (админка с Pages, автообновление из Actions)
      await run('git', ['pull', '--rebase']);
      await run('git', ['push']);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 500, { error: 'Публикация не удалась: ' + String(err.message).slice(0, 300) });
    }
  }

  if (req.method === 'PUT' && pathname === '/api/data') {
    if (!isAuthed(req)) return sendJson(res, 401, { error: 'Нужна авторизация' });
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

function serveStatic(res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin' || pathname === '/admin/') pathname = '/admin.html';
  // страница берёт данные с относительного пути data.json — как на GitHub Pages
  if (pathname === '/data.json') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    fs.createReadStream(DATA_FILE).pipe(res);
    return;
  }
  // аватарки и файлы вроде оферты канонически лежат в docs/ — ищем сначала в public/, потом там
  const tryServe = (root, fallback) => {
    const filePath = path.normalize(path.join(root, pathname));
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
      return sendJson(res, 403, { error: 'Запрещено' });
    }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        if (fallback) return tryServe(fallback, null);
        return sendJson(res, 404, { error: 'Не найдено' });
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });
  };
  tryServe(PUBLIC_DIR, DOCS_DIR);
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
    } else {
      serveStatic(res, pathname);
    }
  } catch {
    if (!res.headersSent) sendJson(res, 500, { error: 'Ошибка сервера' });
    else res.end();
  }
});

// Поллинг: периодически вытягиваем из ВК точные подписчики, охваты и аватарки.
// Название не трогаем — его могли поправить вручную в админке.
async function pollVkData() {
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return;
  }

  const updates = new Map();
  for (const pub of snapshot.publics) {
    if (!pub.url) continue;
    try {
      updates.set(pub.id, await fetchVkInfo(pub.url, AVATARS_DIR));
    } catch {
      // недоступное сообщество пропускаем, остальные обновятся
    }
  }
  if (!updates.size) return;

  // перечитываем файл перед записью, чтобы не затереть правки из админки, сделанные во время опроса
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    let changed = false;
    for (const pub of data.publics) {
      const info = updates.get(pub.id);
      if (!info) continue;
      if (info.subscribers && info.subscribers !== pub.subscribers) { pub.subscribers = info.subscribers; changed = true; }
      // охват, выставленный вручную в админке, не трогаем
      if (info.reach && !pub.reachManual && info.reach !== pub.reach) { pub.reach = info.reach; changed = true; }
      if (info.avatar && info.avatar !== pub.avatar) { pub.avatar = info.avatar; changed = true; }
    }
    if (changed) {
      data.settings.updatedAt = new Date().toISOString().slice(0, 10);
      saveData(data);
      console.log(`[поллинг ВК] данные обновлены в ${new Date().toLocaleTimeString('ru-RU')}`);
    }
  } catch {
    // не удалось сохранить — попробуем в следующий цикл
  }
}

const pollMinutes = Number(loadConfig().pollMinutes ?? 360);

server.listen(PORT, () => {
  console.log(`Прайс-страница:  http://localhost:${PORT}`);
  console.log(`Админка:         http://localhost:${PORT}/admin  (пароль — в config.json)`);
  if (pollMinutes > 0) {
    console.log(`Поллинг ВК:      каждые ${pollMinutes} мин (pollMinutes в config.json, 0 — выключить)`);
    setTimeout(pollVkData, 15 * 1000);
    setInterval(pollVkData, pollMinutes * 60 * 1000);
  }
});
