// Виджет чата на лендинге: пробный вход в «Финник · Деньги» без регистрации.
// Информационные кнопки онбординга отвечают так же, как настоящий бот (тексты — из
// src/handlers/onboarding.js). А когда посетитель хочет что-то сделать — записать трату,
// поставить цель или бюджет, написать сообщение — Финник просит войти или создать аккаунт
// и даёт ссылки на вход и регистрацию.
// Серверу ничего не отправляет: это статичная витрина, ничего не сохраняется.

export const SESSION_TOKEN_KEY = 'mercury_token';

export const GREETING_TEXT =
  'Привет! Я Финник — твой личный финансовый помощник 👋\n\n' +
  'Помогу тебе:\n' +
  '💰понять, куда уходят деньги;\n' +
  '🎯поставить финансовую цель и двигаться к ней;\n' +
  '📊видеть понятную аналитику по доходам и расходам.\n\n' +
  'Просто пиши мне в свободной форме — например, «продукты 2500» или «зарплата 120000» — и я всё запишу.\n\n' +
  'Рассказать подробнее о моих возможностях или сразу запишем первую трату?';

// 'auth' — действие, которое без аккаунта выполнить нельзя
export const AUTH = 'auth';

export const AUTH_TEXT =
  'Чтобы я мог это сделать, нужно войти в личный кабинет или создать аккаунт 🙌\n\n' +
  'Регистрация бесплатная, а 30 дней пробного периода со всеми функциями включатся сразу 🎁';

export const AUTH_LINKS = [
  { label: 'Создать аккаунт', href: '/cabinet/register', primary: true },
  { label: 'Войти', href: '/cabinet/login', primary: false },
];

export const GREETING_BUTTONS = [
  { label: 'Как записывать расходы и доходы?', to: 'how_to_record' },
  { label: 'Расскажи о целях', to: 'about_goals' },
  { label: 'Подробнее об аналитике', to: 'about_analytics' },
  { label: 'Зачем устанавливать бюджет?', to: 'about_budget' },
  { label: 'Записать первую трату', to: AUTH },
];

