const DEFAULT_TELEGRAM_API = 'https://api.telegram.org';

// Базовый адрес Telegram Bot API. Пусто = напрямую.
// Для ретранслятора: https://relay.finnikbot.ru/telegram
export function telegramApiBase() {
  const raw = (process.env.TELEGRAM_API_BASE_URL || '').trim();
  if (!raw) return DEFAULT_TELEGRAM_API;
  if (!/^https?:\/\/[^\s]+$/.test(raw)) {
    throw new Error('TELEGRAM_API_BASE_URL must start with http:// or https://');
  }
  return raw.replace(/\/+$/, '');
}

// Ссылка на скачивание файла, который прислал пользователь в Telegram
export function telegramFileUrl(filePath) {
  return `${telegramApiBase()}/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;
}

// Опции для new TelegramBot(...)
export function telegramBotOptions(extra = {}) {
  return { ...extra, baseApiUrl: telegramApiBase() };
}

// Для лога при старте: только «прямо/через ретранслятор» и имя хоста, без путей и токенов
export function endpointsStatus() {
  const host = (u) => { try { return new URL(u).host; } catch { return 'invalid'; } };
  const tg = telegramApiBase();
  const oa = (process.env.OPENAI_BASE_URL || '').trim();
  return {
    telegram: tg === DEFAULT_TELEGRAM_API ? 'direct' : 'relay:' + host(tg),
    openai: oa ? 'relay:' + host(oa) : 'direct',
  };
}
