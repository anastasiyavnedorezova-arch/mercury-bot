import { supabase } from '../db.js';
import { getUserAccess } from '../utils/access.js';
import { showBudget } from './budget.js';
import { showGoal } from './goal.js';

// ── Константы ─────────────────────────────────────────────────────────────────

const MONTHS_NOM = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

// Именительный падеж — для "за [месяц]": "Расходы за апрель"
function getMonthName(d = new Date()) {
  return MONTHS_NOM[d.getMonth()];
}

const MENU_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]],
  },
};

// Доступ по тарифам
const FEATURE_ACCESS = {
  analytics_expenses:      ['free', 'trial', 'active'],
  analytics_income:        ['free', 'trial', 'active'],
  analytics_budget_left:   ['trial', 'active'],
  analytics_goal_progress: ['trial', 'active'],
  analytics_top_expenses:  ['trial', 'active'],
  analytics_top_month:     ['trial', 'active'],
  analytics_compare:       ['trial', 'active'],
  analytics_forecast:      ['trial', 'active'],
};

// ── Хелперы дат ───────────────────────────────────────────────────────────────

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getMonthStart(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function getNextMonthStart(d = new Date()) {
  const y = d.getMonth() === 11 ? d.getFullYear() + 1 : d.getFullYear();
  const m = d.getMonth() === 11 ? 1 : d.getMonth() + 2;
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dateStr(d);
}

function formatNum(n) {
  return Math.round(n).toLocaleString('ru-RU');
}

// ── DB-хелперы ────────────────────────────────────────────────────────────────

async function getUserId(telegramId) {
  const { data } = await supabase
    .from('users')
    .select('id')
    .eq('external_id', String(telegramId))
    .eq('channel', 'telegram')
    .single();
  return data?.id ?? null;
}

// Расходы по нeсистемным категориям текущего месяца (для прогноза, как в budget.js)
async function getBudgetSpent(userId) {
  const { data: cats } = await supabase
    .from('categories')
    .select('id')
    .eq('is_system', false);

  const catIds = cats?.map(c => c.id) ?? [];
  if (catIds.length === 0) return 0;

  const { data } = await supabase
    .from('transactions')
    .select('amount')
    .eq('user_id', userId)
    .eq('type', 'expense')
    .gte('transaction_date', getMonthStart())
    .lt('transaction_date', getNextMonthStart())
    .in('category_id', catIds);

  return data?.reduce((sum, t) => sum + (t.amount ?? 0), 0) ?? 0;
}

// ── Paywall ───────────────────────────────────────────────────────────────────

async function showPaywall(bot, chatId) {
  await bot.sendMessage(
    chatId,
    'Эта функция доступна в подписке 💛\nХочешь активировать 30 дней бесплатно?',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Активировать trial', callback_data: 'budget:trial' },
          { text: 'Не сейчас', callback_data: 'menu:main' },
        ]],
      },
    }
  );
}

// ── 1. Расходы за месяц ───────────────────────────────────────────────────────

