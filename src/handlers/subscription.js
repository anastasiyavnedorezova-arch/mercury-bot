import { supabase } from '../db.js';
import { getUserAccess } from '../utils/access.js';
import { userStates } from '../state.js';
import { inTz } from '../utils/dateTz.js';
import { grantSubscription } from '../utils/grantSubscription.js';
import { createPayment, yookassaConfigured } from '../payments/yookassa.js';
import { findRecentPaidSubscription } from '../payments/process.js';
import { baseUrl } from '../emails/config.js';

async function getUserId(telegramId) {
  const { data } = await supabase
    .from('users')
    .select('id')
    .eq('external_id', String(telegramId))
    .single();
  return data?.id ?? null;
}

function formatDate(isoStr) {
  const d = inTz(new Date(isoStr));
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function daysLeft(isoStr) {
  const diff = new Date(isoStr).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / 86_400_000));
}

function isValidEmail(str) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str.trim());
}

export async function showSubscription(bot, chatId, telegramId) {
  const userId = await getUserId(telegramId);
  if (!userId) {
    await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start 🙏');
    return;
  }

  const access = await getUserAccess(userId);

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('status, ends_at')
    .eq('user_id', userId)
    .order('ends_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (access === 'free') {
    await bot.sendMessage(
      chatId,
      '💳 Твой тариф: Бесплатный\n\n' +
      'Доступно:\n' +
      '✔️ 1 финансовая цель\n' +
      '✔️ учёт доходов и расходов\n' +
      '✔️ ежемесячная аналитика\n\n' +
      'Недоступно без подписки:\n' +
      '❌ бюджет и алерты\n' +
      '❌ до 3 целей с расчётом доходности\n' +
      '❌ аналитика по запросу\n' +
      '❌ редактирование и удаление записей\n\n' +
      'У тебя есть возможность попробовать все функции бесплатно 30 дней 💛',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Активировать пробный период', callback_data: 'onboarding:activate_trial' }],
            [{ text: 'Оформить подписку', callback_data: 'buy_subscription' }],
          ],
        },
      }
    );
    return;
  }

  if (access === 'trial') {
    await bot.sendMessage(
      chatId,
      '💳 Твой тариф: Пробный период\n\n' +
      '✅ Доступны все функции\n' +
      `📅 Действует до: ${formatDate(sub.ends_at)}\n` +
      `⏳ Осталось: ${daysLeft(sub.ends_at)} дней`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Оформить подписку', callback_data: 'buy_subscription' }],
            [{ text: '☰ Главное меню', callback_data: 'menu:main' }],
          ],
        },
      }
    );
    return;
  }

  // access === 'active'
  await bot.sendMessage(
    chatId,
    '💳 Твой тариф: Подписка активна ✅\n\n' +
    `📅 Действует до: ${formatDate(sub.ends_at)}\n` +
    `⏳ Осталось: ${daysLeft(sub.ends_at)} дней`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Продлить подписку', callback_data: 'buy_subscription' }],
          [{ text: '☰ Главное меню', callback_data: 'menu:main' }],
        ],
      },
    }
  );
}

const PLANS = {
  buy_1month:   { months: 1,  label: '1 месяц — 399 ₽' },
  buy_6months:  { months: 6,  label: '6 месяцев — 1 995 ₽ (платишь за 5, 6-й в подарок)' },
  buy_12months: { months: 12, label: '12 месяцев — 3 990 ₽ (платишь за 10, 2 месяца в подарок)' },
};

