import { showGoal } from './goal.js';
import { showBudget } from './budget.js';
import { showHistory } from './history.js';
import { showAnalyticsMenu } from './analytics.js';
import { showFeedback } from './feedback.js';
import { showSubscription } from './subscription.js';
import { showCategories } from './categories.js';
import { userStates } from '../state.js';
import { recordHint, isWebBot } from '../utils/botTexts.js';
import { baseUrl } from '../emails/config.js';

// Порядок кнопок: запись, история, категории, цель, бюджет, аналитика, подписка, личный кабинет, обратная связь, вопрос
const MENU_BUTTONS = [
  // Ширину кнопки задаёт Telegram: одна в строке — на всю ширину, две — по половине
  [
    { text: 'Записать расход или доход', callback_data: 'menu:add' },
  ],
  [
    { text: 'История транзакций', callback_data: 'menu:history' },
    { text: 'Мои категории', callback_data: 'menu:categories' },
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
    { text: 'Личный кабинет', url: 'CABINET_LOGIN' },
  ],
  [
    { text: 'Обратная связь', callback_data: 'menu:feedback' },
    { text: 'Задать вопрос', callback_data: 'ask_question' },
  ],
];

// Кнопка «Личный кабинет» ведёт на страницу входа (на stage — на stage). В веб-чате её нет: человек уже в кабинете.
export function mainMenuButtons(bot) {
  const rows = isWebBot(bot) ? MENU_BUTTONS.filter((r) => !r.some((b) => b.url)) : MENU_BUTTONS;
  return rows.map((r) => r.map((b) => (b.url ? { ...b, url: `${baseUrl()}/cabinet/login` } : b)));
}

export async function showMainMenu(bot, chatId) {
  await bot.sendMessage(chatId, 'Главное меню 👇', {
    reply_markup: { inline_keyboard: mainMenuButtons(bot) },
  });
}

export async function handleMenuCallback(bot, query) {
  const chatId = query.message.chat.id;
  const action = query.data;

  await bot.answerCallbackQuery(query.id);

  if (action === 'menu:add') {
    await bot.sendMessage(
      chatId,
      recordHint(bot)
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

  if (action === 'menu:categories') {
    await showCategories(bot, chatId, query.from.id);
    return;
  }

  if (action === 'ask_question') {
    userStates.set(query.from.id, { awaitingQuestion: true });
    await bot.sendMessage(
      chatId,
      'Задай мне любой вопрос о работе Финника 💛\n' +
      'Например: «Как посмотреть аналитику?» или «Как изменить бюджет?»'
    );
    return;
  }

  // Заглушка для остальных разделов
  await bot.sendMessage(chatId, 'Раздел в разработке 🔧 Скоро будет готово!');
}
