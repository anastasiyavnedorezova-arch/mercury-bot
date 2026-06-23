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
import { dispatchCallbackQuery } from './handlers/callbackDispatcher.js';

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

bot.on('callback_query', (query) => dispatchCallbackQuery(bot, query));

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
