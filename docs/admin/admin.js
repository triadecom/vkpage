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
let editorReachManual = false; // охват введён руками — автообновление его не трогает
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
  renderPromos();
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
  ['s-offer', 'offerUrl'],
  ['s-requisites', 'requisites'],
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

/* ---------- Акции и пакеты ---------- */

function renderPromos() {
  const wrap = $('#promos-list');
  const promos = data.settings.promos || (data.settings.promos = []);
  if (!promos.length) {
    wrap.innerHTML = '<div class="empty">Блоков нет — добавьте, когда появятся акции или пакеты.</div>';
    return;
  }
  wrap.innerHTML = '';
  promos.forEach((promo, i) => {
    const block = document.createElement('div');
    block.className = 'promo-edit';
    block.innerHTML = `
      <div class="promo-edit-head">
        <input type="text" placeholder="Заголовок — например, «Скидки и пакеты»">
        <button type="button" class="icon-btn" title="Выше" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="icon-btn" title="Ниже" ${i === promos.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="icon-btn danger" title="Удалить">✕</button>
      </div>
      <textarea rows="7" placeholder="Каждый абзац — отдельный пункт. Первая строка — название, цена в её конце (например «: 9800₽») встанет справа. Строки с «-» станут списком, с «+» — дополнением."></textarea>`;
    block.querySelector('input').value = promo.title || '';
    block.querySelector('textarea').value = promo.text || '';
    block.querySelector('input').addEventListener('input', (e) => { promo.title = e.target.value; markDirty(); });
    block.querySelector('textarea').addEventListener('input', (e) => { promo.text = e.target.value; markDirty(); });
    const [up, down, del] = block.querySelectorAll('.icon-btn');
    up.addEventListener('click', () => {
      [promos[i - 1], promos[i]] = [promos[i], promos[i - 1]];
      markDirty();
      renderPromos();
    });
    down.addEventListener('click', () => {
      [promos[i + 1], promos[i]] = [promos[i], promos[i + 1]];
      markDirty();
      renderPromos();
    });
    del.addEventListener('click', () => {
      if (!confirm('Удалить блок «' + (promo.title || 'без названия') + '»?')) return;
      promos.splice(i, 1);
      markDirty();
      renderPromos();
    });
    wrap.appendChild(block);
  });
}

