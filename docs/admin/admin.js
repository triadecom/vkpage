const $ = (sel) => document.querySelector(sel);

// Режимы: локально (node server.js, вход по паролю) или с GitHub Pages —
// тогда сохранение и обновление идут напрямую через GitHub API по токену.
const REMOTE = location.hostname.endsWith('.github.io');
const GH_REPO = REMOTE
  ? location.hostname.split('.')[0] + '/' + location.pathname.split('/').filter(Boolean)[0]
  : '';
const GH_API = 'https://api.github.com/repos/' + GH_REPO;
const TOKEN_KEY = REMOTE ? 'vkpage_gh_token' : 'vkpage_token';
const storage = REMOTE ? localStorage : sessionStorage;

let data = null;
let token = storage.getItem(TOKEN_KEY) || '';
let dirty = false;
let editIndex = null; // null = новое сообщество
let editorAvatar = '';
let lastFetchedUrl = '';
let autoFetchTimer = null;
let toastTimer = null;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmt(n) {
  return Number(n || 0).toLocaleString('ru-RU');
}

function plural(n, forms) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

// аватарки лежат рядом со страницей: /avatars локально, ../avatars относительно админки
function avatarSrc(avatar) {
  return '../' + String(avatar).replace(/^\//, '');
}

function ghHeaders() {
  return {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
}

function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

function markDirty() {
  dirty = true;
  $('#save').disabled = false;
}

function markSaved() {
  dirty = false;
  $('#save').disabled = true;
}

function dropAuth(message) {
  storage.removeItem(TOKEN_KEY);
  token = '';
  $('#modal-backdrop').hidden = true;
  showLogin();
  toast(message);
}

/* ---------- Вход ---------- */

function showLogin() {
  $('#login').hidden = false;
  $('#app').hidden = true;
  if (REMOTE) {
    $('#login-hint').textContent = 'Нужен GitHub-токен с правом записи в ' + GH_REPO + '. На компьютере админа его выдаёт команда: gh auth token';
    $('#password-label').textContent = 'GitHub-токен';
  }
  $('#password').focus();
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#publish').hidden = REMOTE; // в облаке сохранение само публикует
  renderSettings();
  renderPublics();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = $('#password').value.trim();

  if (REMOTE) {
    const res = await fetch(GH_API, {
      headers: { 'Authorization': 'Bearer ' + value, 'Accept': 'application/vnd.github+json' },
    });
    const repo = res.ok ? await res.json() : null;
    if (repo && repo.permissions && repo.permissions.push) {
      token = value;
      storage.setItem(TOKEN_KEY, token);
      $('#login-error').textContent = '';
      $('#password').value = '';
      showApp();
    } else {
      $('#login-error').textContent = 'Токен не подошёл — нужны права записи в ' + GH_REPO;
    }
    return;
  }

  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: $('#password').value }),
  });
  if (res.ok) {
    token = (await res.json()).token;
    storage.setItem(TOKEN_KEY, token);
    $('#login-error').textContent = '';
    $('#password').value = '';
    showApp();
  } else {
    $('#login-error').textContent = 'Неверный пароль';
  }
});

$('#logout').addEventListener('click', () => {
  if (dirty && !confirm('Есть несохранённые изменения. Выйти без сохранения?')) return;
  storage.removeItem(TOKEN_KEY);
  token = '';
  markSaved();
  showLogin();
});

/* ---------- Настройки ---------- */

const settingsFields = [
  ['s-title', 'title'],
  ['s-subtitle', 'subtitle'],
  ['s-contactVk', 'contactVk'],
  ['s-contactTg', 'contactTg'],
  ['s-message', 'messageTemplate'],
];

function renderSettings() {
  const s = data.settings;
  for (const [id, key] of settingsFields) {
    document.getElementById(id).value = s[key] || '';
  }
  $('#s-conditions').value = (s.conditions || []).join('\n');
  $('#s-sort').value = s.sort === 'subscribers' ? 'subscribers' : 'manual';
}

$('#s-sort').addEventListener('change', (e) => {
  data.settings.sort = e.target.value;
  markDirty();
  renderPublics();
});

for (const [id, key] of settingsFields) {
  document.getElementById(id).addEventListener('input', (e) => {
    data.settings[key] = e.target.value.trim();
    markDirty();
  });
}

