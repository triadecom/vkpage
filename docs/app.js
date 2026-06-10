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

  const displayName = pub.name || (pub.url ? pub.url.replace(/^https?:\/\//, '') : 'Сообщество ВК');
  const name = pub.url
    ? `<a class="public-name" href="${esc(pub.url)}" target="_blank" rel="noopener">${esc(displayName)}</a>`
    : `<span class="public-name">${esc(displayName)}</span>`;

  const initial = String(pub.name || '?').trim().charAt(0).toUpperCase() || '?';
  // путь относительный, чтобы работало и локально, и на GitHub Pages в поддиректории
  const cover = pub.avatar
    ? `<img class="card-cover-img" src="${esc(String(pub.avatar).replace(/^\//, ''))}" alt="" loading="lazy">`
    : `<span class="card-cover-ph">${esc(initial)}</span>`;

  return `
  <article class="card public-card">
    <div class="card-cover">
      ${cover}
    </div>
    <div class="card-title">${name}</div>
    <div class="card-stats">
      <div class="stat">
        <span class="stat-value">${fmt(pub.subscribers)}</span>
        <span class="stat-label">подписчиков</span>
      </div>
      ${pub.category ? `
      <div class="stat stat-right">
        <span class="stat-value">${esc(pub.category)}</span>
        <span class="stat-label">тематика</span>
      </div>` : ''}
    </div>
    <div class="price-list">${prices}</div>
    ${pub.note ? `<p class="card-note">${esc(pub.note)}</p>` : ''}
    <a class="btn btn-ghost card-cta" href="${esc(contactHref(settings))}" target="_blank" rel="noopener" data-msg="${esc(orderMessage(settings, pub))}">Заказать размещение</a>
  </article>`;
}

// Разбирает свободный текст блока акций на структурные пункты:
// абзац = пункт; первая строка — название (цена «...9800₽» в конце уходит вправо);
// строки с «-» — список, с «+» — дополнение к пакету
function parsePromoItems(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map((par) => par.trim())
    .filter(Boolean)
    .map((par) => {
      const lines = par.split('\n').map((l) => l.trim()).filter(Boolean);
      let title = (lines.shift() || '').replace(/^[\p{Extended_Pictographic}️\s]+/u, '');
      let price = 0;
      const priceMatch = title.match(/^(.*?)[\s:—–-]*(?:Стоимость\s*)?(\d[\d\s]{2,})\s*₽[\s.!]*$/u);
      if (priceMatch) {
        title = priceMatch[1].replace(/[\s:—–-]+$/u, '');
        price = Number(priceMatch[2].replace(/\s/g, ''));
      }
      const bullets = [];
      const extras = [];
      const texts = [];
      for (const line of lines) {
        if (/^[-–•]\s*/.test(line)) bullets.push(line.replace(/^[-–•]\s*/, ''));
        else if (/^\+\s*/.test(line)) extras.push(line.replace(/^\+\s*/, ''));
        else texts.push(line);
      }
      return { title, price, bullets, extras, texts };
    });
}

function renderPromoBlock(promo) {
  const items = parsePromoItems(promo.text);
  return `
  <section class="promo-block">
    ${promo.title ? `<h2 class="section-title">${esc(promo.title)}</h2>` : ''}
    <div class="promo-items">
      ${items.map((item) => `
      <div class="card promo-item">
        <div class="promo-item-head">
          <span class="promo-item-title">${esc(item.title)}</span>
          ${item.price ? `<span class="dots"></span><span class="promo-price">${fmt(item.price)} ₽</span>` : ''}
        </div>
        ${item.texts.map((t) => `<p class="promo-item-text">${esc(t)}</p>`).join('')}
        ${item.bullets.length ? `<ul class="promo-list">${item.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
        ${item.extras.map((x) => `<p class="promo-extra">${esc(x)}</p>`).join('')}
      </div>`).join('')}
    </div>
  </section>`;
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

  const offerUrl = (settings.offerUrl || '').trim();
  const requisites = (settings.requisites || '').trim();
  $('#footer-legal').hidden = !offerUrl && !requisites;
  $('#offer-link').hidden = !offerUrl;
  if (offerUrl) $('#offer-link').href = offerUrl;
  $('#requisites-link').hidden = !requisites;
  $('#legal-dot').hidden = !(offerUrl && requisites);
  if (requisites) $('#req-content').innerHTML = renderRequisitesRows(requisites);

  const promos = (settings.promos || []).filter((p) => (p.title || '').trim() || (p.text || '').trim());
  if (promos.length) {
    $('#promos-section').hidden = false;
    $('#promos').innerHTML = promos.map(renderPromoBlock).join('');
  } else {
    $('#promos-section').hidden = true;
  }

  const conditions = (settings.conditions || []).filter(Boolean);
  if (conditions.length) {
    $('#conditions-section').hidden = false;
    $('#conditions').innerHTML = conditions.map((c) => `<li>${esc(c)}</li>`).join('');
  } else {
    $('#conditions-section').hidden = true;
  }
}

// Реквизиты: «Подпись: значение» — строка с лейблом, без двоеточия — имя ИП
function renderRequisitesRows(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const m = line.match(/^(.{1,40}?):\s*(.+)$/);
    if (!m) return `<div class="req-name">${esc(line)}</div>`;
    const value = m[2].trim();
    const isEmail = /^\S+@\S+\.\S+$/.test(value);
    const valueHtml = isEmail
      ? `<a class="req-value" href="mailto:${esc(value)}">${esc(value)}</a>`
      : `<span class="req-value" title="Нажмите, чтобы скопировать">${esc(value)}</span>`;
    return `<div class="req-row"><span class="req-label">${esc(m[1])}</span>${valueHtml}</div>`;
  }).join('');
}

function closeRequisites() {
  $('#requisites-backdrop').hidden = true;
}

$('#requisites-link').addEventListener('click', () => {
  $('#requisites-backdrop').hidden = false;
});
$('#req-close').addEventListener('click', closeRequisites);
$('#requisites-backdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeRequisites();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeRequisites();
});
$('#req-content').addEventListener('click', (e) => {
  const value = e.target.closest('span.req-value');
  if (!value || !navigator.clipboard) return;
  navigator.clipboard.writeText(value.textContent)
    .then(() => toast('Скопировано в буфер'))
    .catch(() => {});
});

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
