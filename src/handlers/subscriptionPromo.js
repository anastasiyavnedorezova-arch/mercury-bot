// Оплата подписки в боте и веб-чате: тарифы, ввод промокода, ссылка на оплату ЮKassa.
// Модуль не обращается к базе напрямую: нужная база и функция создания платежа передаются параметрами —
// так его проверяют тесты без боевых настроек (боевые значения подставляет subscription.js).
import { userStates } from '../state.js';
import { createPayment } from '../payments/yookassa.js';
import { checkPromo, priceWithPromo, tooManyChecks, PROMO_MESSAGES } from '../payments/promo.js';
import { baseUrl } from '../emails/config.js';

export const PLANS = {
  buy_1month:   { months: 1,  label: '1 месяц — 399 ₽' },
  buy_6months:  { months: 6,  label: '6 месяцев — 1 995 ₽ (платишь за 5, 6-й в подарок)' },
  buy_12months: { months: 12, label: '12 месяцев — 3 990 ₽ (платишь за 10, 2 месяца в подарок)' },
};

const MONTHS_WORD = { 1: 'месяц', 6: 'месяцев', 12: 'месяцев' };
const rub = (n) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₽`;
// В Markdown-сообщении подчёркивание в коде промокода (MY_CODE) сломало бы разметку
const escMd = (s) => String(s).replace(/([_*`\[])/g, '\\$1');

const MENU_BUTTON = [{ text: '☰ Главное меню', callback_data: 'menu:main' }];
const PROMO_BUTTONS = [
  [{ text: 'Продолжить без промокода', callback_data: 'buy_nopromo' }],
  [{ text: 'Отмена', callback_data: 'cancel_payment' }],
];

/** Создаёт платёж в ЮKassa и присылает ссылку именно на него: подписка включится тому, кто платил. */
export async function showPaymentLink(bot, chatId, planKey, userId, email, { promo = null, create = createPayment } = {}) {
  const { months, label } = PLANS[planKey];
  const r = await create({ months, userId, email, returnUrl: `${baseUrl()}/cabinet/profile?paid=1`, ...(promo ? { promo } : {}) });
  if (!r.ok) {
    await bot.sendMessage(
      chatId,
      r.reason === 'not_configured'
        ? 'Оплата временно недоступна. Попробуй чуть позже 🙏'
        : r.reason === 'promo_not_applicable'
          ? PROMO_MESSAGES.not_applicable
          : 'Не получилось создать платёж. Попробуй ещё раз через минуту или напиши нам через «Обратная связь» 🙏',
      { reply_markup: { inline_keyboard: [MENU_BUTTON] } }
    );
    return;
  }
  const shown = promo ? `${months} ${MONTHS_WORD[months]} — ${rub(priceWithPromo(months, promo.amountOff))}` : label;
  await bot.sendMessage(
    chatId,
    `Отлично! Для оплаты перейди по ссылке 👇\n\n` +
    `[Оплатить ${shown}](${r.url})\n\n` +
    (promo ? `🎟 Промокод ${escMd(promo.code)} применён: −${rub(promo.amountOff)}\n\n` : '') +
    `Чек придёт на email из твоего профиля. После оплаты подписка включится автоматически, это занимает около минуты 💛`,
    {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Я оплатил(а)', callback_data: `check_payment_${months}` }],
          [{ text: 'Отмена', callback_data: 'cancel_payment' }],
        ],
      },
    }
  );
}

/** Шаг перед оплатой: спрашиваем промокод. Состояние хранится в памяти, как у остальных шагов бота. */
export async function askPromo(bot, chatId, telegramId, { planKey, userId, email }) {
  userStates.set(telegramId, { awaitingPromo: true, selectedPeriod: planKey, userId, email, createdAt: Date.now() });
  await bot.sendMessage(
    chatId,
    'Есть промокод? 🎟\n\nПришли его одним сообщением. Если промокода нет, нажми «Продолжить без промокода».',
    { reply_markup: { inline_keyboard: PROMO_BUTTONS } }
  );
}

/** Кнопка «Продолжить без промокода». */
export async function continueWithoutPromo(bot, chatId, telegramId, { create = createPayment } = {}) {
  const state = userStates.get(telegramId);
  if (!state?.awaitingPromo) {
    await bot.sendMessage(chatId, 'Это окно уже закрыто. Выбери тариф заново 👇', {
      reply_markup: { inline_keyboard: [[{ text: 'Оформить подписку', callback_data: 'buy_subscription' }], MENU_BUTTON] },
    });
    return;
  }
  userStates.delete(telegramId);
  await showPaymentLink(bot, chatId, state.selectedPeriod, state.userId, state.email, { create });
}

/**
 * Сообщение пользователя, пока бот ждёт промокод. Возвращает true, если сообщение обработано здесь.
 * @param {object} deps  { db, create }
 */
export async function handlePromoMessage(bot, msg, { db, create = createPayment }) {
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;
  const state = userStates.get(telegramId);
  if (!state?.awaitingPromo) return false;

  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (!text || text.startsWith('/')) return false;

  const again = { reply_markup: { inline_keyboard: PROMO_BUTTONS } };
  if (tooManyChecks(state.userId)) {
    await bot.sendMessage(chatId, 'Слишком много попыток. Подожди минуту и пришли промокод ещё раз или продолжи без него 👇', again);
    return true;
  }

  let result;
  try {
    result = await checkPromo(db, text, state.userId);
  } catch (e) {
    console.error('[promo] bot check error:', e.message);
    await bot.sendMessage(chatId, 'Не получилось проверить промокод. Попробуй ещё раз или продолжи без него 👇', again);
    return true;
  }
  if (!result.ok) {
    await bot.sendMessage(chatId, `${PROMO_MESSAGES[result.reason] ?? PROMO_MESSAGES.not_found}\n\nПришли другой промокод или продолжи без него 👇`, again);
    return true;
  }
  const { months } = PLANS[state.selectedPeriod];
  if (priceWithPromo(months, result.promo.amountOff) === null) {
    await bot.sendMessage(chatId, `${PROMO_MESSAGES.not_applicable}\n\nПришли другой промокод или продолжи без него 👇`, again);
    return true;
  }

  userStates.delete(telegramId);
  await showPaymentLink(bot, chatId, state.selectedPeriod, state.userId, state.email, { promo: result.promo, create });
  return true;
}
