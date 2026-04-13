import TelegramBot from 'node-telegram-bot-api';
import 'dotenv/config';
import { handleStart } from './handlers/start.js';
import { handleMessage, handleCategorySelection } from './handlers/message.js';
import { showMainMenu, handleMenuCallback } from './handlers/menu.js';
import { handleOnboardingCallback, requireTerms } from './handlers/onboarding.js';
import { handleTransactionCallback } from './handlers/transaction.js';
import { showGoal, handleGoalCallback } from './handlers/goal.js';
import { showBudget, handleBudgetCallback } from './handlers/budget.js';
import { showHistory, handleHistoryCallback } from './handlers/history.js';
import { showAnalyticsMenu, handleAnalyticsCallback } from './handlers/analytics.js';
import { showFeedback } from './handlers/feedback.js';
import { showSubscription, handleSubscriptionCallback, activateSubscription } from './handlers/subscription.js';
import { startScheduler } from './notifications/scheduler.js';
import { handleVoiceMessage } from './handlers/voice.js';
import { startWebhookServer } from './webhook.js';
import { userStates } from './state.js';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

bot.getMe().then(() => {
  console.log('Mercury bot started');
}).catch(err => {
  console.error('Bot connection error:', err.message);
});

bot.setMyCommands([
  { command: 'menu', description: 'Главное меню' },
  { command: 'start', description: 'Начало работы' },
  { command: 'analytics', description: 'Аналитика' },
  { command: 'subscription', description: 'Управление подпиской' },
  { command: 'feedback', description: 'Написать команде' },
]).catch((err) => console.error('setMyCommands error:', err.message));

bot.setChatMenuButton({ menu_button: { type: 'commands' } })
  .catch((err) => console.error('setChatMenuButton error:', err.message));

bot.onText(/\/start/, (msg) => handleStart(bot, msg));
bot.onText(/\/menu/, async (msg) => {
  if (await requireTerms(bot, msg.from.id, msg.chat.id)) return;
  showMainMenu(bot, msg.chat.id);
});
bot.onText(/\/goal/, async (msg) => {
  if (await requireTerms(bot, msg.from.id, msg.chat.id)) return;
  showGoal(bot, msg.chat.id, msg.from.id);
});
bot.onText(/\/budget/, async (msg) => {
  if (await requireTerms(bot, msg.from.id, msg.chat.id)) return;
  showBudget(bot, msg.chat.id, msg.from.id);
});
bot.onText(/\/history/, async (msg) => {
  if (await requireTerms(bot, msg.from.id, msg.chat.id)) return;
  showHistory(bot, msg.chat.id);
});
bot.onText(/\/analytics/, async (msg) => {
  if (await requireTerms(bot, msg.from.id, msg.chat.id)) return;
  showAnalyticsMenu(bot, msg.chat.id);
});
bot.onText(/\/feedback/, async (msg) => {
  if (await requireTerms(bot, msg.from.id, msg.chat.id)) return;
  showFeedback(bot, msg.chat.id, msg.from.id);
});
bot.onText(/\/subscription/, async (msg) => {
  if (await requireTerms(bot, msg.from.id, msg.chat.id)) return;
  showSubscription(bot, msg.chat.id, msg.from.id);
});

bot.on('voice', (msg) => {
  handleVoiceMessage(bot, msg);
});

bot.on('message', (msg) => {
  if (msg.text && !msg.text.startsWith('/')) {
    handleMessage(bot, msg);
  }
});

bot.on('callback_query', async (query) => {
  const action = query.data;

  // Кнопки онбординга — единственное, что разрешено без согласия
  if (action.startsWith('onboarding:')) {
    await handleOnboardingCallback(bot, query);
    return;
  }

  // Для всех остальных кнопок — жёсткая проверка согласия
  if (await requireTerms(bot, query.from.id, query.message.chat.id)) {
    await bot.answerCallbackQuery(query.id);
    return;
  }

  // Кнопки финансовой цели
  if (action.startsWith('goal:')) {
    await handleGoalCallback(bot, query);
    return;
  }

  // Кнопки бюджета
  if (action.startsWith('budget:')) {
    await handleBudgetCallback(bot, query);
    return;
  }

  // Кнопки истории транзакций
  if (action.startsWith('history:')) {
    await handleHistoryCallback(bot, query);
    return;
  }

  // Кнопки аналитики
  if (action.startsWith('analytics') || action === 'show_monthly_analytics') {
    await handleAnalyticsCallback(bot, query);
    return;
  }

  // Кнопки управления подпиской
  if (
    action === 'buy_subscription' ||
    action.startsWith('buy_') ||
    action.startsWith('check_payment_') ||
    action === 'cancel_payment'
  ) {
    await handleSubscriptionCallback(bot, query);
    return;
  }

  // Быстрые действия из уведомлений
  if (action === 'start_transaction') {
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(
      query.message.chat.id,
      'Напиши мне о своей трате или доходе в свободной форме\n' +
      'или запиши голосовое — я распознаю его 🎤\n' +
      'Например: «продукты 1800», «такси 450», «зарплата 120000»'
    );
    return;
  }

  if (action === 'start_budget') {
    await bot.answerCallbackQuery(query.id);
    await showBudget(bot, query.message.chat.id, query.from.id);
    return;
  }

  // Кнопки редактирования/удаления транзакций
  if (action.startsWith('tx:')) {
    await handleTransactionCallback(bot, query);
    return;
  }

  // Кнопки главного меню
  if (action.startsWith('menu:')) {
    if (action === 'menu:main') {
      await bot.answerCallbackQuery(query.id);
      await showMainMenu(bot, query.message.chat.id);
      return;
    }
    await handleMenuCallback(bot, query);
    return;
  }

  // Кнопки выбора категории (WB и подобные)
  const telegramId = query.from.id;
  const chatId = query.message.chat.id;
  const state = userStates.get(telegramId);

  if (state?.awaitingCategory) {
    await bot.answerCallbackQuery(query.id);
    await handleCategorySelection(bot, chatId, telegramId, action);
    return;
  }

  await bot.answerCallbackQuery(query.id);
});

// Ручная активация подписки (только для ADMIN)
bot.onText(/\/activate (.+)/, async (msg, match) => {
  if (msg.chat.id.toString() !== process.env.ADMIN_TELEGRAM_ID) return;

  const parts = match[1].trim().split(/\s+/);
  const targetExternalId = parts[0];
  const months = parseInt(parts[1]) || 1;

  const result = await activateSubscription(bot, targetExternalId, months);

  if (result.ok) {
    await bot.sendMessage(
      msg.chat.id,
      `✅ Подписка активирована для пользователя ${targetExternalId} на ${months} мес.`
    );
  } else {
    await bot.sendMessage(msg.chat.id, `❌ Ошибка: ${result.reason}`);
  }
});

startScheduler(bot);
startWebhookServer(bot);

bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code, error.message);
});

process.on('unhandledRejection', (reason) => {
  // Игнорируем ошибку устаревших callback_query при перезапуске
  if (reason?.message?.includes('query is too old') ||
      reason?.message?.includes('query ID is invalid')) {
    return;
  }
  console.error('[unhandledRejection]', reason);
  console.error('[stack]', reason?.stack);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});
