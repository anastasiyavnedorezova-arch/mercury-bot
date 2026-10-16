// Содержание писем (из макетов Figma). Каждое письмо — функция, которая возвращает список блоков.
// Тексты переносим как в макете. Ссылки заданы владельцем продукта.
import { PRICES } from '../utils/plans.js';
import { t, P, buttons, card, quotes, banner, COLORS, layoutHtml, layoutText } from './render.js';
import { PAY_URLS, TESTIMONIALS_CONFIRMED, baseUrl, SUPPORT_EMAIL } from './config.js';
import { escapeHtml } from '../utils/email.js';
import { unsubscribeUrl } from './unsubscribe.js';

const NB = ' ';
const rub = (n) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, NB)}${NB}₽`;

// ── Общие блоки ───────────────────────────────────────────────────────────

const hello = P('Привет!');

function trialCard(links) {
  return card([
    P('🎁 У тебя активирован пробный период и открыты все функции подписки абсолютно бесплатно 🎁', { align: 'center', size: 18, b: true }),
    P('Успей попробовать все по максимуму 🤩🤩🤩', { align: 'center', size: 18 }),
    P(
      [
        t('Пробный период активирован на 30 календарных дней. Остаток действия пробного периода можно посмотреть ', { c: COLORS.gray, i: true }),
        t('в личном кабинете', { href: links.profile, i: true }),
      ],
      { align: 'center', size: 14 }
    ),
  ]);
}

function installCard(links) {
  return card(
    [
      P(
        [
          t('Чтобы доступ к чату с Финником всегда был под рукой, установи виджет прямо на экран своего телефона ', { c: COLORS.gray, i: true }),
          t('по этой инструкции.', { href: links.howTo, i: true }),
        ],
        { align: 'center', size: 14 }
      ),
    ],
    { pad: 20, radius: 20 }
  );
}

// Тарифы: цены берём из plans.js, чтобы не разойтись с сайтом и ботом
function pricesParagraph({ header }) {
  const full = (m) => PRICES[1] * m;
  const runs = [];
  if (header) runs.push(t('Выбирай удобный тариф:\n', { b: true }));
  runs.push(t(`1 месяц — ${rub(PRICES[1])}\n6 месяцев — `, { b: true }));
  runs.push(t(rub(full(6)), { b: true, s: true, c: COLORS.gray, tx: '' }));
  runs.push(t(` ${rub(PRICES[6])}\n`, { b: true, c: COLORS.red, tx: `${rub(PRICES[6])} (вместо ${rub(full(6))})\n` }));
  runs.push(t('Платишь за 5 месяцев, получаешь 1 месяц в подарок!\n', { i: true, z: 12, lh: 18 }));
  runs.push(t('12 месяцев — ', { b: true }));
  runs.push(t(rub(full(12)), { b: true, s: true, c: COLORS.gray, tx: '' }));
  runs.push(t(` ${rub(PRICES[12])}\n`, { b: true, c: COLORS.red, tx: `${rub(PRICES[12])} (вместо ${rub(full(12))})\n` }));
  runs.push(t('Платишь за 10 месяцев, получаешь 2 месяца в подарок!', { i: true, z: 12, lh: 18 }));
  return P(runs, { lh: 24 });
}

const noAutoRenew = P('Автоматического продления нет. Когда оплачивать следующий период, решаешь только ты.', { i: true });

function payButtons(bgs) {
  return buttons([
    { label: 'Оплатить 1 мес', url: PAY_URLS[1], bg: bgs[0] },
    { label: 'Оплатить 6 мес', url: PAY_URLS[6], bg: bgs[1] },
    { label: 'Оплатить 12 мес', url: PAY_URLS[12], bg: bgs[2] },
  ]);
}

const DARK3 = [COLORS.dark, COLORS.dark, COLORS.dark];
const BLUE3 = [COLORS.blue, COLORS.blue, COLORS.blue];

const FREE_LEFT = P('Но Бот всегда рядом. У тебя бесплатно останется:\n✔️ 1 финансовая цель,\n✔️ ведение доходов и расходов,\n✔️ общая аналитика по итогам месяца.', { lh: 24 });
const PRO_LIST = (lead) =>
  P(
    `${lead}\n✅ редактирование и удаление записей,\n✅ установка и расчет до 3 финансовых целей,\n✅ перерасчет целей с учетом прогнозируемой доходности (на случай, если ты инвестируешь или откладываешь на вклад под проценты),\n✅ ведение бюджета,\n✅ глубокая аналитика в любой момент по запросу.`,
    { lh: 24 }
  );

// ── Письма ────────────────────────────────────────────────────────────────
// kind: 'marketing' — только тем, кто согласился на письма; 'service' — всем, у кого есть почта.
// unsub: false — в подвале нет ссылки на отписку (чисто транзакционное письмо).

export const LETTERS = {
  // №1 Регистрация
  welcome: {
    number: '#1', title: 'Регистрация', kind: 'service', unsub: true, reason: 'registered',
    subject: 'Привет от Финника! Давай начнем 😉',
    preheader: 'Финансы начинаются с одной записи',
    blocks: (l) => [
      banner('registration.png', 'Добро пожаловать! 30 дней полного доступа уже у тебя!'),
      card([
        P('Привет! Я Финник, твой помощник в личных финансах 👋'),
        P([t('Со мной можно записывать доходы и расходы, следить за бюджетом и копить на важные цели. Без таблиц и сложных форм: '), t('просто напиши мне о покупке обычными словами.', { b: true })]),
        P('Например: «Продукты 850 ₽». Я сохраню расход, и ты сможешь вернуться к нему позже.', { i: true }),
        P([t('Написать мне можно как в чате в личном кабинете, так и в Telegram. '), t('Все записи я сохраню для тебя в одной таблице.', { b: true })]),
        P('Готов начать?'),
        buttons([{ label: 'Открыть Финника', url: l.bot, bg: COLORS.green }]),
      ]),
      trialCard(l),
      installCard(l),
    ],
  },

  // №2 Напоминание-активация
  activation: {
    number: '#2', title: 'Напоминание-активация', kind: 'marketing', unsub: true, reason: 'opted_in',
    subject: 'Давай сделаем первую запись ✍️',
    preheader: 'Одного сообщения достаточно, чтобы начать вести учет.',
    blocks: (l) => [
      banner('activation.png', 'Сделаем первую запись! Твой путь к контролю за финансами начинается сейчас'),
      card([
        hello,
        P([t('Вижу, что ты еще не сделал ни одной записи. Не нужно вспоминать все расходы за месяц. '), t('Начни с того, что произошло сегодня:', { b: true }), t(' напиши мне о покупке или доходе, как написал бы другу.')]),
        P('Например: «Кофе 250 ₽» или «Получил зарплату 80 000 ₽»', { i: true }),
        P('Я определю сумму и категорию. Если что-то захочется поправить, запись можно отредактировать или удалить.'),
        P('Сделаем первый шаг? 👇'),
        buttons([{ label: 'Добавить первую запись', url: l.bot, bg: COLORS.dark }]),
      ]),
      trialCard(l),
      installCard(l),
    ],
  },

  // №2.2 Помощь + отзывы (отправка заблокирована, пока TESTIMONIALS_CONFIRMED = false)
  help: {
    number: '#2.2', title: 'Помощь + отзывы', kind: 'marketing', unsub: true, reason: 'opted_in',
    requiresTestimonials: true,
    subject: 'Посмотри, что пишут пользователи',
    preheader: 'Нужна помощь? Мы рядом',
    blocks: (l) => [
      banner('help.png', 'Почитай, что пишут те, кто уже пользуется Финником'),
      card([
        hello,
        P('Хочу сегодня поделиться обратной связью от пользователей, кто уже ведет свои личные финансы с Финником:'),
      ]),
      quotes([
        [
          '«Думал, придётся долго настраивать. Написал “обед 450” - и первая запись уже готова. Вообще не надо думать, куда и как записать - удобно».',
          '«Таблицы я всегда забрасывала или забывала... Одну карту, вторую пока проверишь, надоедает. А вот отправлять сообщение после покупки оказалось сильно проще».',
        ],
        [
          '«Казалось, я и так знаю свои расходы. Когда увидела их по категориям, поняла, сколько и где утекает незаметно».',
          '«Не хотелось восстанавливать расходы за месяц. Закинула скрин истории из банка, бот все сам расшифровал и записал».',
        ],
      ]),
      card([
        P('💬 Нужна помощь? Мы рядом', { align: 'center', size: 18, b: true }),
        P('Если не знаешь, с чего начать, или что-то не получается, всегда можешь написать в поддержку. Тебе ответит живой человек и поможет разобраться.', { align: 'center' }),
        buttons([{ label: 'Написать в поддержку', url: `mailto:${SUPPORT_EMAIL}`, bg: COLORS.dark }]),
      ]),
      installCard(l),
    ],
  },

  // №3 Возможности Финника
  features: {
    number: '#3', title: 'Возможности Финника', kind: 'marketing', unsub: true, reason: 'opted_in',
    subject: 'Что попробовать во время пробного периода 🔎',
    preheader: 'Три шага, которые помогут увидеть пользу от твоих записей.',
    blocks: (l) => [
      banner('options.png', 'Три шага, которые помогут увидеть пользу от твоих записей: категории, бюджет, цели'),
      card([
        P('Привет! Пока действует пробный период, попробуй превратить записи о тратах в понятный план:'),
        P([t('💸 Установи бюджет на месяц. ', { b: true }), t('Бот покажет, сколько ты уже потратил, и предупредит, если есть риск выйти за лимит.')]),
        P([t('🎯 Поставь цель. ', { b: true }), t('Расскажи, на что и к какому сроку хочешь накопить. Бот рассчитает, сколько нужно откладывать каждый месяц, и поможет следить за прогрессом.')]),
        P([t('🗂️ Добавь свои собственные категории. ', { b: true }), t('Не забудь добавить слова-подсказки, чтобы бот лучше определял твои расходы или доходы в новые категории.')]),
        P([t('Для активации пробного периода платить не нужно. После его завершения подписка НЕ оформится автоматически — ', { i: true }), t('ты решаешь, нужен ли тебе полный доступ дальше', { i: true, b: true })]),
        P('С чего начнешь?'),
        buttons([
          { label: 'Установить бюджет', url: l.budget, bg: COLORS.blue },
          { label: 'Поставить цель', url: l.goals, bg: COLORS.blue },
          { label: 'Добавить категории', url: l.categories, bg: COLORS.blue },
        ]),
      ]),
      installCard(l),
    ],
  },

  // №4.1 Пробный период: осталось 5 дней
  trial5: {
    number: '#4.1', title: 'Пробный период: осталось 5 дней', kind: 'service', unsub: true, reason: 'service_trial',
    subject: 'Ещё 5 дней, чтобы попробовать всё 🔎',
    preheader: 'Поставь цель, настрой бюджет и загляни в аналитику — полный доступ пока открыт.',
    blocks: (l) => [
      banner('trial-5d.png', 'Ой! У тебя осталось 5 дней пробного периода'),
      card([
        hello,
        P('Твой пробный период скоро закончится — осталось 5 дней 🔔', { b: true }),
        P('Чтобы сохранить доступ ко всем возможностям бота, можно заранее продлить подписку по кнопкам ниже:'),
        pricesParagraph({ header: true }),
        noAutoRenew,
        payButtons(DARK3),
      ]),
      installCard(l),
    ],
  },

  // №4.2 Пробный период: остался 1 день
  trial1: {
    number: '#4.2', title: 'Пробный период: остался 1 день', kind: 'service', unsub: true, reason: 'service_trial',
    subject: 'Последний день пробного периода ⏳',
    preheader: 'Хочешь сохранить полный доступ? Выбери подписку — автоматических списаний нет.',
    blocks: (l) => [
      banner('trial-1d.png', 'Ой! У тебя остался 1 день пробного периода'),
      card([
        hello,
        P('Завтра закончится твой пробный период 🔔', { b: true }),
        FREE_LEFT,
        PRO_LIST('Если захочешь вернуть полный доступ по подписке:'),
        pricesParagraph({ header: true }),
        noAutoRenew,
        payButtons(DARK3),
      ]),
      installCard(l),
    ],
  },

  // №5 Пробный период закончился
  trialover: {
    number: '#5', title: 'Пробный период закончился', kind: 'service', unsub: true, reason: 'service_trial',
    subject: 'Пробный период закончился. Что дальше? 🙂',
    preheader: 'Продолжай бесплатно или верни полный доступ по подписке.',
    blocks: (l) => [
      banner('trial-over.png', 'Пробный период завершен. Но у тебя сохранен доступ к некоторым функциям и твоей истории'),
      card([
        hello,
        P('Твой пробный период завершился. Ты по-прежнему можешь бесплатно записывать доходы и расходы, смотреть историю, вести одну финансовую цель и получать ежемесячную аналитику.'),
        P('Если тебе пригодились бюджет на месяц, предупреждения о расходах, аналитика в любой момент или несколько целей сразу, эти возможности доступны по подписке. С ней также можно создавать свои категории и отправлять голосовые сообщения и изображения в Telegram.'),
        pricesParagraph({ header: true }),
        noAutoRenew,
        payButtons(BLUE3),
      ]),
      installCard(l),
    ],
  },

  // Подписка активирована
  sub_started: {
    number: '—', title: 'Подписка активирована', kind: 'service', unsub: false, reason: 'service_payment',
    subject: 'Готово! Подписка активирована 🎉',
    preheader: 'Все возможности Финника доступны — продолжим заботиться о твоих финансах.',
    blocks: (l, v = {}) => [
      banner('sub-started.png', 'Подписка активирована! Теперь тебе доступен полный функционал'),
      card([
        P('Готово! Твоя подписка активирована 🎉', { b: true }),
        ...(fmtDate(v.endsAt) ? [P(`Подписка действует до ${fmtDate(v.endsAt)}.`, { b: true })] : []),
        P('Теперь тебе доступны все возможности Финника: бюджет и предупреждения о тратах, аналитика в любой момент, до трёх финансовых целей и другие полезные функции.'),
        P('Продолжай записывать расходы и доходы — Бот поможет держать финансы под контролем 💛', { b: true }),
        P('Проверить, сколько оплаченных дней подписки осталось, можно в личном кабинете в разделе «Мой профиль»', { i: true }),
        buttons([{ label: 'В личный кабинет', url: l.profile, bg: COLORS.dark }]),
      ]),
      installCard(l),
    ],
  },

  // Подписка: осталось 5 дней
  sub5: {
    number: '—', title: 'Подписка: осталось 5 дней', kind: 'service', unsub: true, reason: 'service_sub',
    subject: 'Твоя подписка закончится через 5 дней',
    preheader: 'Продли её заранее, чтобы продолжать пользоваться всеми возможностями Финника.',
    blocks: (l) => [
      banner('sub-5d.png', 'Ой! У тебя осталось 5 дней до окончания подписки'),
      card([
        hello,
        P('До окончания оплаченной подписки осталось 5 дней 🔔'),
        P('Чтобы сохранить доступ ко всем возможностям бота, можно заранее продлить подписку по кнопкам ниже:'),
        pricesParagraph({ header: true }),
        noAutoRenew,
        payButtons(DARK3),
      ]),
      installCard(l),
    ],
  },

  // Подписка: остался 1 день
  sub1: {
    number: '—', title: 'Подписка: остался 1 день', kind: 'service', unsub: true, reason: 'service_sub',
    subject: 'До конца подписки — 1 день ⏳',
    preheader: 'Для полного доступа на следующий период продли подписку — автоматически она не продлевается.',
    blocks: (l) => [
      banner('sub-1d.png', 'Ой! У тебя остался 1 день до окончания подписки'),
      card([
        hello,
        P('Завтра закончится твоя оплаченная подписка 🔔'),
        FREE_LEFT,
        PRO_LIST('Если захочешь вернуть полный доступ, в подписке будут открыты:'),
        pricesParagraph({ header: true }),
        noAutoRenew,
        payButtons(DARK3),
      ]),
      installCard(l),
    ],
  },

  // После окончания оплаченной подписки
  subover: {
    number: '—', title: 'Подписка закончилась', kind: 'service', unsub: true, reason: 'service_sub',
    subject: 'Продолжим вести финансы вместе?',
    preheader: 'Полный доступ к бюджету, целям и аналитике можно вернуть в любой момент.',
    blocks: (l) => [
      banner('sub-over.png', 'Подписка закончилась. У тебя остается доступ к бесплатным функциям и твоей истории'),
      card([
        hello,
        P('Срок твоей подписки закончился. Если сейчас тебе достаточно базового учёта, продолжай записывать доходы и расходы бесплатно.'),
        P('А если хочешь снова установить бюджет на месяц, получать предупреждения о темпе трат и смотреть аналитику в любой момент, полный доступ можно вернуть:'),
        pricesParagraph({ header: false }),
        P('Выбирай срок, который подходит тебе сейчас. Автоматического продления нет 🙂', { i: true }),
        payButtons([COLORS.blue, COLORS.green, COLORS.blue]),
      ]),
      installCard(l),
    ],
  },
};

// №2.1 — повтор №2 с другой темой и прехедером (уходит тем, кто всё ещё не сделал ни одной записи)
LETTERS.activation2 = {
  ...LETTERS.activation,
  number: '#2.1',
  subject: 'Финансы начинаются с одной записи ✍️',
  preheader: 'Начать проще, чем кажется',
};

export const LETTER_KEYS = Object.keys(LETTERS);
export const isMarketing = (key) => LETTERS[key]?.kind === 'marketing';

// Есть ли в письме кнопки «Оплатить…» (такие письма нельзя слать, пока нет платёжных ссылок)
export function needsPay(key) {
  const def = LETTERS[key];
  if (!def) return false;
  const hasPay = (b) => b.type === 'buttons' && b.items.some((it) => /^Оплатить/.test(it.label));
  return def.blocks(siteLinks()).some((b) => hasPay(b) || (b.type === 'card' && b.children.some(hasPay)));
}

/** «13 декабря 2026» по Москве; пустая строка, если даты нет или она некорректна. */
export function fmtDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' }).formatToParts(date);
  const get = (type) => parts.find((x) => x.type === type)?.value ?? '';
  return `${get('day')} ${get('month')} ${get('year')}`;
}

export function siteLinks(base = baseUrl()) {
  return {
    bot: `${base}/cabinet/bot`,
    profile: `${base}/cabinet/profile`,
    budget: `${base}/cabinet/budget`,
    goals: `${base}/cabinet/goals`,
    categories: `${base}/cabinet/categories`,
    howTo: `${base}/cabinet/how-to`,
  };
}

const REASONS = {
  registered: 'Ты получил это письмо, потому что зарегистрировался в сервисе «Финник · Деньги».',
  opted_in: 'Ты получил это письмо, потому что согласился получать письма и уведомления об обновлениях «Финник · Деньги».',
  service_trial: 'Это сервисное письмо о сроке твоего пробного периода в «Финник · Деньги».',
  service_sub: 'Это сервисное письмо о сроке твоей подписки на «Финник · Деньги».',
  service_payment: 'Это сервисное письмо об оплате подписки на «Финник · Деньги».',
};
const REQUISITES = 'ИП Захарова А. В., ИНН 504230305760, ОГРНИП 326508100607489';

/**
 * Собирает письмо.
 * @param {string} key  ключ из LETTERS
 * @param {object} [o]
 * @param {string} [o.userId]       нужен для персональной ссылки на отписку
 * @param {string} [o.bannerBase]   откуда грузить баннеры (по умолчанию наш сайт)
 * @param {string} [o.unsubUrl]     готовая ссылка на отписку (для превью)
 * @returns {{ subject: string, html: string, text: string }}
 */
export function renderLetter(key, o = {}) {
  const def = LETTERS[key];
  if (!def) throw new Error(`unknown letter: ${key}`);
  const base = baseUrl();
  const links = siteLinks(base);
  const blocks = def.blocks(links, o.vars ?? {});
  const bannerBase = (o.bannerBase ?? `${base}/email/banners`).replace(/\/+$/, '');

  const reason = REASONS[def.reason];
  let unsub = null;
  if (def.unsub) unsub = o.unsubUrl ?? (o.userId ? unsubscribeUrl(o.userId, base) : `${base}/unsubscribe`);

  const footerHtmlParts = [escapeHtml(reason)];
  const footerTextParts = [reason];
  if (unsub) {
    const note = def.kind === 'marketing' ? '' : ' Сервисные письма о сроке доступа это не отключит.';
    footerHtmlParts.push(`<a href="${escapeHtml(unsub)}" style="color:${COLORS.footer};text-decoration:underline">Отписаться от писем о возможностях «Финник · Деньги»</a>.${escapeHtml(note)}`);
    footerTextParts.push(`Отписаться от писем о возможностях «Финник · Деньги»:\n${unsub}${note ? `\n${note.trim()}` : ''}`);
  }
  footerHtmlParts.push(`${escapeHtml(REQUISITES)} · <a href="mailto:${SUPPORT_EMAIL}" style="color:${COLORS.footer};text-decoration:underline">${SUPPORT_EMAIL}</a>`);
  footerTextParts.push(`${REQUISITES}, ${SUPPORT_EMAIL}`);

  const html = layoutHtml({
    subject: def.subject,
    preheader: def.preheader,
    blocks,
    footerHtml: footerHtmlParts.join('<br>'),
    bannerBase,
  });
  const text = layoutText({ blocks, footerText: footerTextParts.join('\n') });
  return { subject: def.subject, html, text };
}

export { TESTIMONIALS_CONFIRMED };
