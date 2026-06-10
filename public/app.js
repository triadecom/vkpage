const $ = (sel) => document.querySelector(sel);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmt(n) {
  return Number(n || 0).toLocaleString('ru-RU');
}

function compact(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' млн';
  if (n >= 1e3) return Math.round(n / 1e3).toLocaleString('ru-RU') + ' тыс.';
  return fmt(n);
}

function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return iso || '—';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function plural(n, forms) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

function contactHref(settings) {
  return settings.contactVk || settings.contactTg || '#';
}

function orderMessage(settings, pub) {
  const template = settings.messageTemplate || 'Здравствуйте! Пишу по поводу размещения рекламы в «{название}».';
  return template.replaceAll('{название}', pub.name || '');
}

let toastTimer = null;
function toast(message) {
  const el = document.querySelector('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

function renderCard(pub, settings) {
  const prices = (pub.prices || []).map((p) => `
    <div class="price-row">
      <span class="price-format">${esc(p.format)}</span>
      <span class="dots"></span>
      <span class="price-value">${fmt(p.price)} ₽</span>
    </div>`).join('');

  const name = pub.url
    ? `<a class="public-name" href="${esc(pub.url)}" target="_blank" rel="noopener">${esc(pub.name)}</a>`
    : `<span class="public-name">${esc(pub.name)}</span>`;

  const initial = String(pub.name || '?').trim().charAt(0).toUpperCase() || '?';
  // путь относительный, чтобы работало и локально, и на GitHub Pages в поддиректории
  const cover = pub.avatar
    ? `<img class="card-cover-img" src="${esc(String(pub.avatar).replace(/^\//, ''))}" alt="" loading="lazy">`
    : `<span class="card-cover-ph">${esc(initial)}</span>`;

  return `
  <article class="card public-card">
    <div class="card-cover">
      ${cover}
      ${pub.category ? `<span class="chip cover-chip">${esc(pub.category)}</span>` : ''}
    </div>
    <div class="card-title">${name}</div>
    <div class="card-stats">
      <div class="stat">
        <span class="stat-value">${fmt(pub.subscribers)}</span>
        <span class="stat-label">подписчиков</span>
      </div>
      <div class="stat">
        <span class="stat-value">${fmt(pub.reach)}</span>
        <span class="stat-label">охват поста</span>
      </div>
    </div>
    <div class="price-list">${prices}</div>
    ${pub.note ? `<p class="card-note">${esc(pub.note)}</p>` : ''}
    <a class="btn btn-ghost card-cta" href="${esc(contactHref(settings))}" target="_blank" rel="noopener" data-msg="${esc(orderMessage(settings, pub))}">Заказать размещение</a>
  </article>`;
}

function render(data) {
  const { settings } = data;
  const publics = settings.sort === 'subscribers'
    ? [...data.publics].sort((a, b) => (Number(b.subscribers) || 0) - (Number(a.subscribers) || 0))
    : data.publics;

  document.title = settings.title || 'Прайс на рекламу';
  $('#title').textContent = settings.title || 'Реклама в наших сообществах';
  $('#subtitle').textContent = settings.subtitle || '';
  $('#updated').textContent = fmtDate(settings.updatedAt);
  $('#footer-updated').textContent = fmtDate(settings.updatedAt);

  const contacts = [];
  if (settings.contactVk) {
    contacts.push(`<a class="btn btn-primary" href="${esc(settings.contactVk)}" target="_blank" rel="noopener">Написать ВКонтакте</a>`);
  }
  if (settings.contactTg) {
    contacts.push(`<a class="btn btn-ghost" href="${esc(settings.contactTg)}" target="_blank" rel="noopener">Написать в Telegram</a>`);
  }
  $('#contacts').innerHTML = contacts.join('');

  const footerLinks = [];
  if (settings.contactVk) footerLinks.push(`<a href="${esc(settings.contactVk)}" target="_blank" rel="noopener">ВКонтакте</a>`);
  if (settings.contactTg) footerLinks.push(`<a href="${esc(settings.contactTg)}" target="_blank" rel="noopener">Telegram</a>`);
  $('#footer-contacts').innerHTML = footerLinks.join('');

  if (publics.length) {
    const totalSubs = publics.reduce((sum, p) => sum + (Number(p.subscribers) || 0), 0);
    $('#stats').innerHTML = `
      <span class="stat-pill"><b>${publics.length}</b> ${plural(publics.length, ['сообщество', 'сообщества', 'сообществ'])}</span>
      <span class="stat-pill"><b>${compact(totalSubs)}</b> подписчиков суммарно</span>`;
    $('#publics').innerHTML = publics.map((p) => renderCard(p, settings)).join('');
  } else {
    $('#stats').innerHTML = '';
    $('#publics').innerHTML = '<div class="empty">Прайс заполняется — загляните чуть позже.</div>';
  }

  const conditions = (settings.conditions || []).filter(Boolean);
  if (conditions.length) {
    $('#conditions-section').hidden = false;
    $('#conditions').innerHTML = conditions.map((c) => `<li>${esc(c)}</li>`).join('');
  } else {
    $('#conditions-section').hidden = true;
  }
}

// ВК не умеет предзаполнять текст личного сообщения по ссылке,
// поэтому при клике кладём готовое сообщение в буфер обмена
$('#publics').addEventListener('click', (e) => {
  const cta = e.target.closest('.card-cta');
  if (!cta || !cta.dataset.msg || !navigator.clipboard) return;
  navigator.clipboard.writeText(cta.dataset.msg)
    .then(() => toast('Сообщение скопировано — вставьте его в чат'))
    .catch(() => {});
});

fetch('data.json')
  .then((res) => res.json())
  .then(render)
  .catch(() => {
    $('#publics').innerHTML = '<div class="empty">Не удалось загрузить данные. Обновите страницу.</div>';
  });
