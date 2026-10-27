// Тексты и кнопки «доступно в подписке» (патч 53). Человеку, у которого пробный период уже был, пробный не предлагаем:
// ему можно только оформить подписку. trialUsed — результат hadTrial(db, userId).

const MENU_BTN = { text: 'Не сейчас', callback_data: 'menu:main' };
const TRIAL_BTN = { text: 'Активировать пробный период', callback_data: 'onboarding:activate_trial' };
const BUY_BTN = { text: 'Оформить подписку', callback_data: 'buy_subscription' };

// Раздел «Бюджет» на тарифе free
export function budgetPaywall(trialUsed) {
  return trialUsed
    ? { text: 'Бюджет доступен в подписке 💛', keyboard: { inline_keyboard: [[BUY_BTN, MENU_BTN]] } }
    : { text: 'Бюджет доступен в подписке. Хочешь активировать 30 дней бесплатно? 💛', keyboard: { inline_keyboard: [[TRIAL_BTN, MENU_BTN]] } };
}

// Платная функция аналитики на тарифе free
export function featurePaywall(trialUsed) {
  return trialUsed
    ? { text: 'Эта функция доступна в подписке 💛', keyboard: { inline_keyboard: [[BUY_BTN, MENU_BTN]] } }
    : { text: 'Эта функция доступна в подписке 💛\nХочешь активировать 30 дней бесплатно?', keyboard: { inline_keyboard: [[TRIAL_BTN, MENU_BTN]] } };
}

// Экран «Твой тариф» на free
export function freeTariffScreen(trialUsed) {
  const base =
    '💳 Твой тариф: Бесплатный\n\n' +
    'Доступно:\n' +
    '✔️ 1 финансовая цель\n' +
    '✔️ учёт доходов и расходов\n' +
    '✔️ редактирование и удаление записей\n' +
    '✔️ ежемесячная аналитика\n\n' +
    'Недоступно без подписки:\n' +
    '❌ бюджет и алерты\n' +
    '❌ до 3 целей с расчётом доходности\n' +
    '❌ аналитика по запросу\n' +
    '❌ свои категории\n\n';
  return trialUsed
    ? { text: `${base}Оформи подписку, и все функции снова будут доступны 💛`, keyboard: { inline_keyboard: [[BUY_BTN]] } }
    : { text: `${base}У тебя есть возможность попробовать все функции бесплатно 30 дней 💛`, keyboard: { inline_keyboard: [[TRIAL_BTN], [BUY_BTN]] } };
}
