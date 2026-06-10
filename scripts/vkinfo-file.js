// Запускается в GitHub Actions по запросу из облачной админки:
// получает данные одного сообщества и кладёт их в docs/vkinfo/<hash>.json,
// откуда их забирает редактор в браузере.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchVkInfo } = require('../lib/vkinfo');

const url = (process.argv[2] || '').trim();
if (!url) {
  console.error('нужна ссылка на сообщество');
  process.exit(1);
}

const DOCS_DIR = path.join(__dirname, '..', 'docs');

(async () => {
  const info = await fetchVkInfo(url, path.join(DOCS_DIR, 'avatars'));
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  const dir = path.join(DOCS_DIR, 'vkinfo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, hash + '.json'),
    JSON.stringify({ ...info, url, fetchedAt: new Date().toISOString() }, null, 2) + '\n'
  );
  console.log(`ok: ${url} → vkinfo/${hash}.json (${info.name}, ${info.subscribers} подписчиков)`);
})().catch((err) => {
  console.error('fail:', err.message);
  process.exit(1);
});