// Создаёт платёж в ЮKassa и присылает ссылку именно на него: подписка включится тому, кто платил, email вводить не нужно.
async function showPaymentLink(bot, chatId, planKey, userId, email) {
  const { months, label } = PLANS[planKey];
  const r = await createPayment({ months, userId, email, returnUrl: `${baseUrl()}/cabinet/profile?paid=1` });
  if (!r.ok) {
    await bot.sendMessage(
      chatId,
      r.reason === 'not_configured'
        ? 'Оплата временно недоступна. Попробуй чуть позже 🙏'
        : 'Не получилось создать платёж. Попробуй ещё раз через минуту или напиши нам через «Обратная связь» 🙏',
      { reply_markup: { inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]] } }
    );
    return;
  }
  await bot.sendMessage(
    chatId,
    `Отлично! Для оплаты перейди по ссылке 👇\n\n` +
    `[Оплатить ${label}](${r.url})\n\n` +
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

export async function handleSubscriptionEmailState(bot, msg) {
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;
  const state = userStates.get(telegramId);

  if (!state?.awaitingEmail) return false;

  const text = msg.text?.trim() ?? '';

  if (!isValidEmail(text)) {
    await bot.sendMessage(chatId,
      'Не похоже на email. Попробуй ещё раз 👇\n' +
      'Например: ivan@gmail.com');
    return true;
  }

  const email = text.toLowerCase();
  const { selectedPeriod } = state;
  userStates.delete(telegramId);

  // Сохраняем email в таблице users
  await supabase
    .from('users')
    .update({ email })
    .eq('external_id', String(telegramId));

  const userId = await getUserId(telegramId);
  if (!userId) {
    await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start 🙏');
    return true;
  }
  await showPaymentLink(bot, chatId, selectedPeriod, userId, email);
  return true;
}

export async function handleSubscriptionCallback(bot, query) {
  const chatId = query.message.chat.id;
  const telegramId = query.from.id;
  const action = query.data;

  await bot.answerCallbackQuery(query.id);

  if (action === 'buy_subscription') {
    await bot.sendMessage(
      chatId,
      '💳 Оформление подписки Финника\n\n' +
      'Подписка даёт полный доступ ко всем функциям:\n' +
      '✅ до 3 финансовых целей с расчётом доходности\n' +
      '✅ бюджет и алерты о превышении\n' +
      '✅ глубокая аналитика по запросу\n' +
      '✅ редактирование и удаление записей\n\n' +
      'Выбери период:',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '1 месяц — 399 ₽', callback_data: 'buy_1month' }],
            [{ text: '6 месяцев — 1 995 ₽ (платишь за 5)', callback_data: 'buy_6months' }],
            [{ text: '12 месяцев — 3 990 ₽ (платишь за 10)', callback_data: 'buy_12months' }],
          ],
        },
      }
    );
    return;
  }

  if (PLANS[action]) {
    if (!yookassaConfigured()) {
      await bot.sendMessage(chatId, 'Оплата временно недоступна. Попробуй чуть позже 🙏');
      return;
    }
    const { data: user } = await supabase
      .from('users')
      .select('id, email')
      .eq('external_id', String(telegramId))
      .maybeSingle();
    if (!user) {
      await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start 🙏');
      return;
    }
    // Если email уже есть в профиле — сразу создаём платёж, иначе спрашиваем (он нужен для чека)
    if (user.email) {
      await showPaymentLink(bot, chatId, action, user.id, user.email);
      return;
    }
    userStates.set(telegramId, { awaitingEmail: true, selectedPeriod: action });
    await bot.sendMessage(
      chatId,
      'Укажи email, на него придёт чек от ЮKassa 📧'
    );
    return;
  }

  if (action.startsWith('check_payment_')) {
    // Если оплата уже прошла и подписка включена — говорим об этом сразу
    const userId = await getUserId(telegramId);
    const paid = userId ? await findRecentPaidSubscription(supabase, userId).catch(() => null) : null;
    if (paid) {
      await bot.sendMessage(
        chatId,
        `✅ Оплата прошла, подписка активна.\n📅 Действует до: ${formatDate(paid.endsAt)}\n\nСпасибо! 💛`,
        { reply_markup: { inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]] } }
      );
      return;
    }
    await bot.sendMessage(
      chatId,
      'Проверяю оплату... ⏳\n\n' +
      'Если оплата прошла — я активирую подписку в течение нескольких минут. ' +
      'Если возникли вопросы — напиши нам через Обратная связь 💛',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Обратная связь', callback_data: 'menu:feedback' }],
            [{ text: '☰ Главное меню', callback_data: 'menu:main' }],
          ],
        },
      }
    );
    return;
  }

  if (action === 'cancel_payment') {
    userStates.delete(telegramId);
    await showSubscription(bot, chatId, telegramId);
    return;
  }
}

export async function activateSubscription(bot, targetExternalId, months) {
  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('external_id', String(targetExternalId))
    .eq('channel', 'telegram')
    .single();

  if (!user) return { ok: false, reason: 'user not found' };

  let endsAt;
  try {
    ({ endsAt } = await grantSubscription(user.id, months));
  } catch (e) {
    console.error('[subscription] activate failed:', e.message);
    return { ok: false, reason: 'db error' };
  }

  await bot.sendMessage(
    targetExternalId,
    '🎉 Подписка активирована!\n\n' +
    `📅 Действует до: ${formatDate(endsAt.toISOString())}\n\n` +
    'Теперь тебе доступны все функции Финника.\n' +
    'Спасибо что выбрал(а) нас 💛',
    {
      reply_markup: {
        inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]],
      },
    }
  );

  return { ok: true };
}
