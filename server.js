const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data.json');
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
};

const sessions = new Set();

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    const config = { adminPassword: 'admin', pollMinutes: 360 };
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

const AVATARS_DIR = path.join(PUBLIC_DIR, 'avatars');
const PAGE_HOSTS = new Set(['vk.com', 'www.vk.com', 'm.vk.com']);
// ВК отдаёт og:image только краулерам соцсетей — обычному браузерному UA приходит JS-оболочка без мета-тегов
const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

function parseCount(raw) {
  const s = String(raw).trim().replace(/[\s ]/g, '').replace(',', '.');
  const m = s.match(/^([\d.]+)([KК]|[MМ])?$/i);
  if (!m) return 0;
  let n = parseFloat(m[1]);
  if (m[2] && /[KК]/i.test(m[2])) n *= 1e3;
  if (m[2] && /[MМ]/i.test(m[2])) n *= 1e6;
  return Math.round(n) || 0;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function fetchVkInfo(rawUrl) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : 'https://' + rawUrl);
  } catch {
    throw new Error('Некорректная ссылка');
  }
  if (!PAGE_HOSTS.has(url.hostname)) throw new Error('Поддерживаются только ссылки на vk.com');

  // ВК отвечает нестабильно: часть ответов приходит без og-тегов, поэтому пробуем до 3 раз
  let name = '';
  let imageUrl = '';
  let subscribers = 0;
  let reach = 0;
  for (let attempt = 0; attempt < 4 && !(name && imageUrl && subscribers && reach); attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 600));

    const pageRes = await fetch(url, {
      headers: { 'User-Agent': CRAWLER_UA, 'Accept-Language': 'ru' },
      signal: AbortSignal.timeout(12000),
    });
    if (!pageRes.ok) throw new Error('ВК ответил с кодом ' + pageRes.status);

    // ВК отдаёт страницы в windows-1251 — декодируем по заявленной кодировке
    const pageBuffer = Buffer.from(await pageRes.arrayBuffer());
    const contentType = pageRes.headers.get('content-type') || '';
    const charset = (contentType.match(/charset=([\w-]+)/i)
      || pageBuffer.slice(0, 4096).toString('latin1').match(/charset=([\w-]+)/i)
      || [])[1] || 'utf-8';
    let html;
    try {
      html = new TextDecoder(charset).decode(pageBuffer);
    } catch {
      html = pageBuffer.toString('utf8');
    }

    const og = (prop) => {
      const m = html.match(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']*)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:${prop}["']`, 'i'));
      return m ? decodeEntities(m[1]) : '';
    };

    name = name || og('title');
    // в ссылке на аватарку запрашиваем максимальный размер вместо дефолтных 240x240
    imageUrl = imageUrl || og('image').replace(/cs=\d+x\d+/, 'cs=720x720');

    if (!subscribers) {
      const ldMatch = html.match(/"userInteractionCount":\s*(\d+)/);
      if (ldMatch) {
        subscribers = Number(ldMatch[1]);
      } else {
        const textMatch = html.match(/(\d[\d\s .,]*)\s*подписчик/);
        if (textMatch) subscribers = Number(textMatch[1].replace(/\D/g, '')) || 0;
      }
    }

    // охват оцениваем по медиане счётчиков просмотров постов на стене
    if (!reach) {
      const views = [...html.matchAll(/title="([^"]{1,20}?)\s*просмотр/g)]
        .map((m) => parseCount(m[1]))
        .filter((n) => n > 0);
      if (views.length >= 3) {
        views.sort((a, b) => a - b);
        reach = views[Math.floor(views.length / 2)];
      }
    }
  }

  let avatar = '';
  if (imageUrl) {
    const imageRes = await fetch(imageUrl, { signal: AbortSignal.timeout(12000) });
    if (imageRes.ok) {
      const buffer = Buffer.from(await imageRes.arrayBuffer());
      if (buffer.length <= 5 * 1024 * 1024) {
        const type = (imageRes.headers.get('content-type') || '').split(';')[0];
        const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[type] || '.jpg';
        fs.mkdirSync(AVATARS_DIR, { recursive: true });
        const fileName = crypto.createHash('sha1').update(url.href).digest('hex').slice(0, 16) + ext;
        fs.writeFileSync(path.join(AVATARS_DIR, fileName), buffer);
        avatar = '/avatars/' + fileName;
      }
    }
  }

  if (!name && !avatar) throw new Error('Не удалось получить данные — проверьте ссылку на сообщество');
  return { name, avatar, subscribers, reach };
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: __dirname }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').trim()));
      else resolve(stdout);
    });
  });
}

// Собирает статическую версию страницы в docs/ — её раздаёт GitHub Pages
function buildDocs() {
  const docs = path.join(__dirname, 'docs');
  fs.rmSync(docs, { recursive: true, force: true });
  fs.mkdirSync(docs, { recursive: true });
  for (const f of ['index.html', 'styles.css', 'app.js']) {
    fs.copyFileSync(path.join(PUBLIC_DIR, f), path.join(docs, f));
  }
  if (fs.existsSync(AVATARS_DIR)) {
    fs.cpSync(AVATARS_DIR, path.join(docs, 'avatars'), { recursive: true });
  }
  fs.copyFileSync(DATA_FILE, path.join(docs, 'data.json'));
  fs.writeFileSync(path.join(docs, '.nojekyll'), '');
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
      return sendJson(res, 200, await fetchVkInfo(target));
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
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'Запрещено' });
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendJson(res, 404, { error: 'Не найдено' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
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
      updates.set(pub.id, await fetchVkInfo(pub.url));
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
      if (info.reach && info.reach !== pub.reach) { pub.reach = info.reach; changed = true; }
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
