import { supabase } from '../db.js';
import { getUserAccess } from '../utils/access.js';
import { userStates } from '../state.js';
import { inTz } from '../utils/dateTz.js';
import { grantSubscription } from '../utils/grantSubscription.js';
import { yookassaConfigured } from '../payments/yookassa.js';
import { findRecentPaidSubscription } from '../payments/process.js';
import { PLANS, askPromo, continueWithoutPromo, handlePromoMessage } from './subscriptionPromo.js';
import { findUserIdByExternalId } from '../utils/findUser.js';
import { SUPPORT_EMAIL } from '../emails/config.js';

// Отмена подписки и возврат — по письму (условия возврата — в оферте, п. 6)
export const CANCEL_SUBSCRIPTION_TEXT =
  `Чтобы отменить подписку, напиши на ${SUPPORT_EMAIL} письмо с темой «Отменить подписку».\n\n` +
  'В письме укажи e-mail или ник в Telegram, к которому привязан аккаунт, и дату оплаты.\n\n' +
  'Деньги вернём за неиспользованные дни подписки. Условия возврата: https://finnikbot.ru/legal/offer';

const getUserId = (telegramId) => findUserIdByExternalId(supabase, telegramId);

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
      '✔️ редактирование и удаление записей\n' +
      '✔️ ежемесячная аналитика\n\n' +
      'Недоступно без подписки:\n' +
      '❌ бюджет и алерты\n' +
      '❌ до 3 целей с расчётом доходности\n' +
      '❌ аналитика по запросу\n' +
      '❌ свои категории\n\n' +
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
          [{ text: 'Отменить подписку', callback_data: 'cancel_subscription' }],
          [{ text: '☰ Главное меню', callback_data: 'menu:main' }],
        ],
      },
    }
  );
}

// Шаг после выбора тарифа (и email): спрашиваем промокод, затем даём ссылку на оплату — см. subscriptionPromo.js
export const handleSubscriptionPromoState = (bot, msg) => handlePromoMessage(bot, msg, { db: supabase });

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
  await askPromo(bot, chatId, telegramId, { planKey: selectedPeriod, userId, email });
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
      '💳 Оформление подписки «Финник · Деньги»\n\n' +
      'Подписка даёт полный доступ ко всем функциям:\n' +
      '✅ до 3 финансовых целей с расчётом доходности\n' +
      '✅ бюджет и алерты о превышении\n' +
      '✅ глубокая аналитика по запросу\n' +
      '✅ свои категории\n\n' +
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

  if (action === 'buy_nopromo') {
    await continueWithoutPromo(bot, chatId, telegramId);
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
      await askPromo(bot, chatId, telegramId, { planKey: action, userId: user.id, email: user.email });
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

  if (action === 'cancel_subscription') {
    await bot.sendMessage(chatId, CANCEL_SUBSCRIPTION_TEXT, {
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]] },
    });
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