async function analyticsExpenses(bot, chatId, userId) {
  const now = new Date();
  const { data } = await supabase
    .from('transactions')
    .select('amount')
    .eq('user_id', userId)
    .eq('type', 'expense')
    .gte('transaction_date', getMonthStart(now))
    .lt('transaction_date', getNextMonthStart(now));

  const total = (data ?? []).reduce((s, t) => s + t.amount, 0);

  if (total === 0) {
    await bot.sendMessage(
      chatId,
      'За этот месяц расходов пока нет. Напиши мне о первой трате! 💛',
      MENU_KEYBOARD
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    `💸 Расходы за ${getMonthName(now)}: ${formatNum(total)} ₽`,
    MENU_KEYBOARD
  );
}

// ── 2. Доходы за месяц ────────────────────────────────────────────────────────

async function analyticsIncome(bot, chatId, userId) {
  const now = new Date();
  const { data } = await supabase
    .from('transactions')
    .select('amount')
    .eq('user_id', userId)
    .eq('type', 'income')
    .gte('transaction_date', getMonthStart(now))
    .lt('transaction_date', getNextMonthStart(now));

  const total = (data ?? []).reduce((s, t) => s + t.amount, 0);

  if (total === 0) {
    await bot.sendMessage(
      chatId,
      'За этот месяц доходов пока нет. Не забудь записать когда получишь 💛',
      MENU_KEYBOARD
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    `💰 Доходы за ${getMonthName(now)}: ${formatNum(total)} ₽`,
    MENU_KEYBOARD
  );
}

// ── 5. Топ-5 категорий за 90 дней ─────────────────────────────────────────────

async function analyticsTopExpenses(bot, chatId, userId) {
  const startDate = daysAgo(90);
  const today = dateStr(new Date());

  const { data } = await supabase
    .from('transactions')
    .select('amount, transaction_date, categories(name)')
    .eq('user_id', userId)
    .eq('type', 'expense')
    .gte('transaction_date', startDate)
    .lte('transaction_date', today);

  const rows = data ?? [];

  if (rows.length === 0) {
    await bot.sendMessage(chatId, 'Данных о расходах пока нет. Запиши первые траты! 💛', MENU_KEYBOARD);
    return;
  }

  // Есть ли транзакции раньше 90 дней назад?
  const { data: earliest } = await supabase
    .from('transactions')
    .select('transaction_date')
    .eq('user_id', userId)
    .eq('type', 'expense')
    .order('transaction_date', { ascending: true })
    .limit(1);

  const hasFullPeriod = earliest?.[0]?.transaction_date <= startDate;

  const byCategory = {};
  for (const row of rows) {
    const cat = row.categories?.name ?? 'Другое';
    byCategory[cat] = (byCategory[cat] ?? 0) + row.amount;
  }

  const total = rows.reduce((s, r) => s + r.amount, 0);
  const sorted = Object.entries(byCategory)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  const periodLabel = hasFullPeriod
    ? 'За последние 3 месяца топ-5 категорий трат'
    : 'За всё время (менее 3 месяцев) топ-5 категорий трат';

  let text = `📊 ${periodLabel}:\n\n`;
  sorted.forEach(([cat, sum], i) => {
    const pct = total > 0 ? Math.round((sum / total) * 100) : 0;
    text += `${i + 1}. ${cat} — ${formatNum(sum)} ₽ (${pct}%)\n`;
  });

  await bot.sendMessage(chatId, text.trim(), MENU_KEYBOARD);
}

// ── 5b. Топ-5 категорий за текущий месяц (из алертов бюджета) ────────────────

async function analyticsTopExpensesMonth(bot, chatId, userId) {
  const now = new Date();

  const { data: nonSystemCats } = await supabase
    .from('categories')
    .select('id')
    .eq('is_system', false);
  const catIds = nonSystemCats?.map(c => c.id) ?? [];

  const { data } = await supabase
    .from('transactions')
    .select('amount, categories(name)')
    .eq('user_id', userId)
    .eq('type', 'expense')
    .gte('transaction_date', getMonthStart(now))
    .lt('transaction_date', getNextMonthStart(now))
    .in('category_id', catIds.length > 0 ? catIds : ['00000000-0000-0000-0000-000000000000']);

  const rows = data ?? [];

  if (rows.length === 0) {
    await bot.sendMessage(chatId, 'В этом месяце расходов пока нет 💛', MENU_KEYBOARD);
    return;
  }

  const byCategory = {};
  for (const row of rows) {
    const cat = row.categories?.name ?? 'Другое';
    byCategory[cat] = (byCategory[cat] ?? 0) + row.amount;
  }

  const total = rows.reduce((s, r) => s + r.amount, 0);
  const sorted = Object.entries(byCategory)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  let text = `📊 В этом месяце топ категорий трат:\n\n`;
  sorted.forEach(([cat, sum], i) => {
    const pct = total > 0 ? Math.round((sum / total) * 100) : 0;
    text += `${i + 1}. ${cat} — ${formatNum(sum)} ₽ (${pct}%)\n`;
  });

  await bot.sendMessage(chatId, text.trim(), MENU_KEYBOARD);
}

// ── 6. Сравнить доходы и расходы ─────────────────────────────────────────────

async function analyticsCompare(bot, chatId, userId) {
  const now = new Date();

  const { data: currData } = await supabase
    .from('transactions')
    .select('amount, type')
    .eq('user_id', userId)
    .gte('transaction_date', getMonthStart(now))
    .lt('transaction_date', getNextMonthStart(now));

  const currIncome  = (currData ?? []).filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const currExpense = (currData ?? []).filter(t => t.type !== 'income').reduce((s, t) => s + t.amount, 0);
  const currPct = currIncome > 0 ? Math.round((currExpense / currIncome) * 100) : 0;

  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const { data: prevData } = await supabase
    .from('transactions')
    .select('amount, type')
    .eq('user_id', userId)
    .gte('transaction_date', getMonthStart(prevDate))
    .lt('transaction_date', getMonthStart(now));

  const prevIncome  = (prevData ?? []).filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const prevExpense = (prevData ?? []).filter(t => t.type !== 'income').reduce((s, t) => s + t.amount, 0);
  const prevPct = prevIncome > 0 ? Math.round((prevExpense / prevIncome) * 100) : null;

  let text =
    `📊 В этом месяце расходы составили ${currPct}% от доходов.\n\n` +
    `💰 Доходы: ${formatNum(currIncome)} ₽\n` +
    `💸 Расходы: ${formatNum(currExpense)} ₽`;

  if (prevPct !== null && (prevData?.length ?? 0) > 0) {
    const trend = currPct > prevPct ? 'выросли' : currPct < prevPct ? 'снизились' : 'не изменились';
    text += `\n\nВ прошлом месяце: ${prevPct}% → сейчас ${currPct}% — ${trend} расходы`;
  }

  await bot.sendMessage(chatId, text, MENU_KEYBOARD);
}

// ── 7. Прогноз до конца месяца ────────────────────────────────────────────────

async function analyticsForecast(bot, chatId, userId) {
  const spent = await getBudgetSpent(userId);

  if (spent === 0) {
    await bot.sendMessage(chatId, 'Пока нет данных для прогноза — внеси первые расходы 💛', MENU_KEYBOARD);
    return;
  }

  const { data: budget } = await supabase
    .from('budget')
    .select('amount')
    .eq('user_id', userId)
    .gte('month', getMonthStart())
    .lt('month', getNextMonthStart())
    .maybeSingle();

  const now = new Date();
  const passedDays = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const remainingDays = daysInMonth - passedDays;
  const avgDaily = spent / passedDays;
  const forecast = spent + avgDaily * remainingDays;

  let text =
    `📊 Прогноз до конца месяца\n\n` +
    `Потрачено сейчас: ${formatNum(spent)} ₽\n` +
    `Среднедневной расход: ${formatNum(avgDaily)} ₽/день\n` +
    `Прогноз до конца месяца: ${formatNum(forecast)} ₽\n\n`;

  if (!budget) {
    text += `При текущем темпе до конца месяца потратишь примерно ${formatNum(forecast)} ₽`;
  } else {
    const forecastPct = (forecast / budget.amount) * 100;
    if (forecastPct <= 100) {
      text +=
        `Без учёта крупных трат, если сохранишь темп расходов — ` +
        `израсходуешь ${Math.round(forecastPct)}% своего бюджета 💛`;
    } else {
      text +=
        `⚠️ Без учёта крупных трат, если сохранишь темп расходов — ` +
        `перерасходуешь бюджет на ${Math.round(forecastPct - 100)}%`;
    }
  }

  await bot.sendMessage(chatId, text, MENU_KEYBOARD);
}

// ── Ежемесячный отчёт (по нажатию кнопки) ────────────────────────────────────

async function showMonthlyReport(bot, chatId, userId) {
  const now = new Date();
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const startDate = getMonthStart(prevDate);
  const endDate = getMonthStart(now);
  const monthName = MONTHS_GEN[prevDate.getMonth()];

  const { data: txData } = await supabase
    .from('transactions')
    .select('amount, type, categories(name)')
    .eq('user_id', userId)
    .gte('transaction_date', startDate)
    .lt('transaction_date', endDate);

  const rows = txData ?? [];
  const income  = rows.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expense = rows.filter(t => t.type !== 'income').reduce((s, t) => s + t.amount, 0);

  const byCategory = {};
  for (const row of rows.filter(t => t.type !== 'income')) {
    const cat = row.categories?.name ?? 'Другое';
    byCategory[cat] = (byCategory[cat] ?? 0) + row.amount;
  }
  const top5 = Object.entries(byCategory)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  const { data: goals } = await supabase
    .from('goals')
    .select('name, future_value, initial_saved')
    .eq('user_id', userId)
    .eq('status', 'active')
    .limit(1);

  let text = `📊 Аналитика за ${monthName}\n\n`;
  text += `💰 Доходы: ${formatNum(income)} ₽\n`;
  text += `💸 Расходы: ${formatNum(expense)} ₽`;

  if (top5.length > 0) {
    text += `\n\n📊 Топ-5 категорий расходов:\n`;
    top5.forEach(([cat, sum], i) => {
      const pct = expense > 0 ? Math.round((sum / expense) * 100) : 0;
      text += `${i + 1}. ${cat} — ${formatNum(sum)} ₽ (${pct}%)\n`;
    });
  }

  if (goals?.[0]) {
    const g = goals[0];
    const { data: catData } = await supabase
      .from('categories').select('id').eq('name', 'Цель').single();

    let goalTxTotal = 0;
    if (catData?.id) {
      const { data: goalTxs } = await supabase
        .from('transactions').select('amount')
        .eq('user_id', userId).eq('category_id', catData.id);
      goalTxTotal = goalTxs?.reduce((s, t) => s + t.amount, 0) ?? 0;
    }

    const accumulated = (g.initial_saved ?? 0) + goalTxTotal;
    const percent = Math.min(100, Math.round((accumulated / g.future_value) * 100));
    text += `\n🎯 Прогресс по цели «${g.name}»: ${percent}%`;
  }

  await bot.sendMessage(chatId, text.trim(), MENU_KEYBOARD);
}

// ── Меню аналитики ────────────────────────────────────────────────────────────

export async function showAnalyticsMenu(bot, chatId) {
  await bot.sendMessage(chatId, '📊 Какую аналитику показать?', {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Расходы за месяц',    callback_data: 'analytics_expenses' },
          { text: 'Доходы за месяц',     callback_data: 'analytics_income' },
        ],
        [
          { text: 'Остаток бюджета',     callback_data: 'analytics_budget_left' },
          { text: 'Прогресс по цели',    callback_data: 'analytics_goal_progress' },
        ],
        [
          { text: 'На что трачу больше', callback_data: 'analytics_top_expenses' },
          { text: 'Сравнить доходы и расходы', callback_data: 'analytics_compare' },
        ],
        [
          { text: 'Прогноз до конца месяца', callback_data: 'analytics_forecast' },
        ],
      ],
    },
  });
}

