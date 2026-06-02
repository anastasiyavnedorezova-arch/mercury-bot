import { queryOne, run } from '../db.js';
import { getUserAccess } from '../utils/access.js';
import { userStates } from '../state.js';
import { parseAmount } from '../utils/parseAmount.js';

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
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
}

function getNextMonthStart() {
  const now = new Date();
  const y = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
  const m = now.getMonth() === 11 ? 1 : now.getMonth() + 2;
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

function currentMonthName() {
  return MONTHS_RU_NAMES[new Date().getMonth()];
}

function formatNum(n) {
  return Math.round(n).toLocaleString('ru-RU');
}

function progressBar(percent) {
  const filled = Math.round(Math.min(percent, 100) / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${Math.round(percent)}%`;
}

async function getUserId(telegramId) {
  const { data } = await queryOne(
    `SELECT id FROM users WHERE external_id = $1 AND channel = 'telegram'`,
    [String(telegramId)]
  );
  return data?.id ?? null;
}

async function getSpentThisMonth(userId) {
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

async function showForecast(bot, chatId, userId, budget) {
  const spent = await getSpentThisMonth(userId);

  if (spent === 0) {
    await bot.sendMessage(chatId, 'Пока нет данных для прогноза — внеси первые расходы 💛', MENU_KEYBOARD);
    return;
  }

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

export async function showBudget(bot, chatId, telegramId) {
  const userId = await getUserId(telegramId);
  if (!userId) {
    await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start 🙏');
    return;
  }

  const access = await getUserAccess(userId);

  if (access === 'free') {
    await bot.sendMessage(
      chatId,
      'Бюджет доступен в подписке. Хочешь активировать 30 дней бесплатно? 💛',
      {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Активировать trial', callback_data: 'budget:trial' },
            { text: 'Не сейчас', callback_data: 'menu:main' },
          ]],
        },
      }
    );
    return;
  }

  const { data: budget } = await queryOne(
    `SELECT * FROM budget
     WHERE user_id = $1 AND month >= $2 AND month < $3`,
    [userId, getMonthStart(), getNextMonthStart()]
  );

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

  const spent = await getSpentThisMonth(userId);
  const remaining = budget.amount - spent;
  const percent = budget.amount > 0 ? (spent / budget.amount) * 100 : 0;

  await bot.sendMessage(
    chatId,
    `💰 Бюджет на ${currentMonthName()}: ${formatNum(budget.amount)} ₽\n\n` +
    `✅ Потрачено: ${formatNum(spent)} ₽ (${Math.round(percent)}%)\n` +
    `💳 Остаток: ${formatNum(remaining)} ₽\n\n` +
    `${progressBar(percent)}`,
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
    await run(
      `UPDATE budget SET amount = $1 WHERE user_id = $2 AND month = $3`,
      [amount, userId, monthStart]
    );
    userStates.delete(telegramId);
    await bot.sendMessage(chatId, `Бюджет обновлён: ${formatNum(amount)} ₽ 💰`, MENU_KEYBOARD);
  } else {
    await run(
      `INSERT INTO budget (user_id, month, amount) VALUES ($1, $2, $3)`,
      [userId, monthStart, amount]
    );
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

    const { data: budget } = await queryOne(
      `SELECT amount FROM budget
       WHERE user_id = $1 AND month >= $2 AND month < $3`,
      [userId, getMonthStart(), getNextMonthStart()]
    );

    await showForecast(bot, chatId, userId, budget ?? null);
    return;
  }

  if (action === 'budget:edit') {
    const userId = await getUserId(telegramId);
    if (!userId) return;

    const { data: budget } = await queryOne(
      `SELECT amount FROM budget
       WHERE user_id = $1 AND month >= $2 AND month < $3`,
      [userId, getMonthStart(), getNextMonthStart()]
    );

    userStates.set(telegramId, { awaitingBudget: true, editing: true });
    await bot.sendMessage(
      chatId,
      `Текущий бюджет: ${formatNum(budget?.amount ?? 0)} ₽\n` +
      `Напиши новую сумму бюджета на этот месяц 👇`
    );
  }
}