$('#s-conditions').addEventListener('input', (e) => {
  data.settings.conditions = e.target.value.split('\n').map((l) => l.trim()).filter(Boolean);
  markDirty();
});

/* ---------- Список сообществ ---------- */

function renderPublics() {
  const list = $('#publics-list');
  if (!data.publics.length) {
    list.innerHTML = '<div class="empty">Пока пусто — добавьте первое сообщество.</div>';
    return;
  }
  const manualOrder = data.settings.sort !== 'subscribers';
  list.innerHTML = data.publics.map((pub, i) => {
    const formats = (pub.prices || []).length;
    const title = pub.name || pub.url || 'Без названия';
    const initial = String(title).trim().charAt(0).toUpperCase() || '?';
    const avatar = pub.avatar
      ? `<img class="avatar avatar-sm" src="${esc(avatarSrc(pub.avatar))}" alt="">`
      : `<span class="avatar avatar-placeholder avatar-sm">${esc(initial)}</span>`;
    const arrows = manualOrder ? `
      <button type="button" class="icon-btn" data-action="up" title="Выше" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="icon-btn" data-action="down" title="Ниже" ${i === data.publics.length - 1 ? 'disabled' : ''}>↓</button>` : '';
    return `
    <div class="pub-row" data-index="${i}">
      ${avatar}
      <div class="pub-row-info">
        <div class="pub-row-name">${esc(title)}</div>
        <div class="pub-row-meta">${fmt(pub.subscribers)} подписчиков · ${formats} ${plural(formats, ['формат', 'формата', 'форматов'])}</div>
      </div>
      ${arrows}
      <button type="button" class="btn btn-ghost btn-small" data-action="edit">Изменить</button>
      <button type="button" class="icon-btn danger" data-action="delete" title="Удалить">✕</button>
    </div>`;
  }).join('');
}

$('#publics-list').addEventListener('click', (e) => {
  const button = e.target.closest('[data-action]');
  if (!button) return;
  const index = Number(button.closest('.pub-row').dataset.index);
  const action = button.dataset.action;

  if (action === 'edit') openEditor(index);
  if (action === 'delete') {
    if (!confirm(`Удалить «${data.publics[index].name || data.publics[index].url}»?`)) return;
    data.publics.splice(index, 1);
    markDirty();
    renderPublics();
  }
  if (action === 'up' || action === 'down') {
    const target = action === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= data.publics.length) return;
    [data.publics[index], data.publics[target]] = [data.publics[target], data.publics[index]];
    markDirty();
    renderPublics();
  }
});

$('#add-public').addEventListener('click', () => openEditor(null));

/* ---------- Обновить всё из ВК ---------- */

$('#refresh-all').addEventListener('click', async () => {
  const button = $('#refresh-all');

  if (REMOTE) {
    // в облаке обновлением занимается GitHub Actions
    button.disabled = true;
    try {
      const res = await fetch(GH_API + '/actions/workflows/refresh.yml/dispatches', {
        method: 'POST',
        headers: ghHeaders(),
        body: JSON.stringify({ ref: 'main' }),
      });
      if (res.status === 401 || res.status === 403) return dropAuth('Токен не подошёл — войдите заново');
      if (res.status === 204) toast('Обновление запущено в облаке — через 2–3 минуты перезагрузите админку');
      else toast('Не получилось запустить обновление');
    } finally {
      button.disabled = false;
    }
    return;
  }

  const targets = data.publics.filter((p) => p.url);
  if (!targets.length) {
    toast('У сообществ не указаны ссылки на ВК');
    return;
  }
  button.disabled = true;
  let done = 0;
  let failed = 0;
  for (const pub of targets) {
    button.textContent = `Обновляю ${done + failed + 1}/${targets.length}…`;
    try {
      const res = await fetch('/api/vkinfo?url=' + encodeURIComponent(pub.url), {
        headers: { 'Authorization': 'Bearer ' + token },
      });
      if (res.status === 401) {
        dropAuth('Сессия истекла — войдите заново');
        break;
      }
      const info = await res.json();
      if (!res.ok) throw new Error();
      if (info.name) pub.name = info.name;
      if (info.avatar) pub.avatar = info.avatar;
      if (info.subscribers) pub.subscribers = info.subscribers;
      if (info.reach) pub.reach = info.reach;
      done++;
    } catch {
      failed++;
    }
  }
  button.disabled = false;
  button.textContent = '⟳ Обновить всё из ВК';
  if (done) markDirty();
  renderPublics();
  toast(failed
    ? `Обновлено: ${done}, не получилось: ${failed}`
    : `Обновлено: ${done} — не забудьте «Сохранить изменения»`);
});