// Ответы на информационные кнопки — как в настоящем онбординге бота
export const FLOW = {
  how_to_record: {
    text:
      '💸 Учёт финансов — это моя основная работа. Я принимаю записи доходов и расходов в свободной форме, ' +
      'главное пиши мне о каждом поступлении или трате, а я уже сам определяю категорию и запишу 🙌\n\n' +
      'Например: «продукты 1800», «такси 450», «зарплата 120000»\n\n' +
      'Это безопасно. Все данные хранятся на защищённом сервере и не передаются третьим лицам. ' +
      'Я всегда здесь — просто напиши мне в любой момент.\n\n' +
      'Попробуй прямо сейчас 👇',
    buttons: [{ label: 'Записать первый расход или доход', to: AUTH }],
  },
  about_goals: {
    text:
      '🎯 Финансовая цель — это то, на что ты хочешь накопить в будущем. Например, купить квартиру, машину, на финансовую подушку и др.\n\n' +
      'От тебя потребуется сказать мне:\n' +
      '— Название твоей цели\n' +
      '— Когда ты хочешь её достичь (желательно месяц и год)\n' +
      '— Какая сумма тебе потребуется\n' +
      '— Сколько уже накоплено\n\n' +
      'Например:\n' +
      '— Купить квартиру\n' +
      '— Март 2035\n' +
      '— 10 000 000 рублей\n' +
      '— 1 000 000 рублей\n\n' +
      'Я рассчитаю, сколько понадобится откладывать каждый месяц с учётом инфляции, чтобы достичь цели в указанные сроки.\n\n' +
      'На бесплатном тарифе доступна одна финансовая цель и расчёт только с учётом инфляции. ' +
      'На платном тарифе — до трёх финансовых целей и расчёт с доходностью.\n\n' +
      'Запишем твою первую цель?',
    buttons: [
      { label: 'Поставить цель', to: AUTH },
      { label: 'Напомнить позже', to: 'goal_later' },
    ],
  },
  goal_later: {
    // В боте здесь «напомню позже»; посетителю без аккаунта напоминание отправить некуда
    text: 'Хорошо 💛 А пока можешь просто писать мне о расходах и доходах в свободной форме.',
  },
  about_analytics: {
    text:
      'Я умею делать аналитику расходов и доходов, когда ты делаешь записи:\n\n' +
      '📊 Сколько уже потрачено и какие категории расходов самые большие\n' +
      '📊 Прогресс достижения твоей финансовой цели\n' +
      '📊 Если у тебя задан бюджет расходов на месяц, то я рассчитаю темп расходов и спрогнозирую, остаёмся ли мы в рамках бюджета к концу месяца\n' +
      '📊 По итогам месяца ты получишь отчёт: сколько получено, сколько потрачено в разрезе категорий\n' +
      '📊 Спустя 3 месяца я смогу проанализировать как растут расходы относительно доходов\n\n' +
      'Бесплатно каждый месяц я предоставляю отчёт о тратах по категориям. Глубокая аналитика и прогноз доступны в подписке.\n\n' +
      'Чтобы у меня была база для анализа, просто начни записывать свои расходы и доходы',
    buttons: [
      { label: 'Записать расход или доход', to: AUTH },
      { label: 'Позже', to: 'analytics_later' },
    ],
  },
  analytics_later: {
    text: 'Хорошо 💛 Просто пиши мне о расходах и доходах — аналитика будет накапливаться сама.',
  },
  about_budget: {
    text:
      'Бюджет — это функция, которая помогает оставаться в рамках расходов в течение месяца 💛\n\n' +
      'Когда у тебя задан бюджет расходов на месяц, я могу помочь держать его под контролем:\n' +
      '✔️ Я буду отслеживать темп расходов\n' +
      '✔️ Я предупрежу тебя, если темп расходов будет слишком высок и появляется риск перерасхода к концу месяца\n' +
      '✔️ В любой момент ты сможешь посмотреть аналитику расходов и скорректировать траты\n\n' +
      'Функция ведения бюджета доступна в рамках подписки. Но у тебя есть 30 дней бесплатного доступа ко всем возможностям — ' +
      'включая бюджет, уведомления и глубокую аналитику. Попробуешь?',
    buttons: [
      { label: 'Задать бюджет', to: AUTH },
      { label: 'Пока не надо', to: 'budget_later' },
    ],
  },
  budget_later: {
    text: 'Хорошо, без проблем. Давай тогда начнём с простого — просто пиши мне о расходах и доходах в свободной форме 💛',
  },
};

// Что ответить на нажатие кнопки (to = ключ из FLOW или AUTH) и на любое другое действие
// (сообщение, меню): информационные кнопки — ответ бота, всё остальное — «войди или зарегистрируйся».
export function replyFor(to) {
  const node = FLOW[to];
  if (node) return { text: node.text, buttons: node.buttons || [], links: [] };
  return { text: AUTH_TEXT, buttons: [], links: AUTH_LINKS };
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

  function buttons(list) {
    const row = doc.createElement('div');
    row.className = 'lw-cta-wrap';
    for (const item of list) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = 'lw-cta-btn';
      b.textContent = item.label;
      b.addEventListener('click', () => act(item.label, item.to));
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

  // Действие посетителя: показываем его как сообщение пользователя и отвечаем.
  // to — куда ведёт кнопка; для сообщений и меню to не задан — это уже «действие», нужен аккаунт
  function act(text, to = AUTH) {
    if (busy) return;
    busy = true;
    bubble(text, 'user');
    const dots = typing();
    scrollDown();
    setTimeout(() => {
      dots.remove();
      const r = replyFor(to);
      const answer = bubble(r.text, 'bot');
      if (r.buttons.length) buttons(r.buttons);
      if (r.links.length) links(r.links);
      // Длинный ответ читают с начала: показываем его верх, а не конец (короткий упрётся в низ сам)
      chat.scrollTop = Math.max(0, answer.offsetTop - 12);
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
