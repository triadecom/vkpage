const $ = (sel) => document.querySelector(sel);

// Админка работает через свой сервер: вход по паролю, сохранение сразу в живые данные.
const TOKEN_KEY = 'vkpage_token';
const storage = localStorage;

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

// аватарки сервер раздаёт из папки с данными
function avatarSrc(avatar) {
  return '/' + String(avatar).replace(/^\//, '');
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
  $('#password').focus();
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  renderSettings();
  renderPromos();
  renderPublics();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();

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
    const body = await res.json().catch(() => ({}));
    $('#login-error').textContent = body.error || 'Неверный пароль';
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

// Обход ВК делает сервер и сразу сохраняет результат — жать «Сохранить» не нужно
$('#refresh-all').addEventListener('click', async () => {
  const button = $('#refresh-all');

  if (dirty) {
    toast('Сначала нажмите «Сохранить изменения» — иначе обновление их перезапишет');
    return;
  }
  if (!data.publics.some((p) => p.url)) {
    toast('У сообществ не указаны ссылки на ВК');
    return;
  }

  button.disabled = true;
  button.textContent = 'Обновляю из ВК…';
  try {
    const res = await fetch('/api/refresh', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (res.status === 401) return dropAuth('Сессия истекла — войдите заново');
    if (!res.ok) throw new Error('Не получилось запустить обновление');
    toast('Обхожу сообщества в ВК — это займёт около минуты');
    const result = await waitForRefresh();
    data = await loadData();
    renderSettings();
    renderPromos();
    renderPublics();
    markSaved();
    if (result.error) toast('Обновление прервалось: ' + result.error);
    else toast(result.failed
      ? `Обновлено сообществ: ${result.updated}, не ответили: ${result.failed}`
      : `Обновлено сообществ: ${result.updated} ✓`);
  } catch (err) {
    toast(err.message || 'Не получилось обновить');
  } finally {
    button.disabled = false;
    button.textContent = '⟳ Обновить всё из ВК';
  }
});

// Сервер обходит ВК в фоне — ждём, пока освободится, но не дольше пяти минут
function waitForRefresh() {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - startedAt > 5 * 60 * 1000) {
        clearInterval(timer);
        reject(new Error('ВК отвечает слишком долго — загляните в админку через пару минут'));
        return;
      }
      try {
        const res = await fetch('/api/refresh-status', {
          headers: { 'Authorization': 'Bearer ' + token },
          cache: 'no-store',
        });
        if (!res.ok) return;
        const state = await res.json();
        if (!state.running) {
          clearInterval(timer);
          resolve(state);
        }
      } catch {
        // сеть мигнула — спросим ещё раз на следующем тике
      }
    }, 3000);
  });
}

/* ---------- Редактор сообщества ---------- */

const VK_HINT = 'вставьте ссылку на паблик — данные подтянутся сами';

function setVkStatus(text) {
  $('#vk-status').textContent = text;
}

function updateAvatarPreview() {
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
  img.src = avatarSrc(editorAvatar);
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

// В ВК ходит сервер — браузеру туда нельзя из-за CORS
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

$('#fetch-vk').addEventListener('click', () => {
  lastFetchedUrl = ''; // кнопка — явный запрос, перезагружаем даже для того же адреса
  fetchFromVk();
});

// Автоподтягивание: вставил ссылку — данные поехали сами
$('#e-url').addEventListener('input', () => {
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

$('#save').addEventListener('click', async () => {
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
    toast('Сохранено ✓ — страница уже обновилась');
  } else {
    toast('Не удалось сохранить — попробуйте ещё раз');
  }
});

window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault();
});

/* ---------- Старт ---------- */

async function loadData() {
  const res = await fetch('/api/data', { cache: 'no-store' });
  const parsed = await res.json();
  if (!parsed || !parsed.settings) throw new Error('данные не читаются');
  return parsed;
}

(async function init() {
  try {
    data = await loadData();
  } catch {
    document.body.innerHTML = '<div class="login-screen"><div class="card login-card"><h2>Не удалось загрузить данные</h2><p class="muted">Проверьте интернет и перезагрузите страницу (Cmd+Shift+R).</p></div></div>';
    return;
  }
  if (token) showApp();
  else showLogin();
})();
