// Виджет чата на лендинге: пробный вход в «Финник · Деньги» без регистрации.
// Показывает приветствие с кнопками онбординга, а на любое действие отвечает,
// что нужно войти или создать аккаунт, и даёт ссылки на вход и регистрацию.
// Серверу ничего не отправляет: это статичная витрина, ничего не сохраняется.

export const SESSION_TOKEN_KEY = 'mercury_token';

// Приветствие — тот же текст и те же кнопки, что в онбординге бота (src/handlers/onboarding.js)
export const GREETING_TEXT =
  'Привет! Я Финник — твой личный финансовый помощник 👋\n\n' +
  'Помогу тебе:\n' +
  '💰понять, куда уходят деньги;\n' +
  '🎯поставить финансовую цель и двигаться к ней;\n' +
  '📊видеть понятную аналитику по доходам и расходам.\n\n' +
  'Просто пиши мне в свободной форме — например, «продукты 2500» или «зарплата 120000» — и я всё запишу.\n\n' +
  'Рассказать подробнее о моих возможностях или сразу запишем первую трату?';

export const GREETING_BUTTONS = [
  'Как записывать расходы и доходы?',
  'Расскажи о целях',
  'Подробнее об аналитике',
  'Зачем устанавливать бюджет?',
  'Записать первую трату',
];

export const AUTH_TEXT =
  'Чтобы я мог это сделать, нужно войти в личный кабинет или создать аккаунт 🙌\n\n' +
  'Регистрация бесплатная, а 30 дней пробного периода со всеми функциями включатся сразу 🎁';

export const AUTH_LINKS = [
  { label: 'Создать аккаунт', href: '/cabinet/register', primary: true },
  { label: 'Войти', href: '/cabinet/login', primary: false },
];

// Любое действие посетителя (кнопка, сообщение, меню) ведёт к одному ответу
export function replyFor() {
  return { text: AUTH_TEXT, links: AUTH_LINKS };
}

// Если посетитель уже вошёл в кабинет — кнопка чата ведёт в настоящий чат
export function hasSession(storage) {
  try {
    return Boolean(storage && storage.getItem(SESSION_TOKEN_KEY));
  } catch {
    return false;
  }
}

const REPLY_DELAY_MS = 700;

