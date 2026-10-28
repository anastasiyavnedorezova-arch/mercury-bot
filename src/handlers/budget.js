import { supabase } from '../db.js';
import { getUserAccess } from '../utils/access.js';
import { userStates } from '../state.js';
import { parseAmount } from '../utils/parseAmount.js';
import { inTz } from '../utils/dateTz.js';
import { findUserIdByExternalId } from '../utils/findUser.js';
import { hadTrial } from '../utils/trial.js';
import { budgetPaywall } from '../utils/paywall.js';
import { getMonthExpenses, buildForecast, forecastText } from '../utils/budgetCalc.js';

// ── Вспомогательные функции ───────────────────────────────────────────────────

const MONTHS_RU_NAMES = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

const MENU_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]],
  },
};

function getMonthStart() {
  const now = inTz();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

function getNextMonthStart() {
  const now = inTz();
  const y = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
  const m = now.getMonth() === 11 ? 1 : now.getMonth() + 2;
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

function currentMonthName() {
  return MONTHS_RU_NAMES[inTz().getMonth()];
}

function formatNum(n) {
  return Math.round(n).toLocaleString('ru-RU');
}

function progressBar(percent) {
  const filled = Math.round(Math.min(percent, 100) / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${Math.round(percent)}%`;
}

const getUserId = (telegramId) => findUserIdByExternalId(supabase, telegramId);

// Все расходы месяца, включая крупные (жильё, кредиты, цели) — так же, как в кабинете
async function getMonthStats(userId) {
  return getMonthExpenses(supabase, userId, getMonthStart(), getNextMonthStart());
}

// ── Прогноз до конца месяца ───────────────────────────────────────────────────

async function showForecast(bot, chatId, userId, budget) {
  const stats = await getMonthStats(userId);

  if (stats.total === 0) {
    await bot.sendMessage(chatId, 'Пока нет данных для прогноза — внеси первые расходы 💛', MENU_KEYBOARD);
    return;
  }

  const now = inTz();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const f = buildForecast(stats, now.getDate(), daysInMonth);

  await bot.sendMessage(chatId, forecastText(f, budget?.amount), MENU_KEYBOARD);
}

// ── Точка входа: /budget и menu:budget ───────────────────────────────────────

export async function showBudget(bot, chatId, telegramId) {
  const userId = await getUserId(telegramId);
  if (!userId) {
    await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start 🙏');
    return;
  }

  const access = await getUserAccess(userId);

  if (access === 'free') {
    const paywall = budgetPaywall(await hadTrial(supabase, userId));
    await bot.sendMessage(chatId, paywall.text, { reply_markup: paywall.keyboard });
    return;
  }

  const { data: budget } = await supabase
    .from('budget')
    .select('*')
    .eq('user_id', userId)
    .gte('month', getMonthStart())
    .lt('month', getNextMonthStart())
    .maybeSingle();

  if (!budget) {
    userStates.set(telegramId, { awaitingBudget: true });
    await bot.sendMessage(
      chatId,
      `💰 Бюджет на этот месяц не установлен.\n\n` +
      `Бюджет помогает контролировать расходы — я буду следить ` +
      `за темпом трат и предупрежу если появится риск перерасхода.\n\n` +
      `Напиши сумму бюджета на этот месяц 👇`
    );
    return;
  }

  const { total: spent } = await getMonthStats(userId);
  const remaining = budget.amount - spent;
  const percent = budget.amount > 0 ? (spent / budget.amount) * 100 : 0;

  await bot.sendMessage(
    chatId,
    `💰 Бюджет на ${currentMonthName()}: ${formatNum(budget.amount)} ₽\n\n` +
    `✅ Потрачено: ${formatNum(spent)} ₽ (${Math.round(percent)}%)\n` +
    `💳 Остаток: ${formatNum(remaining)} ₽\n\n` +
    `${progressBar(percent)}\n\n` +
    `В бюджет входят все расходы, включая жильё и кредиты.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📊 Прогноз до конца месяца', callback_data: 'budget:forecast' }],
          [
            { text: '✏️ Изменить бюджет', callback_data: 'budget:edit' },
            { text: '☰ Главное меню', callback_data: 'menu:main' },
          ],
        ],
      },
    }
  );
}

// ── Ввод суммы бюджета (вызывается из handleMessage) ─────────────────────────

export async function handleBudgetState(bot, msg) {
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;

  const state = userStates.get(telegramId);
  if (!state?.awaitingBudget) return false;

  const amount = parseAmount(msg.text?.trim());
  if (!amount || amount <= 0) {
    await bot.sendMessage(chatId, 'Не смог распознать сумму. Напиши числом, например: 3000000 или 3 миллиона 👇');
    return true;
  }

  const userId = await getUserId(telegramId);
  if (!userId) {
    userStates.delete(telegramId);
    await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start 🙏');
    return true;
  }

  const monthStart = getMonthStart();

  if (state.editing) {
    await supabase.from('budget')
      .update({ amount })
      .eq('user_id', userId)
      .eq('month', monthStart);
    userStates.delete(telegramId);
    await bot.sendMessage(chatId, `Бюджет обновлён: ${formatNum(amount)} ₽ 💰`, MENU_KEYBOARD);
  } else {
    await supabase.from('budget').insert({ user_id: userId, month: monthStart, amount });
    userStates.delete(telegramId);
    await bot.sendMessage(
      chatId,
      `Бюджет на ${currentMonthName()} установлен: ${formatNum(amount)} ₽ 💰\n\n` +
      `Я буду следить за твоими расходами и предупрежу ` +
      `если появится риск перерасхода 💛`,
      MENU_KEYBOARD
    );
  }

  return true;
}

// ── Кнопки budget: ───────────────────────────────────────────────────────────

export async function handleBudgetCallback(bot, query) {
  const chatId = query.message.chat.id;
  const telegramId = query.from.id;
  const action = query.data;

  await bot.answerCallbackQuery(query.id);

  if (action === 'budget:trial') {
    await bot.sendMessage(
      chatId,
      'Активация пробного периода скоро будет доступна 🔧 Напишем тебе, когда откроем!',
      MENU_KEYBOARD
    );
    return;
  }

  if (action === 'budget:forecast') {
    const userId = await getUserId(telegramId);
    if (!userId) return;

    const { data: budget } = await supabase
      .from('budget')
      .select('amount')
      .eq('user_id', userId)
      .eq('month', getMonthStart())
      .single();

    await showForecast(bot, chatId, userId, budget ?? null);
    return;
  }

  if (action === 'budget:edit') {
    const userId = await getUserId(telegramId);
    if (!userId) return;

    const { data: budget } = await supabase
      .from('budget')
      .select('amount')
      .eq('user_id', userId)
      .eq('month', getMonthStart())
      .single();

    userStates.set(telegramId, { awaitingBudget: true, editing: true });
    await bot.sendMessage(
      chatId,
      `Текущий бюджет: ${formatNum(budget?.amount ?? 0)} ₽\n` +
      `Напиши новую сумму бюджета на этот месяц 👇`
    );
  }
}
