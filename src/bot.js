import TelegramBot from 'node-telegram-bot-api';
import 'dotenv/config';
import { handleStart } from './handlers/start.js';
import { handleMessage, handleCategorySelection, handleManualCallback } from './handlers/message.js';
import { showMainMenu, handleMenuCallback } from './handlers/menu.js';
import { handleOnboardingCallback, requireTerms } from './handlers/onboarding.js';
import { handleTransactionCallback } from './handlers/transaction.js';
import { showGoal, handleGoalCallback } from './handlers/goal.js';
import { showBudget, handleBudgetCallback } from './handlers/budget.js';
import { showHistory, handleHistoryCallback } from './handlers/history.js';
import { showAnalyticsMenu, handleAnalyticsCallback } from './handlers/analytics.js';
import { showFeedback } from './handlers/feedback.js';
import { showSubscription, handleSubscriptionCallback, activateSubscription } from './handlers/subscription.js';
import { showCategories, handleCategoriesCallback } from './handlers/categories.js';
import { startScheduler } from './notifications/scheduler.js';
import { handleVoiceMessage } from './handlers/voice.js';
import { handleFileUpload, handleFileCallback } from './handlers/fileUpload.js';
import { startWebhookServer } from './webhook.js';
import { userStates } from './state.js';
import { supabase } from './db.js';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Все обновления старше этого момента — остатки очереди после перезапуска
const BOT_START_TIME = Math.floor(Date.now() / 1000);

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
  { command: 'categories', description: 'Мои категории' },
  { command: 'feedback', description: 'Написать команде' },
]).catch((err) => console.error('setMyCommands error:', err.message));

bot.setChatMenuButton({ menu_button: { type: 'commands' } })
  .catch((err) => console.error('setChatMenuButton error:', err.message));

// ── Команды ───────────────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  if (msg.date < BOT_START_TIME) return;
  handleStart(bot, msg);
});

bot.onText(/\/menu/, async (msg) => {
  if (msg.date < BOT_START_TIME) return;
  if (await requireTerms(bot, msg.from.id, msg.chat.id)) return;
  userStates.delete(msg.from.id);
  showMainMenu(bot, msg.chat.id);
});

bot.onText(/\/goal/, async (msg) => {
  if (msg.date < BOT_START_TIME) return;
  if (await requireTerms(bot, msg.from.id, msg.chat.id)) return;
  userStates.delete(msg.from.id);
  showGoal(bot, msg.chat.id, msg.from.id);
});

bot.onText(/\/budget/, async (msg) => {
  if (msg.date < BOT_START_TIME) return;
  if (await requireTerms(bot, msg.from.id, msg.chat.id)) return;
  userStates.delete(msg.from.id);
  showBudget(bot, msg.chat.id, msg.from.id);
});

bot.onText(/\/history/, async (msg) => {
  if (msg.date < BOT_START_TIME) return;
  if (await requireTerms(bot, msg.from.id, msg.chat.id)) return;
  userStates.delete(msg.from.id);
  showHistory(bot, msg.chat.id);
});

bot.onText(/\/analytics/, async (msg) => {
  if (msg.date < BOT_START_TIME) return;
  if (await requireTerms(bot, msg.from.id, msg.chat.id)) return;
  userStates.delete(msg.from.id);
  showAnalyticsMenu(bot, msg.chat.id);
});

bot.onText(/\/feedback/, async (msg) => {
  if (msg.date < BOT_START_TIME) return;
  if (await requireTerms(bot, msg.from.id, msg.chat.id)) return;
  showFeedback(bot, msg.chat.id, msg.from.id);
});

bot.onText(/\/subscription/, async (msg) => {
  if (msg.date < BOT_START_TIME) return;
  if (await requireTerms(bot, msg.from.id, msg.chat.id)) return;
  showSubscription(bot, msg.chat.id, msg.from.id);
});

bot.onText(/\/categories/, async (msg) => {
  if (msg.date < BOT_START_TIME) return;
  if (await requireTerms(bot, msg.from.id, msg.chat.id)) return;
  showCategories(bot, msg.chat.id, msg.from.id);
});

bot.onText(/\/activate (.+)/, async (msg, match) => {
  if (msg.date < BOT_START_TIME) return;
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

bot.onText(/\/broadcast (.+)/s, async (msg, match) => {
  if (msg.date < BOT_START_TIME) return;
  if (msg.chat.id.toString() !== process.env.ADMIN_TELEGRAM_ID) return;

  const text = match[1];

  const { data: users } = await supabase
    .from('users')
    .select('external_id')
    .eq('channel', 'telegram');

  if (!users?.length) {
    await bot.sendMessage(msg.chat.id, 'Пользователей не найдено');
    return;
  }

  await bot.sendMessage(msg.chat.id, `Начинаю рассылку для ${users.length} пользователей...`);

  let success = 0;
  let failed = 0;

  for (const user of users) {
    try {
      await bot.sendMessage(user.external_id, text, { parse_mode: 'HTML' });
      success++;
      await new Promise(r => setTimeout(r, 50));
    } catch (err) {
      console.error('[broadcast] Failed for:', user.external_id, err.message);
      failed++;
    }
  }

  await bot.sendMessage(
    msg.chat.id,
    `✅ Рассылка завершена\nУспешно: ${success}\nОшибки: ${failed}`
  );
});

// ── Голосовые ─────────────────────────────────────────────────────────────────

bot.on('voice', (msg) => {
  if (msg.date < BOT_START_TIME) return;
  handleVoiceMessage(bot, msg);
});

// ── Фото и документы (банковские выписки) ─────────────────────────────────────

bot.on('photo', (msg) => {
  if (msg.date < BOT_START_TIME) return;
  handleFileUpload(bot, msg, 'photo');
});

bot.on('document', (msg) => {
  if (msg.date < BOT_START_TIME) return;
  const mime = msg.document?.mime_type ?? '';
  if (mime.startsWith('image/') || mime === 'application/pdf') {
    handleFileUpload(bot, msg, 'document');
  }
});

// ── Текстовые сообщения ───────────────────────────────────────────────────────

bot.on('message', (msg) => {
  if (msg.date < BOT_START_TIME) {
    console.log('[filter] Skipping old message from:', msg.date);
    return;
  }
  if (msg.text && !msg.text.startsWith('/')) {
    handleMessage(bot, msg);
  }
});

// ── Callback-кнопки ───────────────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  if (query.message.date < BOT_START_TIME) {
    console.log('[filter] Skipping old callback from:', query.message.date);
    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }

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

  // Кнопки категорий
  if (
    action === 'my_categories' ||
    action === 'show_all_categories' ||
    action === 'add_category' ||
    action.startsWith('add_cat_type:') ||
    action.startsWith('add_cat_group:') ||
    action.startsWith('delete_category:') ||
    action.startsWith('confirm_delete:') ||
    action === 'cancel_delete'
  ) {
    await handleCategoriesCallback(bot, query);
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

  if (action === 'ask_question') {
    await handleMenuCallback(bot, query);
    return;
  }

  // Кнопки ручного ввода транзакции
  if (action.startsWith('manual:')) {
    await handleManualCallback(bot, query);
    return;
  }

  // Кнопки выписки
  if (
    action === 'file_confirm' ||
    action === 'file_cancel' ||
    action === 'file_show_again'
  ) {
    await handleFileCallback(bot, query);
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

// ── Системные обработчики ─────────────────────────────────────────────────────

startScheduler(bot);
startWebhookServer(bot);

bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code, error.message);
});

process.on('unhandledRejection', (reason) => {
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