$('#add-promo').addEventListener('click', () => {
  (data.settings.promos = data.settings.promos || []).push({ title: '', text: '' });
  markDirty();
  renderPromos();
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
      if (await dispatchRefresh()) {
        toast('Обновление запущено — результат появится здесь через 2–3 минуты');
        watchForVkData();
      } else if (token) {
        toast('Не получилось запустить обновление');
      }
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
      if (info.reach && !pub.reachManual) pub.reach = info.reach;
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
  ? 'вставьте ссылку — название и цифры подтянутся (в облаке до минуты)'
  : 'вставьте ссылку на паблик — данные подтянутся сами';

async function dispatchRefresh() {
  const res = await fetch(GH_API + '/actions/workflows/refresh.yml/dispatches', {
    method: 'POST',
    headers: ghHeaders(),
    body: JSON.stringify({ ref: 'main' }),
  });
  if (res.status === 401 || res.status === 403) {
    dropAuth('Токен не подошёл — войдите заново');
    return false;
  }
  return res.status === 204;
}

// После облачного сохранения ждём, пока Actions заполнит данные из ВК,
// и сами показываем результат — без перезагрузок и кнопок
let watchTimer = null;
function watchForVkData() {
  clearInterval(watchTimer);
  let tries = 0;
  watchTimer = setInterval(async () => {
    if (++tries > 15) {
      clearInterval(watchTimer);
      return;
    }
    try {
      const res = await fetch(GH_API + '/contents/docs/data.json?ref=main&ts=' + Date.now(), {
        headers: { 'Accept': 'application/vnd.github.raw+json', 'Authorization': 'Bearer ' + token },
        cache: 'no-store',
      });
      if (!res.ok) return;
      const fresh = await res.json();
      const stillWaiting = fresh.publics.some((p) => p.url && (!p.name || !p.subscribers));
      if (!stillWaiting) {
        clearInterval(watchTimer);
        if (!dirty) {
          data = fresh;
          renderPublics();
          toast('Данные из ВК подтянулись ✓');
        }
      }
    } catch {
      // временная ошибка сети — попробуем в следующий тик
    }
  }, 20000);
}

function setVkStatus(text) {
  $('#vk-status').textContent = text;
}

async function updateAvatarPreview() {
  const img = $('#e-avatar');
  const placeholder = $('#e-avatar-placeholder');
  if (!editorAvatar) {
    img.hidden = true;
    placeholder.hidden = false;
    placeholder.textContent = ($('#e-name').value.trim().charAt(0) || '?').toUpperCase();
    return;
  }
  img.hidden = false;
  placeholder.hidden = true;
  if (!REMOTE) {
    img.src = avatarSrc(editorAvatar);
    return;
  }
  // в облаке свежая аватарка появляется на сайте только после пересборки Pages,
  // поэтому превью берём напрямую из репозитория через API
  const current = editorAvatar;
  try {
    const res = await fetch(GH_API + '/contents/docs/' + current.replace(/^\//, '') + '?ref=main&ts=' + Date.now(), {
      headers: { 'Accept': 'application/vnd.github.raw+json', 'Authorization': 'Bearer ' + token },
      cache: 'no-store',
    });
    if (current !== editorAvatar) return; // пока грузили, выбрали другую
    if (res.ok) {
      img.src = URL.createObjectURL(await res.blob());
      return;
    }
  } catch {
    // сеть мигнула — покажем через сайт
  }
  if (current === editorAvatar) img.src = avatarSrc(current);
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
  editorReachManual = !!pub.reachManual;
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

// ручной ввод охвата фиксируем; пустое поле возвращает автообновление
$('#e-reach').addEventListener('input', () => {
  editorReachManual = $('#e-reach').value.trim() !== '';
});

function fillEditorFromInfo(info, url) {
  lastFetchedUrl = url;
  if (info.avatar) editorAvatar = info.avatar;
  if (info.name) $('#e-name').value = info.name;
  if (info.subscribers) $('#e-subscribers').value = info.subscribers;
  if (info.reach && !editorReachManual) $('#e-reach').value = info.reach;
  updateAvatarPreview();
  setVkStatus('Данные из ВК загружены ✓');
}

// Локальный режим: сервер сходит в ВК сам, мгновенно
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
    fillEditorFromInfo(info, url);
  } catch {
    setVkStatus('Не получилось загрузить — проверьте ссылку');
  }
}

/* Облачный режим: браузеру к ВК нельзя (CORS), поэтому данные добывает
   workflow vkinfo — кладёт их в docs/vkinfo/<hash>.json, а редактор забирает */

async function sha1hex16(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

async function readVkInfoFile(hash) {
  const res = await fetch(GH_API + '/contents/docs/vkinfo/' + hash + '.json?ref=main&ts=' + Date.now(), {
    headers: { 'Accept': 'application/vnd.github.raw+json', 'Authorization': 'Bearer ' + token },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

let remoteFetchSeq = 0;

async function remoteFetchFromVk() {
  const url = $('#e-url').value.trim();
  if (!url || url === lastFetchedUrl) return;
  const seq = ++remoteFetchSeq;
  const hash = await sha1hex16(url);

  // недавний результат уже лежит в репозитории — заполняем мгновенно
  const cached = await readVkInfoFile(hash);
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < 24 * 3600 * 1000) {
    if (seq === remoteFetchSeq) fillEditorFromInfo(cached, url);
    return;
  }

  setVkStatus('Запрашиваю данные из ВК — обычно до минуты…');
  const res = await fetch(GH_API + '/actions/workflows/vkinfo.yml/dispatches', {
    method: 'POST',
    headers: ghHeaders(),
    body: JSON.stringify({ ref: 'main', inputs: { url } }),
  });
  if (res.status === 401 || res.status === 403) return dropAuth('Токен не подошёл — войдите заново');
  if (res.status !== 204) {
    setVkStatus('Не получилось запустить загрузку — попробуйте ещё раз');
    return;
  }

  const startedAt = Date.now();
  const poll = setInterval(async () => {
    if (seq !== remoteFetchSeq || $('#modal-backdrop').hidden) {
      clearInterval(poll);
      return;
    }
    if (Date.now() - startedAt > 3 * 60 * 1000) {
      clearInterval(poll);
      setVkStatus('ВК не ответил — попробуйте ещё раз или сохраните, облако дозаполнит');
      return;
    }
    const info = await readVkInfoFile(hash);
    if (info && Date.parse(info.fetchedAt) >= startedAt - 60 * 1000) {
      clearInterval(poll);
      fillEditorFromInfo(info, url);
    }
  }, 10000);
}

$('#fetch-vk').addEventListener('click', () => {
  lastFetchedUrl = ''; // кнопка — явный запрос, перезагружаем даже для того же адреса
  if (REMOTE) remoteFetchFromVk();
  else fetchFromVk();
});

// Автоподтягивание: вставил ссылку — данные поехали сами
$('#e-url').addEventListener('input', () => {
  clearTimeout(autoFetchTimer);
  const url = $('#e-url').value.trim();
  if (!/(^|\/\/)(www\.|m\.)?vk\.com\/[\w.\-]+/i.test(url)) return;
  autoFetchTimer = setTimeout(() => (REMOTE ? remoteFetchFromVk() : fetchFromVk()), 700);
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

  const reach = Number($('#e-reach').value) || 0;
  const pub = {
    id: editIndex === null ? 'p' + Date.now() : data.publics[editIndex].id,
    name,
    avatar: editorAvatar,
    url,
    category: $('#e-category').value.trim(),
    subscribers: Number($('#e-subscribers').value) || 0,
    reach,
    reachManual: editorReachManual && reach > 0,
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
      // у новых пабликов есть ссылка, но нет данных — облако заполнит их само
      const needsVk = data.publics.some((p) => p.url && (!p.name || !p.avatar || !p.subscribers));
      if (needsVk && await dispatchRefresh()) {
        toast('Сохранено — название и цифры подтянутся из ВК через пару минут');
        watchForVkData();
      } else {
        toast('Сохранено — сайт обновится через минуту-две');
      }
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
