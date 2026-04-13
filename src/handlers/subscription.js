import { supabase } from '../db.js';
import { getUserAccess } from '../utils/access.js';

async function getUserId(telegramId) {
  const { data } = await supabase
    .from('users')
    .select('id')
    .eq('external_id', String(telegramId))
    .eq('channel', 'telegram')
    .single();
  return data?.id ?? null;
}

function formatDate(isoStr) {
  const d = new Date(isoStr);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function daysLeft(isoStr) {
  const diff = new Date(isoStr).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / 86_400_000));
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
  buy_1month:   {
    label: '1 месяц — 499 ₽',
    link: (telegramId) => `${process.env.PAYMENT_LINK_1MONTH}?metadata[telegram_id]=${telegramId}`,
    check: 'check_payment_1month',
  },
  buy_6months:  {
    label: '6 месяцев — 2 490 ₽ · скидка 17%',
    link: (telegramId) => `${process.env.PAYMENT_LINK_6MONTHS}?metadata[telegram_id]=${telegramId}`,
    check: 'check_payment_6months',
  },
  buy_12months: {
    label: '12 месяцев — 4 490 ₽ · скидка 25%',
    link: (telegramId) => `${process.env.PAYMENT_LINK_12MONTHS}?metadata[telegram_id]=${telegramId}`,
    check: 'check_payment_12months',
  },
};

export async function handleSubscriptionCallback(bot, query) {
  const chatId = query.message.chat.id;
  const telegramId = query.from.id;
  const action = query.data;

  await bot.answerCallbackQuery(query.id);

  if (action === 'buy_subscription') {
    await bot.sendMessage(
      chatId,
      '💳 Оформление подписки Меркури\n\n' +
      'Подписка даёт полный доступ ко всем функциям:\n' +
      '✅ до 3 финансовых целей с расчётом доходности\n' +
      '✅ бюджет и алерты о превышении\n' +
      '✅ глубокая аналитика по запросу\n' +
      '✅ редактирование и удаление записей\n\n' +
      'Выбери период:',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '1 месяц — 499 ₽', callback_data: 'buy_1month' }],
            [{ text: '6 месяцев — 2 490 ₽ · скидка 17%', callback_data: 'buy_6months' }],
            [{ text: '12 месяцев — 4 490 ₽ · скидка 25%', callback_data: 'buy_12months' }],
          ],
        },
      }
    );
    return;
  }

  if (PLANS[action]) {
    const { label, link, check } = PLANS[action];
    await bot.sendMessage(
      chatId,
      `Для оплаты перейди по ссылке 👇\n\n` +
      `[${label}](${link(telegramId)})\n\n` +
      `После оплаты вернись в бот и нажми кнопку ниже — я сразу всё активирую 💛`,
      {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Я оплатил(а)', callback_data: check }],
            [{ text: 'Отмена', callback_data: 'cancel_payment' }],
          ],
        },
      }
    );
    return;
  }

  if (action.startsWith('check_payment_')) {
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

  const now = new Date();
  const endsAt = new Date(now);
  endsAt.setMonth(endsAt.getMonth() + months);

  await supabase
    .from('subscriptions')
    .upsert(
      {
        user_id: user.id,
        status: 'active',
        starts_at: now.toISOString(),
        ends_at: endsAt.toISOString(),
        period_months: months,
      },
      { onConflict: 'user_id' }
    );

  await bot.sendMessage(
    targetExternalId,
    '🎉 Подписка активирована!\n\n' +
    'Теперь тебе доступны все функции Меркури.\n' +
    'Спасибо что выбрал(а) нас 💛',
    {
      reply_markup: {
        inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]],
      },
    }
  );

  return { ok: true };
}
