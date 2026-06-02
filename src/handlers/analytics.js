import { queryOne, queryAll } from '../db.js';
import { getUserAccess } from '../utils/access.js';
import { showBudget } from './budget.js';
import { showGoal } from './goal.js';

const MONTHS_NOM = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
const MONTHS_GEN = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

function getMonthName(d = new Date()) { return MONTHS_NOM[d.getMonth()]; }

const MENU_KEYBOARD = {
  reply_markup: { inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]] },
};

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
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return dateStr(d); }
function formatNum(n) { return Math.round(n).toLocaleString('ru-RU'); }

async function getUserId(telegramId) {
  const { data } = await queryOne(
    `SELECT id FROM users WHERE external_id = $1 AND channel = 'telegram'`,
    [String(telegramId)]
  );
  return data?.id ?? null;
}

async function getBudgetSpent(userId) {
  const { data } = await queryOne(
    `SELECT COALESCE(SUM(t.amount), 0) AS total
     FROM transactions t
     JOIN categories c ON t.category_id = c.id
     WHERE t.user_id = $1
       AND t.type = 'expense'
       AND c.is_system = false
       AND t.transaction_date >= $2
       AND t.transaction_date < $3`,
    [userId, getMonthStart(), getNextMonthStart()]
  );
  return parseFloat(data?.total ?? 0);
}

async function showPaywall(bot, chatId) {
  await bot.sendMessage(chatId, 'Эта функция доступна в подписке 💛\nХочешь активировать 30 дней бесплатно?', {
    reply_markup: { inline_keyboard: [[
      { text: 'Активировать trial', callback_data: 'budget:trial' },
      { text: 'Не сейчас', callback_data: 'menu:main' },
    ]]},
  });
}

async function analyticsExpenses(bot, chatId, userId) {
  const now = new Date();
  const { data } = await queryOne(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
     WHERE user_id = $1 AND type = 'expense'
       AND transaction_date >= $2 AND transaction_date < $3`,
    [userId, getMonthStart(now), getNextMonthStart(now)]
  );
  const total = parseFloat(data?.total ?? 0);
  if (total === 0) {
    await bot.sendMessage(chatId, 'За этот месяц расходов пока нет. Напиши мне о первой трате! 💛', MENU_KEYBOARD);
    return;
  }
  await bot.sendMessage(chatId, `💸 Расходы за ${getMonthName(now)}: ${formatNum(total)} ₽`, MENU_KEYBOARD);
}

async function analyticsIncome(bot, chatId, userId) {
  const now = new Date();
  const { data } = await queryOne(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
     WHERE user_id = $1 AND type = 'income'
       AND transaction_date >= $2 AND transaction_date < $3`,
    [userId, getMonthStart(now), getNextMonthStart(now)]
  );
  const total = parseFloat(data?.total ?? 0);
  if (total === 0) {
    await bot.sendMessage(chatId, 'За этот месяц доходов пока нет. Не забудь записать когда получишь 💛', MENU_KEYBOARD);
    return;
  }
  await bot.sendMessage(chatId, `💰 Доходы за ${getMonthName(now)}: ${formatNum(total)} ₽`, MENU_KEYBOARD);
}