/* ---------- Редактор сообщества ---------- */

const VK_HINT = REMOTE
  ? 'вставьте ссылку — данные подтянутся облаком после «Обновить всё из ВК»'
  : 'вставьте ссылку на паблик — данные подтянутся сами';

function setVkStatus(text) {
  $('#vk-status').textContent = text;
}

function updateAvatarPreview() {
  const img = $('#e-avatar');
  const placeholder = $('#e-avatar-placeholder');
  if (editorAvatar) {
    img.src = avatarSrc(editorAvatar);
    img.hidden = false;
    placeholder.hidden = true;
  } else {
    img.hidden = true;
    placeholder.hidden = false;
    placeholder.textContent = ($('#e-name').value.trim().charAt(0) || '?').toUpperCase();
  }
}

function addPriceRow(format = '', price = '') {
  const row = document.createElement('div');
  row.className = 'price-edit-row';
  row.innerHTML = `
    <input type="text" placeholder="Пост 1/24" value="${esc(format)}">
    <input type="number" min="0" placeholder="Цена, ₽" value="${esc(price)}">
    <button type="button" class="icon-btn danger" title="Убрать">✕</button>`;
  row.querySelector('button').addEventListener('click', () => row.remove());
  $('#price-rows').appendChild(row);
}

function openEditor(index) {
  editIndex = index;
  const pub = index === null
    ? { name: '', url: '', category: '', subscribers: '', reach: '', note: '', prices: [], avatar: '' }
    : data.publics[index];

  editorAvatar = pub.avatar || '';
  lastFetchedUrl = pub.url || '';
  setVkStatus(VK_HINT);
  $('#editor-title').textContent = index === null ? 'Новое сообщество' : 'Редактирование';
  $('#e-name').value = pub.name || '';
  $('#e-url').value = pub.url || '';
  $('#e-category').value = pub.category || '';
  $('#e-subscribers').value = pub.subscribers || '';
  $('#e-reach').value = pub.reach || '';
  $('#e-note').value = pub.note || '';

  $('#price-rows').innerHTML = '';
  const prices = pub.prices && pub.prices.length ? pub.prices : [{ format: 'Пост 1/24', price: '' }];
  for (const p of prices) addPriceRow(p.format, p.price);

  updateAvatarPreview();
  $('#modal-backdrop').hidden = false;
  $('#e-name').focus();
}

function closeEditor() {
  $('#modal-backdrop').hidden = true;
  editIndex = null;
}

$('#e-name').addEventListener('input', () => {
  if (!editorAvatar) updateAvatarPreview();
});

async function fetchFromVk() {
  const url = $('#e-url').value.trim();
  if (!url || url === lastFetchedUrl) return;

  setVkStatus('Загружаю данные из ВК…');
  try {
    const res = await fetch('/api/vkinfo?url=' + encodeURIComponent(url), {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (res.status === 401) {
      dropAuth('Сессия истекла — войдите заново');
      return;
    }
    const info = await res.json();
    if (!res.ok) throw new Error(info.error || 'Не получилось получить данные');

    lastFetchedUrl = url;
    if (info.avatar) {
      editorAvatar = info.avatar;
      updateAvatarPreview();
    }
    if (info.name) {
      $('#e-name').value = info.name;
      updateAvatarPreview();
    }
    if (info.subscribers) {
      $('#e-subscribers').value = info.subscribers;
    }
    if (info.reach) {
      $('#e-reach').value = info.reach;
    }
    setVkStatus('Данные из ВК загружены ✓');
  } catch {
    setVkStatus('Не получилось загрузить — проверьте ссылку');
  }
}

// Автоподтягивание: вставил ссылку — данные приехали сами (только локально,
// из браузера к ВК ходить нельзя — CORS; в облаке это делает GitHub Actions)
$('#e-url').addEventListener('input', () => {
  if (REMOTE) return;
  clearTimeout(autoFetchTimer);
  const url = $('#e-url').value.trim();
  if (!/(^|\/\/)(www\.|m\.)?vk\.com\/[\w.\-]+/i.test(url)) return;
  autoFetchTimer = setTimeout(fetchFromVk, 700);
});

$('#add-price').addEventListener('click', () => addPriceRow());
$('#editor-cancel').addEventListener('click', closeEditor);

$('#editor').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#e-name').value.trim();
  const url = $('#e-url').value.trim();
  if (!name && !url) return;

  const prices = [...document.querySelectorAll('#price-rows .price-edit-row')]
    .map((row) => {
      const [formatInput, priceInput] = row.querySelectorAll('input');
      return { format: formatInput.value.trim(), price: Number(priceInput.value) || 0 };
    })
    .filter((p) => p.format);

  const pub = {
    id: editIndex === null ? 'p' + Date.now() : data.publics[editIndex].id,
    name,
    avatar: editorAvatar,
    url,
    category: $('#e-category').value.trim(),
    subscribers: Number($('#e-subscribers').value) || 0,
    reach: Number($('#e-reach').value) || 0,
    note: $('#e-note').value.trim(),
    prices,
  };

  if (editIndex === null) data.publics.push(pub);
  else data.publics[editIndex] = pub;

  markDirty();
  renderPublics();
  closeEditor();
});

