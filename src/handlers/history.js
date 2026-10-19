import { supabase } from '../db.js';
import { userStates } from '../state.js';
import { inTz } from '../utils/dateTz.js';
import { buildHistoryText } from '../utils/historyText.js';

// ── Хелперы дат ───────────────────────────────────────────────────────────────

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function today() {
  return dateStr(inTz());
}

function daysAgo(n) {
  const d = inTz();
  d.setDate(d.getDate() - n);
  return dateStr(d);
}

function currentMonthStart() {
  const d = inTz();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function monthsAgo(n) {
  const d = inTz();
  d.setMonth(d.getMonth() - n);
  return dateStr(d);
}

function yearAgo() {
  const d = inTz();
  d.setFullYear(d.getFullYear() - 1);
  return dateStr(d);
}

// Парсит ДД.ММ.ГГГГ → 'YYYY-MM-DD' или null
function parseDate(text) {
  const match = text.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!match) return null;
  const [, d, m, y] = match;
  if (+m < 1 || +m > 12 || +d < 1 || +d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ── DB ────────────────────────────────────────────────────────────────────────

async function getUserId(telegramId) {
  const { data } = await supabase
    .from('users')
    .select('id')
    .eq('external_id', String(telegramId))
    .single();
  return data?.id ?? null;
}

const LIST_LIMIT = 50;

async function fetchTransactions(userId, startDate, endDate, typeFilter) {
  let query = supabase
    .from('transactions')
    .select('amount, type, transaction_date, comment, categories(name, is_system)')
    .eq('user_id', userId)
    .gte('transaction_date', startDate)
    .lte('transaction_date', endDate)
    .order('transaction_date', { ascending: false })
    .limit(LIST_LIMIT);

  if (typeFilter === 'expense') {
    query = query.in('type', ['expense', 'goal']);
  } else if (typeFilter === 'income') {
    query = query.eq('type', 'income');
  }

  const { data } = await query;
  return data ?? [];
}

// Итоги всегда по ВСЕМ транзакциям периода, без фильтра типа. Заодно считаем, сколько операций в периоде
// (список ниже показывает не больше LIST_LIMIT последних, поэтому «Всего» берём отсюда, а не из длины списка).
async function fetchTotals(userId, startDate, endDate) {
  const { data } = await supabase
    .from('transactions')
    .select('amount, type')
    .eq('user_id', userId)
    .gte('transaction_date', startDate)
    .lte('transaction_date', endDate);

  const rows = data ?? [];
  const sumIncome  = rows.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const sumExpense = rows.filter(t => t.type !== 'income').reduce((s, t) => s + t.amount, 0);
  const countIncome = rows.filter(t => t.type === 'income').length;
  return { sumIncome, sumExpense, countAll: rows.length, countIncome, countExpense: rows.length - countIncome };
}

// ── Лимиты по дате ────────────────────────────────────────────────────────────

function applyDateLimit(startDate) {
  const limit = yearAgo(); // 12 месяцев назад
  if (startDate < limit) {
    return { effectiveStart: limit, limitNote: 'Показаны записи за последние 12 месяцев' };
  }
  return { effectiveStart: startDate, limitNote: null };
}

// ── Шаг 1: выбор периода ─────────────────────────────────────────────────────

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

// ── Шаг 2: фильтр по типу ────────────────────────────────────────────────────

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

// ── Шаг 3: запрос и вывод ─────────────────────────────────────────────────────

async function showHistoryResult(bot, chatId, telegramId, startDate, endDate, typeFilter) {
  const userId = await getUserId(telegramId);
  if (!userId) {
    await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start 🙏');
    return;
  }

  const { effectiveStart, limitNote } = applyDateLimit(startDate);

  // Два запроса параллельно: список (с фильтром) и итоги (без фильтра)
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

  const total = typeFilter === 'expense' ? totals.countExpense : typeFilter === 'income' ? totals.countIncome : totals.countAll;
  const text = buildHistoryText(transactions, totals, effectiveStart, endDate, limitNote, { total });
  await bot.sendMessage(chatId, text, actionKeyboard);
}

// ── Обработчик текстового ввода дат (из handleMessage) ────────────────────────

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

// ── Обработчик кнопок history: ───────────────────────────────────────────────

export async function handleHistoryCallback(bot, query) {
  const chatId = query.message.chat.id;
  const telegramId = query.from.id;
  const action = query.data;

  await bot.answerCallbackQuery(query.id);

  // Сброс — вернуться к выбору периода
  if (action === 'history:new') {
    userStates.delete(telegramId);
    await showHistory(bot, chatId);
    return;
  }

  // ── Выбор периода — сохраняем даты и спрашиваем тип ─────────────────────

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

  // ── Выбор типа — guard: только если state.awaitingHistory === 'type_filter' ─

  if (action === 'history:all' || action === 'history:expenses' || action === 'history:income') {
    const state = userStates.get(telegramId);
    // Игнорируем нажатие если состояние не соответствует этому шагу
    // (защита от повторного срабатывания старых кнопок)
    if (state?.awaitingHistory !== 'type_filter' || !state?.startDate) return;

    const { startDate, endDate } = state;
    userStates.delete(telegramId);

    const typeFilter =
      action === 'history:expenses' ? 'expense' :
      action === 'history:income'   ? 'income'  : null;

    await showHistoryResult(bot, chatId, telegramId, startDate, endDate, typeFilter);
  }
}
