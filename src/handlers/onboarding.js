import { supabase } from '../db.js';
import { showMainMenu } from './menu.js';
import { showGoal } from './goal.js';
import { showBudget } from './budget.js';
import { showSubscription } from './subscription.js';
import { getUserAccess } from '../utils/access.js';
import { recordHint } from '../utils/botTexts.js';
import { startTrial, hadTrial } from '../utils/trial.js';
import { findUserIdByExternalId } from '../utils/findUser.js';

const GREETING = `Привет! Я бот сервиса Финник Деньги 👋`;

const RECORD_PROMPT =
  `Давай начнём с первой записи. Напиши мне обычным сообщением, например «продукты 2500» или «зарплата 120000». ` +
  `Категорию и сумму я определю сам, а ты поправишь, если нужно.`;

// Запасной вариант: пробный период почему-то не включился (сбой базы) — предлагаем включить вручную
const STEP1_TEXT =
  `${GREETING}\n\n` +
  `Я дарю тебе 30 дней бесплатного доступа ко всем функциям, нужно только активировать пробный период 🎁\n\n` +
  `${RECORD_PROMPT}`;

function trialStartedText(endsAt) {
  const until = endsAt
    ? ` (до ${new Date(endsAt).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })})`
    : '';
  return `Я дарю тебе 30 дней бесплатного доступа ко всем функциям${until} 🎁\n\n${RECORD_PROMPT}`;
}

// Четыре «расскажи подробнее» убраны под одну кнопку «Что ещё умею»: главное действие — первая запись
const INFO_ROWS = [
  [{ text: 'Как записывать расходы и доходы?', callback_data: 'onboarding:how_to_record' }],
  [{ text: 'Расскажи о целях', callback_data: 'onboarding:about_goals' }],
  [{ text: 'Подробнее об аналитике', callback_data: 'onboarding:about_analytics' }],
  [{ text: 'Зачем устанавливать бюджет?', callback_data: 'onboarding:about_budget' }],
];

const FIRST_RECORD_ROW = [{ text: '✍️ Записать первую трату', callback_data: 'onboarding:start_transaction' }];
const MORE_ROW = [{ text: 'Что ещё умею', callback_data: 'onboarding:more' }];

// Запасной вариант (пробный период не включён): сверху — включить вручную
const STEP1_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [{ text: 'Активировать пробный период', callback_data: 'onboarding:activate_trial' }],
      FIRST_RECORD_ROW,
      MORE_ROW,
    ],
  },
};

// Пробный период уже включён
const STEP1_TRIAL_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [FIRST_RECORD_ROW, MORE_ROW],
  },
};

// Один раз, сразу после самой первой записи человека: что делать дальше
const FIRST_RECORD_TEXT =
  `Вот и первая запись 🎉 Так же просто можно записывать любые траты и доходы: всё собирается в истории и аналитике.\n\n` +
  `Что дальше? Могу помочь поставить финансовую цель или бюджет на месяц.`;

const FIRST_RECORD_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🎯 Поставить цель', callback_data: 'onboarding:start_goal' }],
      [{ text: '📊 Установить бюджет', callback_data: 'onboarding:start_budget' }],
    ],
  },
};

// Показывает подсказку, если запись — самая первая у человека (txId — только что сохранённая запись)
export async function maybeShowFirstRecordTip(bot, chatId, txId, db = supabase) {
  if (!txId) return false;
  try {
    const { data: tx } = await db.from('transactions').select('user_id').eq('id', txId).maybeSingle();
    if (!tx?.user_id) return false;
    const { count } = await db
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', tx.user_id);
    if (count !== 1) return false;
    await bot.sendMessage(chatId, FIRST_RECORD_TEXT, FIRST_RECORD_KEYBOARD);
    return true;
  } catch (err) {
    console.error('[onboarding] first record tip:', err.message);
    return false;
  }
}

const CONSENT_TEXT =
  `${GREETING} Записываю доходы и расходы по обычным сообщениям, слежу за бюджетом и помогаю копить на цели.\n\n` +
  `Чтобы начать, нужно твоё согласие. Нажимая «Принимаю и продолжаю», ты:\n` +
  `• принимаешь условия публичной оферты;\n` +
  `• даёшь согласие на обработку персональных данных.\n\n` +
  `Финник хранит данные о твоих доходах и расходах на серверах в России. ` +
  `Чтобы распознавать твои сообщения, их текст (а также голос и фото, если ты их отправляешь) ` +
  `передаётся технологическому партнёру за пределами России (Нидерланды, США). Имя и контакты при этом не передаются. ` +
  `Подробнее — в документах по кнопке «Читать документы».`;

