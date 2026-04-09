import { showGoal } from './goal.js';
import { showBudget } from './budget.js';
import { showHistory } from './history.js';
import { showAnalyticsMenu } from './analytics.js';
import { showFeedback } from './feedback.js';
import { showSubscription } from './subscription.js';

const MENU_BUTTONS = [
  [
    { text: 'Записать расход или доход', callback_data: 'menu:add' },
    { text: 'История транзакций', callback_data: 'menu:history' },
  ],
  [
    { text: 'Моя цель', callback_data: 'menu:goal' },
    { text: 'Мой бюджет', callback_data: 'menu:budget' },
  ],
  [
    { text: 'Аналитика', callback_data: 'menu:analytics' },
    { text: 'Управление подпиской', callback_data: 'menu:subscription' },
  ],
  [
    { text: 'Обратная связь', callback_data: 'menu:feedback' },
  ],
];

export async function showMainMenu(bot, chatId) {
  await bot.sendMessage(chatId, 'Главное меню 👇', {
    reply_markup: { inline_keyboard: MENU_BUTTONS },
  });
}

export async function handleMenuCallback(bot, query) {
  const chatId = query.message.chat.id;
  const action = query.data;

  await bot.answerCallbackQuery(query.id);

  if (action === 'menu:add') {
    await bot.sendMessage(
      chatId,
      'Напиши мне о своей трате или доходе в свободной форме.\nНапример: «продукты 1800», «такси 450», «зарплата 120000» 👇'
    );
    return;
  }

  if (action === 'menu:goal') {
    await showGoal(bot, chatId, query.from.id);
    return;
  }

  if (action === 'menu:budget') {
    await showBudget(bot, chatId, query.from.id);
    return;
  }

  if (action === 'menu:history') {
    await showHistory(bot, chatId);
    return;
  }

  if (action === 'menu:analytics') {
    await showAnalyticsMenu(bot, chatId);
    return;
  }

  if (action === 'menu:feedback') {
    await showFeedback(bot, chatId, query.from.id);
    return;
  }

  if (action === 'menu:subscription') {
    await showSubscription(bot, chatId, query.from.id);
    return;
  }

  // Заглушка для остальных разделов
  await bot.sendMessage(chatId, 'Раздел в разработке 🔧 Скоро будет готово!');
}
