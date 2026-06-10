const $ = (sel) => document.querySelector(sel);

let data = null;
let token = sessionStorage.getItem('vkpage_token') || '';
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

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

function markDirty() {
  dirty = true;
  $('#save').disabled = false;
}

function markSaved() {
  dirty = false;
  $('#save').disabled = true;
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
    sessionStorage.setItem('vkpage_token', token);
    $('#login-error').textContent = '';
    $('#password').value = '';
    showApp();
  } else {
    $('#login-error').textContent = 'Неверный пароль';
  }
});

$('#logout').addEventListener('click', () => {
  if (dirty && !confirm('Есть несохранённые изменения. Выйти без сохранения?')) return;
  sessionStorage.removeItem('vkpage_token');
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
    const initial = String(pub.name || '?').trim().charAt(0).toUpperCase() || '?';
    const avatar = pub.avatar
      ? `<img class="avatar avatar-sm" src="${esc(pub.avatar)}" alt="">`
      : `<span class="avatar avatar-placeholder avatar-sm">${esc(initial)}</span>`;
    const arrows = manualOrder ? `
      <button type="button" class="icon-btn" data-action="up" title="Выше" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="icon-btn" data-action="down" title="Ниже" ${i === data.publics.length - 1 ? 'disabled' : ''}>↓</button>` : '';
    return `
    <div class="pub-row" data-index="${i}">
      ${avatar}
      <div class="pub-row-info">
        <div class="pub-row-name">${esc(pub.name)}</div>
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
    if (!confirm(`Удалить «${data.publics[index].name}»?`)) return;
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

$('#refresh-all').addEventListener('click', async () => {
  const targets = data.publics.filter((p) => p.url);
  if (!targets.length) {
    toast('У сообществ не указаны ссылки на ВК');
    return;
  }
  const button = $('#refresh-all');
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
        sessionStorage.removeItem('vkpage_token');
        token = '';
        showLogin();
        toast('Сессия истекла — войдите заново');
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

function updateAvatarPreview() {
  const img = $('#e-avatar');
  const placeholder = $('#e-avatar-placeholder');
  if (editorAvatar) {
    img.src = editorAvatar;
    img.hidden = false;
    placeholder.hidden = true;
  } else {
    img.hidden = true;
    placeholder.hidden = false;
    placeholder.textContent = ($('#e-name').value.trim().charAt(0) || '?').toUpperCase();
  }
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

$('#e-name').addEventListener('input', () => {
  if (!editorAvatar) updateAvatarPreview();
});

const VK_HINT = 'вставьте ссылку на паблик — данные подтянутся сами';

function setVkStatus(text) {
  $('#vk-status').textContent = text;
}

async function fetchFromVk() {
  const url = $('#e-url').value.trim();
  if (!url || url === lastFetchedUrl) return;

  setVkStatus('Загружаю данные из ВК…');
  try {
    const res = await fetch('/api/vkinfo?url=' + encodeURIComponent(url), {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (res.status === 401) {
      sessionStorage.removeItem('vkpage_token');
      token = '';
      closeEditor();
      showLogin();
      toast('Сессия истекла — войдите заново');
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

// Автоподтягивание: вставил ссылку — данные приехали сами
$('#e-url').addEventListener('input', () => {
  clearTimeout(autoFetchTimer);
  const url = $('#e-url').value.trim();
  if (!/(^|\/\/)(www\.|m\.)?vk\.com\/[\w.\-]+/i.test(url)) return;
  autoFetchTimer = setTimeout(fetchFromVk, 700);
});

function closeEditor() {
  $('#modal-backdrop').hidden = true;
  editIndex = null;
}

$('#add-price').addEventListener('click', () => addPriceRow());
$('#editor-cancel').addEventListener('click', closeEditor);

$('#editor').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#e-name').value.trim();
  if (!name) return;

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
    url: $('#e-url').value.trim(),
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
    sessionStorage.removeItem('vkpage_token');
    token = '';
    showLogin();
    toast('Сессия истекла — войдите заново и нажмите «Сохранить»');
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
      sessionStorage.removeItem('vkpage_token');
      token = '';
      showLogin();
      toast('Сессия истекла — войдите заново');
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
  const res = await fetch('/api/data');
  data = await res.json();
  if (token) showApp();
  else showLogin();
})();