const DOCS_TEXT =
  `📄 Публичная оферта: https://finnikbot.ru/legal/offer\n\n` +
  `📄 Политика конфиденциальности: https://finnikbot.ru/legal/privacy\n\n` +
  `📄 Согласие на обработку персональных данных: https://finnikbot.ru/legal/consent`;

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

// Приветствие для веб-чата. Показывается при открытии виджета, пока у пользователя нет ни одной записи.
// Экран согласия не нужен: согласие уже дано галочкой при регистрации на сайте.
// Текст про пробный период зависит от подписки: предлагаем активацию только тем, у кого триала ещё не было.
export async function maybeShowWebWelcome(bot, chatId, userId) {
  const { count: txCount } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if ((txCount ?? 0) > 0) return false;

  const access = await getUserAccess(userId);

  if (access === 'free') {
    const { count: subCount } = await supabase
      .from('subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if ((subCount ?? 0) === 0) {
      await bot.sendMessage(chatId, STEP1_TEXT, STEP1_KEYBOARD);
      return true;
    }
  }

  let lead = '';
  if (access === 'trial') lead = 'Пробный период уже активирован: тебе доступны все функции 🎉\n\n';
  if (access === 'active') lead = 'Подписка уже активна: тебе доступны все функции 🎉\n\n';

  await bot.sendMessage(chatId, `${GREETING}\n\n${lead}${RECORD_PROMPT}`, STEP1_TRIAL_KEYBOARD);
  return true;
}

export async function hasAcceptedTerms(externalId) {
  const { data } = await supabase
    .from('users')
    .select('terms_accepted_at')
    .eq('external_id', String(externalId))
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

const getUserId = (telegramId) => findUserIdByExternalId(supabase, telegramId);

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
      .update({ terms_accepted_at: new Date().toISOString(), terms_version: '2.0' })
      .eq('external_id', telegramId);

    // Новому пользователю сразу включаем пробный период на 30 дней
    const acceptedUserId = await getUserId(telegramId);
    const trial = acceptedUserId ? await startTrial(supabase, acceptedUserId) : { ok: false, reason: 'no_user' };
    const accessNow = acceptedUserId ? await getUserAccess(acceptedUserId) : 'free';
    if (accessNow === 'free') {
      await bot.sendMessage(chatId, STEP1_TEXT, STEP1_KEYBOARD);
    } else {
      await bot.sendMessage(chatId, trialStartedText(trial.ok ? trial.endsAt : null), STEP1_TRIAL_KEYBOARD);
    }
    return;
  }

  // ── Кнопка «Что ещё умею»: четыре вопроса о возможностях ─────────────────

  if (action === 'onboarding:more') {
    await bot.sendMessage(chatId, 'Расскажу подробнее 👇', { reply_markup: { inline_keyboard: INFO_ROWS } });
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
      `Это безопасно. Данные о твоих доходах и расходах хранятся на ` +
      `защищённом сервере в России. Я всегда здесь — просто напиши мне ` +
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
    await bot.sendMessage(chatId, recordHint(bot));
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
    if (!userId) {
      await bot.sendMessage(chatId, 'Не нашёл твой аккаунт 😔 Попробуй ещё раз или напиши нам через «Обратную связь»');
      return;
    }

    // Доступ уже есть (триал или подписка)
    if ((await getUserAccess(userId)) !== 'free') {
      await bot.sendMessage(chatId, 'У тебя уже всё активировано 💛 Все функции доступны, пользуйся!');
      return;
    }

    // Пробный период был и закончился (раньше такой пользователь мог включать его снова и снова)
    if (await hadTrial(supabase, userId)) {
      await bot.sendMessage(
        chatId,
        'Пробный период уже был использован 💛 Чтобы вернуть все функции, можно оформить подписку 👇',
        { reply_markup: { inline_keyboard: [[{ text: 'Оформить подписку', callback_data: 'onboarding:pay_subscription' }]] } }
      );
      return;
    }

    const trial = await startTrial(supabase, userId, { onlyIfNoSubscriptions: false });

    // Раньше при ошибке бот всё равно отвечал «Пробный период активирован»
    if (!trial.ok) {
      console.error('[onboarding] activate_trial error:', trial.reason);
      await bot.sendMessage(chatId, 'Не получилось активировать пробный период 😔 Попробуй ещё раз, а если повторится — напиши нам через «Обратную связь»');
      return;
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
