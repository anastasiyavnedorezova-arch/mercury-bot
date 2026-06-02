import { supabase } from '../db.js';
import { showMainMenu } from './menu.js';
import { showGoal } from './goal.js';
import { showBudget } from './budget.js';
import { showSubscription } from './subscription.js';

const STEP1_TEXT =
  `Привет! Я Меркури — твой личный финансовый помощник 👋\n\n` +
  `Помогу тебе: \n` +
  `💰понять, куда уходят деньги;\n` +
  `🎯поставить финансовую цель и двигаться к ней; \n` +
  `📊видеть понятную аналитику по доходам и расходам.\n\n` +
  `Просто пиши мне в свободной форме — например, «продукты 2500» \n` +
  `или «зарплата 120000» — и я всё запишу.\n\n` +
  `У тебя есть 30 дней бесплатного доступа ко всем функциям — ` +
  `бюджет, уведомления, глубокая аналитика. Активировать сразу ` +
  `или сначала подробнее рассказать о моих возможностях?`;

const STEP1_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [{ text: 'Как записывать расходы и доходы?', callback_data: 'onboarding:how_to_record' }],
      [{ text: 'Расскажи о целях', callback_data: 'onboarding:about_goals' }],
      [{ text: 'Подробнее об аналитике', callback_data: 'onboarding:about_analytics' }],
      [{ text: 'Зачем устанавливать бюджет?', callback_data: 'onboarding:about_budget' }],
      [{ text: 'Активировать пробный период', callback_data: 'onboarding:activate_trial' }],
    ],
  },
};

const CONSENT_TEXT =
  `Привет! Прежде чем начать — пара формальностей 📋\n\n` +
  `Используя Меркури, ты соглашаешься с условиями:\n\n` +
  `📄 Политика конфиденциальности\n` +
  `📄 Пользовательское соглашение  \n` +
  `📄 Согласие на обработку персональных данных\n\n` +
  `Меркури собирает данные о твоих доходах и расходах для ведения ` +
  `личного бюджета. Данные хранятся на защищённом сервере и не ` +
  `передаются третьим лицам.`;

const DOCS_TEXT =
  `📄 Политика конфиденциальности: https://telegra.ph/Politika-konfidencialnosti-servisa-Merkuri-03-31\n\n` +
  `📄 Пользовательское соглашение: https://telegra.ph/Polzovatelskoe-soglashenie-servisa-Merkuri-03-31\n\n` +
  `📄 Согласие на обработку ПД: https://telegra.ph/Soglasie-na-obrabotku-personalnyh-dannyh-03-31-19`;

const CONSENT_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [[
      { text: 'Принимаю и продолжаю', callback_data: 'onboarding:accept' },
      { text: 'Читать документы', callback_data: 'onboarding:docs' },
    ]],
  },
};

export async function showConsentScreen(bot, chatId) {
  await bot.sendMessage(chatId, CONSENT_TEXT, CONSENT_KEYBOARD);
}

export async function hasAcceptedTerms(telegramId) {
  const { data } = await supabase
    .from('users')
    .select('terms_accepted_at')
    .eq('external_id', String(telegramId))
    .eq('channel', 'telegram')
    .single();
  return !!data?.terms_accepted_at;
}

// Возвращает true и показывает экран согласия, если terms НЕ приняты.
// Используй как: if (await requireTerms(bot, telegramId, chatId)) return;
export async function requireTerms(bot, telegramId, chatId) {
  if (await hasAcceptedTerms(telegramId)) return false;
  await showConsentScreen(bot, chatId);
  return true;
}

async function getUserId(telegramId) {
  const { data } = await supabase
    .from('users')
    .select('id')
    .eq('external_id', telegramId)
    .eq('channel', 'telegram')
    .single();
  return data?.id ?? null;
}

const START_TRANSACTION_TEXT =
  `Напиши мне о своей трате или доходе в свободной форме\n` +
  `или запиши голосовое — я распознаю его 🎤\n` +
  `Например: «продукты 1800», «такси 450», «зарплата 120000»`;

