import { queryOne, queryAll } from '../db.js';
import { userStates } from '../state.js';

const MONTHS_RU = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function today() { return dateStr(new Date()); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return dateStr(d); }
function currentMonthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function monthsAgo(n) { const d = new Date(); d.setMonth(d.getMonth() - n); return dateStr(d); }
function yearAgo() { const d = new Date(); d.setFullYear(d.getFullYear() - 1); return dateStr(d); }

function formatNum(n) { return Math.round(n).toLocaleString('ru-RU'); }
function formatRuDate(ds) {
  const [, m, d] = ds.split('-');
  return `${parseInt(d)} ${MONTHS_RU[parseInt(m) - 1]}`;
}
function parseDate(text) {
  const match = text.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!match) return null;
  const [, d, m, y] = match;
  if (+m < 1 || +m > 12 || +d < 1 || +d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

async function getUserId(telegramId) {
  const { data } = await queryOne(
    `SELECT id FROM users WHERE external_id = $1 AND channel = 'telegram'`,
    [String(telegramId)]
  );
  return data?.id ?? null;
}

async function fetchTransactions(userId, startDate, endDate, typeFilter) {
  const params = [userId, startDate, endDate];
  let typeClause = '';
  if (typeFilter === 'expense') {
    typeClause = `AND t.type IN ('expense', 'goal')`;
  } else if (typeFilter === 'income') {
    typeClause = `AND t.type = 'income'`;
  }

  const { data } = await queryAll(
    `SELECT t.amount, t.type, t.transaction_date, t.comment,
            json_build_object('name', c.name, 'is_system', c.is_system) AS categories
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.user_id = $1
       AND t.transaction_date >= $2
       AND t.transaction_date <= $3
       ${typeClause}
     ORDER BY t.transaction_date DESC
     LIMIT 50`,
    params
  );
  return data ?? [];
}

async function fetchTotals(userId, startDate, endDate) {
  const { data } = await queryAll(
    `SELECT amount, type FROM transactions
     WHERE user_id = $1
       AND transaction_date >= $2
       AND transaction_date <= $3`,
    [userId, startDate, endDate]
  );
  const rows = data ?? [];
  const sumIncome  = rows.filter(t => t.type === 'income').reduce((s, t) => s + parseFloat(t.amount), 0);
  const sumExpense = rows.filter(t => t.type !== 'income').reduce((s, t) => s + parseFloat(t.amount), 0);
  return { sumIncome, sumExpense };
}

function applyDateLimit(startDate) {
  const limit = yearAgo();
  if (startDate < limit) {
    return { effectiveStart: limit, limitNote: 'Показаны записи за последние 12 месяцев' };
  }
  return { effectiveStart: startDate, limitNote: null };
}

function buildHistoryText(transactions, totals, startDate, endDate, limitNote) {
  const { sumIncome, sumExpense } = totals;
  const balance = sumIncome - sumExpense;

  let text =
    `📋 История за ${formatRuDate(startDate)} — ${formatRuDate(endDate)}\n` +
    `Всего: ${transactions.length} операций\n`;

  if (limitNote) text += `ℹ️ ${limitNote}\n`;
  text += '\n';

  const byDate = {};
  for (const t of transactions) {
    const d = t.transaction_date instanceof Date
      ? dateStr(t.transaction_date)
      : String(t.transaction_date).slice(0, 10);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(t);
  }

  for (const [date, txs] of Object.entries(byDate)) {
    text += `📅 ${formatRuDate(date)}\n`;
    for (const t of txs) {
      const sign = t.type === 'income' ? '+' : '-';
      const cat = t.categories?.name ?? 'Другое';
      const comment = t.comment ? ` (${t.comment})` : '';
      text += `- ${cat}${comment} ${sign} ${formatNum(t.amount)} ₽\n`;
    }
    text += '\n';
  }

  const balanceStr = balance > 0 ? `+${formatNum(balance)}` :
                     balance < 0 ? `-${formatNum(Math.abs(balance))}` : '0';
  text +=
    `💰 Доходы: +${formatNum(sumIncome)} ₽\n` +
    `💸 Расходы: -${formatNum(sumExpense)} ₽\n` +
    `📊 Баланс: ${balanceStr} ₽`;

  if (text.length > 3900) {
    text = text.slice(0, 3850) + '\n\n…(сокращено, показаны первые записи)';
  }

  return text;
}

export async function showHistory(bot, chatId) {
  await bot.sendMessage(
    chatId,
    '📋 За какой период показать историю?',
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'За эту неделю', callback_data: 'history:week' },
            { text: 'За этот месяц', callback_data: 'history:month' },
          ],
          [
            { text: 'За 3 месяца', callback_data: 'history:3months' },
            { text: 'Выбрать даты', callback_data: 'history:custom' },
          ],
        ],
      },
    }
  );
}