// ── Обработчик кнопок analytics_ и show_monthly_analytics ────────────────────

export async function handleAnalyticsCallback(bot, query) {
  const chatId = query.message.chat.id;
  const telegramId = query.from.id;
  const action = query.data;

  await bot.answerCallbackQuery(query.id);

  if (action === 'analytics_monthly_skip') return;

  if (action === 'show_monthly_analytics') {
    const userId = await getUserId(telegramId);
    if (!userId) return;
    await showMonthlyReport(bot, chatId, userId);
    return;
  }

  const userId = await getUserId(telegramId);
  if (!userId) {
    await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start 🙏');
    return;
  }

  const access = await getUserAccess(userId);

  if (!FEATURE_ACCESS[action]?.includes(access)) {
    await showPaywall(bot, chatId);
    return;
  }

  switch (action) {
    case 'analytics_expenses':
      await analyticsExpenses(bot, chatId, userId);
      break;
    case 'analytics_income':
      await analyticsIncome(bot, chatId, userId);
      break;
    case 'analytics_budget_left':
      await showBudget(bot, chatId, telegramId);
      break;
    case 'analytics_goal_progress':
      await showGoal(bot, chatId, telegramId);
      break;
    case 'analytics_top_expenses':
      await analyticsTopExpenses(bot, chatId, userId);
      break;
    case 'analytics_top_month':
      await analyticsTopExpensesMonth(bot, chatId, userId);
      break;
    case 'analytics_compare':
      await analyticsCompare(bot, chatId, userId);
      break;
    case 'analytics_forecast':
      await analyticsForecast(bot, chatId, userId);
      break;
  }
}

