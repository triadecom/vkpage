// Запускается в GitHub Actions (и вручную): обновляет подписчиков, охваты
// и аватарки в docs/data.json. Названия не трогает — кроме пустых.
const fs = require('fs');
const path = require('path');
const { fetchVkInfo } = require('../lib/vkinfo');

const DOCS_DIR = path.join(__dirname, '..', 'docs');
const DATA_FILE = path.join(DOCS_DIR, 'data.json');
const AVATARS_DIR = path.join(DOCS_DIR, 'avatars');

(async () => {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  let changed = false;

  for (const pub of data.publics) {
    if (!pub.url) continue;
    try {
      const info = await fetchVkInfo(pub.url, AVATARS_DIR);
      if (!pub.name && info.name) { pub.name = info.name; changed = true; }
      if (info.subscribers && info.subscribers !== pub.subscribers) { pub.subscribers = info.subscribers; changed = true; }
      if (info.reach && info.reach !== pub.reach) { pub.reach = info.reach; changed = true; }
      if (info.avatar && info.avatar !== pub.avatar) { pub.avatar = info.avatar; changed = true; }
      console.log(`ok: ${pub.url} — подписчики ${info.subscribers}, охват ${info.reach}`);
    } catch (err) {
      console.log(`skip: ${pub.url} — ${err.message}`);
    }
  }

  if (changed) {
    data.settings.updatedAt = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2) + '\n');
    console.log('docs/data.json обновлён');
  } else {
    console.log('изменений нет');
  }
})();