export function initLandingWidget(doc, storage) {
  if (doc.getElementById('lwFab')) return;
  const loggedIn = hasSession(storage);

  const fab = doc.createElement(loggedIn ? 'a' : 'button');
  fab.id = 'lwFab';
  fab.className = 'lw-fab';
  fab.setAttribute('aria-label', 'Открыть чат с Финником');
  if (loggedIn) fab.href = '/cabinet/bot';
  else fab.type = 'button';
  fab.innerHTML =
    '<svg width="30" height="30" viewBox="0 0 32 32" fill="none" aria-hidden="true"><circle cx="10.67" cy="16" r="1.5" fill="#fff"/><circle cx="16" cy="16" r="1.5" fill="#fff"/><circle cx="21.33" cy="16" r="1.5" fill="#fff"/>' +
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M30.33 16C30.33 8.08 23.92 1.67 16 1.67S1.67 8.08 1.67 16c0 2.29.54 4.46 1.5 6.38.14.29.17.58.1.83l-.8 2.97c-.54 2.03 1.32 3.89 3.35 3.35l2.97-.8c.25-.07.54-.04.83.1 1.92.96 4.09 1.5 6.38 1.5 7.92 0 14.33-6.42 14.33-14.33ZM16 3.67c6.81 0 12.33 5.52 12.33 12.33S22.81 28.33 16 28.33c-1.98 0-3.84-.46-5.49-1.29-.66-.33-1.46-.46-2.24-.25l-2.97.8c-.55.15-1.04-.35-.9-.9l.79-2.97c.21-.78.08-1.57-.25-2.24A12.3 12.3 0 0 1 3.67 16C3.67 9.19 9.19 3.67 16 3.67Z" fill="#fff"/></svg>';
  let badge = null;
  if (!loggedIn) {
    badge = doc.createElement('span');
    badge.className = 'lw-fab__badge';
    badge.textContent = '1';
    badge.setAttribute('aria-hidden', 'true');
    fab.appendChild(badge);
  }
  doc.body.appendChild(fab);
  if (loggedIn) return;

  const overlay = doc.createElement('div');
  overlay.className = 'lw-overlay';
  overlay.id = 'lwOverlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Чат с Финником');
  overlay.innerHTML =
    '<div class="lw-backdrop" id="lwBackdrop"></div>' +
    '<div class="lw-page">' +
      '<div class="lw-header">' +
        '<div class="lw-header__info">' +
          '<img src="/images/bot-face.svg" class="lw-avatar" alt="Финник · Деньги" width="36" height="36" />' +
          '<div><div class="lw-name">Финник · Деньги</div><div class="lw-status">онлайн</div></div>' +
        '</div>' +
        '<button class="lw-close" id="lwClose" type="button" aria-label="Закрыть чат">' +
          '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M18 6L6 18M6 6L18 18" stroke="#4B5563" stroke-width="2" stroke-linecap="round"/></svg>' +
        '</button>' +
      '</div>' +
      '<div class="lw-chat" id="lwChat" aria-live="polite"></div>' +
      '<form class="lw-input-bar" id="lwForm" autocomplete="off">' +
        '<button class="lw-menu-btn" id="lwMenu" type="button" aria-label="Главное меню">' +
          '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 6H20M4 12H20M4 18H20" stroke="#4C9AFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</button>' +
        '<input class="lw-input" id="lwInput" type="text" placeholder="Написать сообщение..." autocomplete="off" />' +
        '<button class="lw-send" type="submit" aria-label="Отправить">' +
          '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12H19M19 12L13 6M19 12L13 18" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</button>' +
      '</form>' +
    '</div>';
  doc.body.appendChild(overlay);

  const chat = overlay.querySelector('#lwChat');
  const input = overlay.querySelector('#lwInput');
  let greeted = false;
  let busy = false;

  const scrollDown = () => { chat.scrollTop = chat.scrollHeight; };

  function bubble(text, from) {
    const wrap = doc.createElement('div');
    wrap.className = 'lw-bubble-wrap from-' + from;
    const b = doc.createElement('div');
    b.className = 'lw-bubble ' + from;
    b.textContent = text;
    wrap.appendChild(b);
    chat.appendChild(wrap);
    return wrap;
  }

  function buttons(labels) {
    const row = doc.createElement('div');
    row.className = 'lw-cta-wrap';
    for (const label of labels) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'lw-cta-btn';
      b.textContent = label;
      b.addEventListener('click', () => act(label));
      row.appendChild(b);
    }
    chat.appendChild(row);
  }

  function links(list) {
    const row = doc.createElement('div');
    row.className = 'lw-cta-wrap';
    for (const l of list) {
      const a = doc.createElement('a');
      a.href = l.href;
      a.className = 'lw-cta-btn' + (l.primary ? ' lw-cta-btn--primary' : '');
      a.textContent = l.label;
      row.appendChild(a);
    }
    chat.appendChild(row);
  }

  function typing() {
    const wrap = doc.createElement('div');
    wrap.className = 'lw-typing';
    wrap.innerHTML = '<div class="lw-typing__box"><span></span><span></span><span></span></div>';
    chat.appendChild(wrap);
    return wrap;
  }

  // Любое действие: показываем его как сообщение пользователя и отвечаем про вход
  function act(text) {
    if (busy) return;
    busy = true;
    bubble(text, 'user');
    const dots = typing();
    scrollDown();
    setTimeout(() => {
      dots.remove();
      const r = replyFor(text);
      bubble(r.text, 'bot');
      links(r.links);
      scrollDown();
      busy = false;
    }, REPLY_DELAY_MS);
  }

  function open() {
    overlay.classList.add('is-open');
    doc.body.classList.add('lw-lock');
    badge && badge.remove();
    badge = null;
    if (!greeted) {
      greeted = true;
      bubble(GREETING_TEXT, 'bot');
      buttons(GREETING_BUTTONS);
    }
    scrollDown();
    setTimeout(() => input.focus({ preventScroll: true }), 50);
  }

  function close() {
    overlay.classList.remove('is-open');
    doc.body.classList.remove('lw-lock');
    fab.focus();
  }

  fab.addEventListener('click', open);
  overlay.querySelector('#lwClose').addEventListener('click', close);
  overlay.querySelector('#lwBackdrop').addEventListener('click', close);
  overlay.querySelector('#lwMenu').addEventListener('click', () => act('☰ Главное меню'));
  overlay.querySelector('#lwForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    act(text);
  });
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('is-open')) close();
  });
}

if (typeof document !== 'undefined') {
  const start = () => {
    let storage = null;
    try { storage = window.localStorage; } catch { /* хранилище недоступно */ }
    initLandingWidget(document, storage);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