async function analyticsTopExpenses(bot, chatId, userId) {
  const startDate = daysAgo(90);
  const today = dateStr(new Date());

  const { data: rows } = await queryAll(
    `SELECT t.amount, t.transaction_date, c.name AS category_name
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.user_id = $1 AND t.type = 'expense'
       AND t.transaction_date >= $2 AND t.transaction_date <= $3`,
    [userId, startDate, today]
  );

  if (!rows?.length) {
    await bot.sendMessage(chatId, 'Данных о расходах пока нет. Запиши первые траты! 💛', MENU_KEYBOARD);
    return;
  }

  const { data: earliest } = await queryOne(
    `SELECT transaction_date FROM transactions WHERE user_id = $1 AND type = 'expense' ORDER BY transaction_date ASC LIMIT 1`,
    [userId]
  );
  const hasFullPeriod = earliest?.transaction_date && String(earliest.transaction_date).slice(0, 10) <= startDate;

  const byCategory = {};
  for (const row of rows) {
    const cat = row.category_name ?? 'Другое';
    byCategory[cat] = (byCategory[cat] ?? 0) + parseFloat(row.amount);
  }

  const total = rows.reduce((s, r) => s + parseFloat(r.amount), 0);
  const sorted = Object.entries(byCategory).sort(([, a], [, b]) => b - a).slice(0, 5);

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

async function analyticsTopExpensesMonth(bot, chatId, userId) {
  const now = new Date();

  const { data: rows } = await queryAll(
    `SELECT t.amount, c.name AS category_name
     FROM transactions t
     JOIN categories c ON t.category_id = c.id
     WHERE t.user_id = $1 AND t.type = 'expense'
       AND c.is_system = false
       AND t.transaction_date >= $2 AND t.transaction_date < $3`,
    [userId, getMonthStart(now), getNextMonthStart(now)]
  );

  if (!rows?.length) { await bot.sendMessage(chatId, 'В этом месяце расходов пока нет 💛', MENU_KEYBOARD); return; }

  const byCategory = {};
  for (const row of rows) {
    const cat = row.category_name ?? 'Другое';
    byCategory[cat] = (byCategory[cat] ?? 0) + parseFloat(row.amount);
  }

  const total = rows.reduce((s, r) => s + parseFloat(r.amount), 0);
  const sorted = Object.entries(byCategory).sort(([, a], [, b]) => b - a).slice(0, 5);

  let text = `📊 В этом месяце топ категорий трат:\n\n`;
  sorted.forEach(([cat, sum], i) => {
    const pct = total > 0 ? Math.round((sum / total) * 100) : 0;
    text += `${i + 1}. ${cat} — ${formatNum(sum)} ₽ (${pct}%)\n`;
  });

  await bot.sendMessage(chatId, text.trim(), MENU_KEYBOARD);
}

async function analyticsCompare(bot, chatId, userId) {
  const now = new Date();
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [{ data: currData }, { data: prevData }] = await Promise.all([
    queryAll(
      `SELECT amount, type FROM transactions WHERE user_id=$1 AND transaction_date>=$2 AND transaction_date<$3`,
      [userId, getMonthStart(now), getNextMonthStart(now)]
    ),
    queryAll(
      `SELECT amount, type FROM transactions WHERE user_id=$1 AND transaction_date>=$2 AND transaction_date<$3`,
      [userId, getMonthStart(prevDate), getMonthStart(now)]
    ),
  ]);

  const sum = (rows, typeCheck) =>
    (rows ?? []).filter(t => typeCheck(t.type)).reduce((s, t) => s + parseFloat(t.amount), 0);

  const currIncome  = sum(currData, t => t === 'income');
  const currExpense = sum(currData, t => t !== 'income');
  const currPct = currIncome > 0 ? Math.round((currExpense / currIncome) * 100) : 0;

  const prevIncome  = sum(prevData, t => t === 'income');
  const prevExpense = sum(prevData, t => t !== 'income');
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

async function analyticsForecast(bot, chatId, userId) {
  const spent = await getBudgetSpent(userId);
  if (spent === 0) { await bot.sendMessage(chatId, 'Пока нет данных для прогноза — внеси первые расходы 💛', MENU_KEYBOARD); return; }

  const { data: budget } = await queryOne(
    `SELECT amount FROM budget WHERE user_id=$1 AND month>=$2 AND month<$3`,
    [userId, getMonthStart(), getNextMonthStart()]
  );

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
    text += forecastPct <= 100
      ? `Без учёта крупных трат, если сохранишь темп расходов — израсходуешь ${Math.round(forecastPct)}% своего бюджета 💛`
      : `⚠️ Без учёта крупных трат, если сохранишь темп расходов — перерасходуешь бюджет на ${Math.round(forecastPct - 100)}%`;
  }

  await bot.sendMessage(chatId, text, MENU_KEYBOARD);
}

async function showMonthlyReport(bot, chatId, userId) {
  const now = new Date();
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const startDate = getMonthStart(prevDate);
  const endDate = getMonthStart(now);
  const monthName = MONTHS_GEN[prevDate.getMonth()];

  console.log('[monthly_analytics] fetching for month:', startDate);

  const { data: txData } = await queryAll(
    `SELECT t.amount, t.type, c.name AS category_name
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.user_id = $1 AND t.transaction_date >= $2 AND t.transaction_date < $3`,
    [userId, startDate, endDate]
  );

  const rows = txData ?? [];
  const income  = rows.filter(t => t.type === 'income').reduce((s, t) => s + parseFloat(t.amount), 0);
  const expense = rows.filter(t => t.type !== 'income').reduce((s, t) => s + parseFloat(t.amount), 0);

  console.log('[monthly_analytics] income:', income, 'expenses:', expense);

  if (rows.length === 0) {
    await bot.sendMessage(chatId, 'За прошлый месяц записей не найдено.\nДанные появятся когда ты начнёшь вести записи 💛', MENU_KEYBOARD);
    return;
  }

  const byCategory = {};
  for (const row of rows.filter(t => t.type !== 'income')) {
    const cat = row.category_name ?? 'Другое';
    byCategory[cat] = (byCategory[cat] ?? 0) + parseFloat(row.amount);
  }
  const top5 = Object.entries(byCategory).sort(([, a], [, b]) => b - a).slice(0, 5);

  const { data: goals } = await queryAll(
    `SELECT name, future_value, initial_saved FROM goals WHERE user_id = $1 AND status = 'active' LIMIT 1`,
    [userId]
  );

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
    const { data: catData } = await queryOne(`SELECT id FROM categories WHERE name = 'Цель' LIMIT 1`);
    let goalTxTotal = 0;
    if (catData?.id) {
      const { data: sum } = await queryOne(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE user_id=$1 AND category_id=$2`,
        [userId, catData.id]
      );
      goalTxTotal = parseFloat(sum?.total ?? 0);
    }
    const accumulated = (g.initial_saved ?? 0) + goalTxTotal;
    const percent = Math.min(100, Math.round((accumulated / g.future_value) * 100));
    text += `\n🎯 Прогресс по цели «${g.name}»: ${percent}%`;
  }

  await bot.sendMessage(chatId, text.trim(), MENU_KEYBOARD);
}

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
        [{ text: 'Прогноз до конца месяца', callback_data: 'analytics_forecast' }],
      ],
    },
  });
}

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
  if (!userId) { await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start 🙏'); return; }

  const access = await getUserAccess(userId);
  if (!FEATURE_ACCESS[action]?.includes(access)) { await showPaywall(bot, chatId); return; }

  switch (action) {
    case 'analytics_expenses':     await analyticsExpenses(bot, chatId, userId); break;
    case 'analytics_income':       await analyticsIncome(bot, chatId, userId); break;
    case 'analytics_budget_left':  await showBudget(bot, chatId, telegramId); break;
    case 'analytics_goal_progress': await showGoal(bot, chatId, telegramId); break;
    case 'analytics_top_expenses': await analyticsTopExpenses(bot, chatId, userId); break;
    case 'analytics_top_month':    await analyticsTopExpensesMonth(bot, chatId, userId); break;
    case 'analytics_compare':      await analyticsCompare(bot, chatId, userId); break;
    case 'analytics_forecast':     await analyticsForecast(bot, chatId, userId); break;
  }
}

export async function sendMonthlyAnalytics(bot) {
  const today = new Date();
  if (today.getDate() !== 1) return;

  const prevDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastMonthStart = getMonthStart(prevDate);
  const thisMonthStart = getMonthStart(today);
  const monthName = MONTHS_NOM[prevDate.getMonth()];

  const { data: users } = await queryAll(
    `SELECT id, external_id FROM users WHERE channel = 'telegram' AND terms_accepted_at IS NOT NULL`
  );
  if (!users?.length) return;

  for (const user of users) {
    try {
      const { data: existing } = await queryOne(
        `SELECT id FROM notifications WHERE user_id=$1 AND type='analytics_ready' AND month=$2`,
        [user.id, lastMonthStart]
      );
      if (existing) continue;

      const { data: txCheck } = await queryOne(
        `SELECT id FROM transactions WHERE user_id=$1 AND transaction_date>=$2 AND transaction_date<$3 LIMIT 1`,
        [user.id, lastMonthStart, thisMonthStart]
      );
      if (!txCheck) continue;

      await bot.sendMessage(user.external_id, `Аналитика за ${monthName} уже готова 📊\nХочешь посмотреть?`, {
        reply_markup: { inline_keyboard: [[
          { text: 'Показать аналитику', callback_data: 'show_monthly_analytics' },
          { text: 'Позже', callback_data: 'analytics_monthly_skip' },
        ]]},
      });

      await queryOne(
        `INSERT INTO notifications (user_id, type, month) VALUES ($1, 'analytics_ready', $2) RETURNING id`,
        [user.id, lastMonthStart]
      );
    } catch (err) {
      console.error(`Monthly analytics error for user ${user.external_id}:`, err.message);
    }
  }
}