async function askTypeFilter(bot, chatId) {
  await bot.sendMessage(
    chatId,
    'Показать все операции или только определённый тип?',
    {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Все операции', callback_data: 'history:all' },
          { text: 'Только расходы', callback_data: 'history:expenses' },
          { text: 'Только доходы', callback_data: 'history:income' },
        ]],
      },
    }
  );
}

async function showHistoryResult(bot, chatId, telegramId, startDate, endDate, typeFilter) {
  const userId = await getUserId(telegramId);
  if (!userId) {
    await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start 🙏');
    return;
  }

  const { effectiveStart, limitNote } = applyDateLimit(startDate);

  const [transactions, totals] = await Promise.all([
    fetchTransactions(userId, effectiveStart, endDate, typeFilter),
    fetchTotals(userId, effectiveStart, endDate),
  ]);

  const actionKeyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔄 Новый запрос', callback_data: 'history:new' }],
        [{ text: '☰ Главное меню', callback_data: 'menu:main' }],
      ],
    },
  };

  if (transactions.length === 0) {
    await bot.sendMessage(
      chatId,
      'За выбранный период записей нет 🤷',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Выбрать другой период', callback_data: 'history:new' }],
            [{ text: '☰ Главное меню', callback_data: 'menu:main' }],
          ],
        },
      }
    );
    return;
  }

  const text = buildHistoryText(transactions, totals, effectiveStart, endDate, limitNote);
  await bot.sendMessage(chatId, text, actionKeyboard);
}

export async function handleHistoryState(bot, msg) {
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;

  const state = userStates.get(telegramId);
  if (!state?.awaitingHistory) return false;

  if (state.awaitingHistory === 'custom_start') {
    const parsed = parseDate(msg.text.trim());
    if (!parsed) {
      await bot.sendMessage(chatId, 'Не распознал дату. Формат: ДД.ММ.ГГГГ, например 01.01.2026 👇');
      return true;
    }
    userStates.set(telegramId, { awaitingHistory: 'custom_end', startDate: parsed });
    await bot.sendMessage(chatId, 'Напиши конечную дату в формате ДД.ММ.ГГГГ 👇');
    return true;
  }

  if (state.awaitingHistory === 'custom_end') {
    const parsed = parseDate(msg.text.trim());
    if (!parsed) {
      await bot.sendMessage(chatId, 'Не распознал дату. Формат: ДД.ММ.ГГГГ, например 30.04.2026 👇');
      return true;
    }
    if (parsed < state.startDate) {
      await bot.sendMessage(chatId, 'Конечная дата должна быть не раньше начальной. Попробуй ещё раз 👇');
      return true;
    }
    userStates.set(telegramId, { awaitingHistory: 'type_filter', startDate: state.startDate, endDate: parsed });
    await askTypeFilter(bot, chatId);
    return true;
  }

  return false;
}

export async function handleHistoryCallback(bot, query) {
  const chatId = query.message.chat.id;
  const telegramId = query.from.id;
  const action = query.data;

  await bot.answerCallbackQuery(query.id);

  if (action === 'history:new') {
    userStates.delete(telegramId);
    await showHistory(bot, chatId);
    return;
  }

  const todayStr = today();

  if (action === 'history:week') {
    userStates.set(telegramId, { awaitingHistory: 'type_filter', startDate: daysAgo(7), endDate: todayStr });
    await askTypeFilter(bot, chatId);
    return;
  }
  if (action === 'history:month') {
    userStates.set(telegramId, { awaitingHistory: 'type_filter', startDate: currentMonthStart(), endDate: todayStr });
    await askTypeFilter(bot, chatId);
    return;
  }
  if (action === 'history:3months') {
    userStates.set(telegramId, { awaitingHistory: 'type_filter', startDate: monthsAgo(3), endDate: todayStr });
    await askTypeFilter(bot, chatId);
    return;
  }
  if (action === 'history:custom') {
    userStates.set(telegramId, { awaitingHistory: 'custom_start' });
    await bot.sendMessage(chatId, 'Напиши начальную дату в формате ДД.ММ.ГГГГ 👇');
    return;
  }

  if (action === 'history:all' || action === 'history:expenses' || action === 'history:income') {
    const state = userStates.get(telegramId);
    if (state?.awaitingHistory !== 'type_filter' || !state?.startDate) return;

    const { startDate, endDate } = state;
    userStates.delete(telegramId);

    const typeFilter =
      action === 'history:expenses' ? 'expense' :
      action === 'history:income'   ? 'income'  : null;

    await showHistoryResult(bot, chatId, telegramId, startDate, endDate, typeFilter);
  }
}