export async function handleOnboardingCallback(bot, query) {
  const chatId = query.message.chat.id;
  const telegramId = String(query.from.id);
  const action = query.data;

  await bot.answerCallbackQuery(query.id);

  // ── Шаг 0: документы ─────────────────────────────────────────────────────

  if (action === 'onboarding:docs') {
    await bot.sendMessage(chatId, DOCS_TEXT, { disable_web_page_preview: true });
    await showConsentScreen(bot, chatId);
    return;
  }

  if (action === 'onboarding:accept') {
    await supabase
      .from('users')
      .update({ terms_accepted_at: new Date().toISOString(), terms_version: '1.0' })
      .eq('external_id', telegramId)
      .eq('channel', 'telegram');

    await bot.sendMessage(chatId, STEP1_TEXT, STEP1_KEYBOARD);
    return;
  }

  // ── Кнопка 1: Как записывать расходы и доходы? ───────────────────────────

  if (action === 'onboarding:how_to_record') {
    await bot.sendMessage(
      chatId,
      `💸 Учёт финансов — это моя основная работа. Я принимаю записи ` +
      `доходов и расходов в свободной форме, главное пиши мне о каждом ` +
      `поступлении или трате, а я уже сам определяю категорию и запишу 🙌\n\n` +
      `Например: «продукты 1800», «такси 450», «зарплата 120000»\n\n` +
      `Это безопасно. Все данные хранятся на защищённом сервере и не ` +
      `передаются третьим лицам. Я всегда здесь — просто напиши мне ` +
      `в любой момент.\n\n` +
      `Попробуй прямо сейчас 👇`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Записать первый расход или доход', callback_data: 'onboarding:start_transaction' }],
          ],
        },
      }
    );
    return;
  }

  if (action === 'onboarding:start_transaction' || action === 'onboarding:start_transaction_2') {
    await bot.sendMessage(chatId, START_TRANSACTION_TEXT);
    return;
  }

  // ── Кнопка 2: Расскажи о целях ────────────────────────────────────────────

  if (action === 'onboarding:about_goals') {
    await bot.sendMessage(
      chatId,
      `🎯 Финансовая цель — это то, на что ты хочешь накопить в будущем. ` +
      `Например, купить квартиру, машину, на финансовую подушку и др.\n\n` +
      `От тебя потребуется сказать мне:\n` +
      `— Название твоей цели\n` +
      `— Когда ты хочешь её достичь (желательно месяц и год)\n` +
      `— Какая сумма тебе потребуется\n` +
      `— Сколько уже накоплено\n\n` +
      `Например:\n` +
      `— Купить квартиру\n` +
      `— Март 2035\n` +
      `— 10 000 000 рублей\n` +
      `— 1 000 000 рублей\n\n` +
      `Я рассчитаю, сколько понадобится откладывать каждый месяц с учётом ` +
      `инфляции, чтобы достичь цели в указанные сроки.\n\n` +
      `На бесплатном тарифе доступна одна финансовая цель и расчёт только ` +
      `с учётом инфляции. На платном тарифе — до трёх финансовых целей ` +
      `и расчёт с доходностью.\n\n` +
      `Запишем твою первую цель?`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Поставить цель', callback_data: 'onboarding:start_goal' }],
            [{ text: 'Напомнить позже', callback_data: 'onboarding:remind_goal_later' }],
          ],
        },
      }
    );
    return;
  }

  if (action === 'onboarding:start_goal') {
    await showGoal(bot, chatId, telegramId);
    return;
  }

  if (action === 'onboarding:remind_goal_later') {
    await bot.sendMessage(
      chatId,
      `Хорошо, напомню позже 💛 А пока можешь просто писать ` +
      `мне о расходах и доходах в свободной форме.`
    );
    return;
  }

  // ── Кнопка 3: Подробнее об аналитике ─────────────────────────────────────

  if (action === 'onboarding:about_analytics') {
    await bot.sendMessage(
      chatId,
      `Я умею делать аналитику расходов и доходов, когда ты делаешь записи:\n\n` +
      `📊 Сколько уже потрачено и какие категории расходов самые большие\n` +
      `📊 Прогресс достижения твоей финансовой цели\n` +
      `📊 Если у тебя задан бюджет расходов на месяц, то я рассчитаю ` +
      `темп расходов и спрогнозирую, остаёмся ли мы в рамках бюджета ` +
      `к концу месяца\n` +
      `📊 По итогам месяца ты получишь отчёт: сколько получено, сколько ` +
      `потрачено в разрезе категорий\n` +
      `📊 Спустя 3 месяца я смогу проанализировать как растут расходы ` +
      `относительно доходов\n\n` +
      `Бесплатно каждый месяц я предоставляю отчёт о тратах по категориям. ` +
      `Глубокая аналитика и прогноз доступны в подписке.\n\n` +
      `Чтобы у меня была база для анализа, просто начни записывать ` +
      `свои расходы и доходы`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Записать расход или доход', callback_data: 'onboarding:start_transaction_2' }],
            [{ text: 'Позже', callback_data: 'onboarding:analytics_later' }],
          ],
        },
      }
    );
    return;
  }

  if (action === 'onboarding:analytics_later') {
    await bot.sendMessage(
      chatId,
      `Хорошо 💛 Просто пиши мне о расходах и доходах — ` +
      `аналитика будет накапливаться сама.`
    );
    return;
  }

  // ── Кнопка 4: Зачем устанавливать бюджет? ────────────────────────────────

  if (action === 'onboarding:about_budget') {
    await bot.sendMessage(
      chatId,
      `Бюджет — это функция, которая помогает оставаться в рамках ` +
      `расходов в течение месяца 💛\n\n` +
      `Когда у тебя задан бюджет расходов на месяц, я могу помочь ` +
      `держать его под контролем:\n` +
      `✔️ Я буду отслеживать темп расходов\n` +
      `✔️ Я предупрежу тебя, если темп расходов будет слишком высок ` +
      `и появляется риск перерасхода к концу месяца\n` +
      `✔️ В любой момент ты сможешь посмотреть аналитику расходов ` +
      `и скорректировать траты\n\n` +
      `Функция ведения бюджета доступна в рамках подписки. Но у тебя ` +
      `есть 30 дней бесплатного доступа ко всем возможностям — включая ` +
      `бюджет, уведомления и глубокую аналитику. Попробуешь?`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Задать бюджет', callback_data: 'onboarding:start_budget' }],
            [{ text: 'Пока не надо', callback_data: 'onboarding:budget_later' }],
          ],
        },
      }
    );
    return;
  }

  if (action === 'onboarding:start_budget') {
    await showBudget(bot, chatId, telegramId);
    return;
  }

  if (action === 'onboarding:budget_later') {
    await bot.sendMessage(
      chatId,
      `Хорошо, без проблем. Давай тогда начнём с простого — ` +
      `просто пиши мне о расходах и доходах в свободной форме 💛`
    );
    return;
  }

  // ── Кнопка 5: Активировать пробный период ────────────────────────────────

  if (action === 'onboarding:activate_trial') {
    const userId = await getUserId(telegramId);

    if (userId) {
      const { data: existingSub } = await supabase
        .from('subscriptions')
        .select('id')
        .eq('user_id', userId)
        .in('status', ['trial', 'active'])
        .maybeSingle();

      if (existingSub) {
        await bot.sendMessage(chatId, `У тебя уже активирован пробный период 💛`);
        return;
      }

      const now = new Date();
      const endsAt = new Date(now);
      endsAt.setDate(endsAt.getDate() + 30);

      await supabase.from('subscriptions').insert({
        user_id: userId,
        status: 'trial',
        starts_at: now.toISOString(),
        ends_at: endsAt.toISOString(),
        period_months: null,
        payment_id: null,
        amount_rub: null,
      });
    }

    await bot.sendMessage(
      chatId,
      `Пробный период активирован 🥳\n\n` +
      `На 30 дней тебе доступны все функции:\n` +
      `⭐ ведение расходов и доходов\n` +
      `⭐ аналитика 1-го числа каждого месяца и по запросу\n` +
      `⭐ бюджет\n` +
      `⭐ постановка финансовой цели\n\n` +
      `Я напомню тебе, когда пробный период будет подходить к концу ` +
      `или ты можешь оплатить подписку сразу и не думать об этом 😉`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Оплатить подписку', callback_data: 'onboarding:pay_subscription' }],
            [{ text: 'Напомнить позже', callback_data: 'onboarding:remind_subscription' }],
          ],
        },
      }
    );
    return;
  }

  if (action === 'onboarding:pay_subscription') {
    await showSubscription(bot, chatId, telegramId);
    return;
  }

  if (action === 'onboarding:remind_subscription') {
    await bot.sendMessage(chatId, `Хорошо, напомню! А пока пользуйся всеми функциями 💛`);
    return;
  }
}
