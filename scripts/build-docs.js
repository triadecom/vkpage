// Собирает статическую часть сайта в docs/ (данные и аватарки уже там).
// К ссылкам на css/js добавляется ?v=… — чтобы браузеры не залипали на старом коде.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DOCS_DIR = path.join(ROOT, 'docs');

function buildDocs() {
  const v = Date.now().toString(36);
  fs.mkdirSync(path.join(DOCS_DIR, 'admin'), { recursive: true });

  fs.copyFileSync(path.join(PUBLIC_DIR, 'styles.css'), path.join(DOCS_DIR, 'styles.css'));
  fs.copyFileSync(path.join(PUBLIC_DIR, 'app.js'), path.join(DOCS_DIR, 'app.js'));

  const index = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    .replace('href="styles.css"', `href="styles.css?v=${v}"`)
    .replace('src="app.js"', `src="app.js?v=${v}"`);
  fs.writeFileSync(path.join(DOCS_DIR, 'index.html'), index);

  // админка публикуется тоже — в облаке она работает через GitHub API
  const admin = fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html'), 'utf8')
    .replace('href="/styles.css"', `href="../styles.css?v=${v}"`)
    .replace('src="/admin.js"', `src="admin.js?v=${v}"`);
  fs.writeFileSync(path.join(DOCS_DIR, 'admin', 'index.html'), admin);
  fs.copyFileSync(path.join(PUBLIC_DIR, 'admin.js'), path.join(DOCS_DIR, 'admin', 'admin.js'));

  fs.writeFileSync(path.join(DOCS_DIR, '.nojekyll'), '');
}

module.exports = { buildDocs };

if (require.main === module) {
  buildDocs();
  console.log('docs собран');
}
