import TelegramBot from 'node-telegram-bot-api';

// Singleton Telegram bot instance для отправки сообщений (без polling).
// Используется в хендлерах, которые получают bot-параметр как webBot (фейковый адаптер),
// но должны отправлять уведомления администратору через реальный Telegram.
let _instance = null;

export function getRealBot() {
  if (!_instance) {
    _instance = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
  }
  return _instance;
}
