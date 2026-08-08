// Получение данных сообщества ВК без токенов: название, аватарка, подписчики, охват.
// Используется сервером: и в редакторе сообщества, и при обновлении по расписанию.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PAGE_HOSTS = new Set(['vk.com', 'www.vk.com', 'm.vk.com']);
// ВК отдаёт og-теги только краулерам соцсетей — обычному браузерному UA приходит JS-оболочка без мета-тегов
const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

function parseCount(raw) {
  const s = String(raw).trim().replace(/[\s ]/g, '').replace(',', '.');
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

async function fetchVkInfo(rawUrl, avatarsDir) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : 'https://' + rawUrl);
  } catch {
    throw new Error('Некорректная ссылка');
  }
  if (!PAGE_HOSTS.has(url.hostname)) throw new Error('Поддерживаются только ссылки на vk.com');

  // ВК отвечает нестабильно: часть ответов приходит без og-тегов, поэтому пробуем несколько раз
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
        fs.mkdirSync(avatarsDir, { recursive: true });
        const fileName = crypto.createHash('sha1').update(url.href).digest('hex').slice(0, 16) + ext;
        fs.writeFileSync(path.join(avatarsDir, fileName), buffer);
        avatar = '/avatars/' + fileName;
      }
    }
  }

  if (!name && !avatar) throw new Error('Не удалось получить данные — проверьте ссылку на сообщество');
  return { name, avatar, subscribers, reach };
}

module.exports = { fetchVkInfo };