// ── Ежемесячная рассылка (вызывать из bot.js) ─────────────────────────────────

export async function sendMonthlyAnalytics(bot) {
  const today = new Date();
  if (today.getDate() !== 1) return;

  const prevDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastMonthStart = getMonthStart(prevDate);
  const thisMonthStart = getMonthStart(today);
  const monthName = MONTHS_NOM[prevDate.getMonth()];

  const { data: users } = await supabase
    .from('users')
    .select('id, external_id')
    .eq('channel', 'telegram')
    .not('terms_accepted_at', 'is', null);

  if (!users?.length) return;

  for (const user of users) {
    try {
      // Проверяем, не отправляли ли уже за этот месяц
      const { data: existing } = await supabase
        .from('notifications')
        .select('id')
        .eq('user_id', user.id)
        .eq('type', 'analytics_ready')
        .eq('month', lastMonthStart)
        .maybeSingle();

      if (existing) continue;

      // Отправляем только если есть транзакции за прошлый месяц
      const { data: txCheck } = await supabase
        .from('transactions')
        .select('id')
        .eq('user_id', user.id)
        .gte('transaction_date', lastMonthStart)
        .lt('transaction_date', thisMonthStart)
        .limit(1);

      if (!txCheck?.length) continue;

      await bot.sendMessage(
        user.external_id,
        `Аналитика за ${monthName} уже готова 📊\nХочешь посмотреть?`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: 'Показать аналитику', callback_data: 'show_monthly_analytics' },
              { text: 'Позже', callback_data: 'analytics_monthly_skip' },
            ]],
          },
        }
      );

      await supabase.from('notifications').insert({
        user_id: user.id,
        type: 'analytics_ready',
        month: lastMonthStart,
      });
    } catch (err) {
      console.error(`Monthly analytics error for user ${user.external_id}:`, err.message);
    }
  }
}
