import { handleOnboardingCallback, requireTerms } from './onboarding.js';
import { handleGoalCallback } from './goal.js';
import { showBudget, handleBudgetCallback } from './budget.js';
import { handleHistoryCallback } from './history.js';
import { handleAnalyticsCallback } from './analytics.js';
import { handleSubscriptionCallback } from './subscription.js';
import { handleCategoriesCallback } from './categories.js';
import { handleCategorySelection, handleManualCallback } from './message.js';
import { showMainMenu, handleMenuCallback } from './menu.js';
import { handleTransactionCallback } from './transaction.js';
import { handleFileCallback } from './fileUpload.js';
import { userStates } from '../state.js';

// Все обновления старше этого момента — остатки очереди после перезапуска
const BOT_START_TIME = Math.floor(Date.now() / 1000);

export async function dispatchCallbackQuery(bot, query) {
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
}