/* ---------- Сохранение ---------- */

async function saveRemote() {
  data.settings.updatedAt = new Date().toISOString().slice(0, 10);
  const body = JSON.stringify(data, null, 2) + '\n';

  const getRes = await fetch(GH_API + '/contents/docs/data.json?ref=main&ts=' + Date.now(), {
    headers: ghHeaders(),
    cache: 'no-store',
  });
  if (getRes.status === 401 || getRes.status === 403) return 'auth';
  const sha = getRes.ok ? (await getRes.json()).sha : undefined;

  const putRes = await fetch(GH_API + '/contents/docs/data.json', {
    method: 'PUT',
    headers: ghHeaders(),
    body: JSON.stringify({
      message: 'Обновление прайса из админки',
      content: b64utf8(body),
      sha,
      branch: 'main',
    }),
  });
  if (putRes.status === 401 || putRes.status === 403) return 'auth';
  if (putRes.status === 409) return 'conflict';
  return putRes.ok ? 'ok' : 'error';
}

$('#save').addEventListener('click', async () => {
  if (REMOTE) {
    const result = await saveRemote();
    if (result === 'auth') return dropAuth('Токен не подошёл — войдите заново');
    if (result === 'ok') {
      markSaved();
      toast('Сохранено — сайт обновится через минуту-две');
    } else if (result === 'conflict') {
      toast('Конфликт версий — перезагрузите админку и повторите');
    } else {
      toast('Не удалось сохранить — попробуйте ещё раз');
    }
    return;
  }

  const res = await fetch('/api/data', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
    body: JSON.stringify(data),
  });
  if (res.status === 401) {
    dropAuth('Сессия истекла — войдите заново и нажмите «Сохранить»');
    return;
  }
  if (res.ok) {
    const result = await res.json();
    data.settings.updatedAt = result.updatedAt;
    markSaved();
    toast('Сохранено ✓');
  } else {
    toast('Не удалось сохранить — попробуйте ещё раз');
  }
});

$('#publish').addEventListener('click', async () => {
  if (dirty) {
    toast('Сначала нажмите «Сохранить изменения»');
    return;
  }
  const button = $('#publish');
  button.disabled = true;
  button.textContent = 'Публикую…';
  try {
    const res = await fetch('/api/publish', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (res.status === 401) {
      dropAuth('Сессия истекла — войдите заново');
      return;
    }
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Не получилось опубликовать');
    toast('Опубликовано! Страница в интернете обновится через минуту');
  } catch (err) {
    toast(err.message || 'Не получилось опубликовать');
  } finally {
    button.disabled = false;
    button.textContent = 'Опубликовать';
  }
});

window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault();
});

/* ---------- Старт ---------- */

(async function init() {
  const res = REMOTE
    ? await fetch(GH_API + '/contents/docs/data.json?ref=main&ts=' + Date.now(), {
        headers: { 'Accept': 'application/vnd.github.raw+json' },
        cache: 'no-store',
      })
    : await fetch('/api/data');
  data = await res.json();
  if (token) showApp();
  else showLogin();
})();
