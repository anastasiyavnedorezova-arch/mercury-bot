// Когда на счёте OpenAI закончились деньги (предоплата, автопополнение выключено), все запросы к ИИ получают ответ 429
// с кодом insufficient_quota. Людям в этом случае показываем то же вежливое «мне надо отдохнуть» с ручной записью,
// а администратору сразу уходит тревога (Telegram и письмо) — не чаще раза в 6 часов.
import { denyAi } from './aiLimit.js';
import { sendTelegramAlert } from './alertTelegram.js';
import { sendEmail } from './email.js';

export const QUOTA_NOTIFY_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const QUOTA_CODES = new Set(['insufficient_quota', 'billing_hard_limit_reached']);

// Ошибка «нет денег на счёте», а не обычное ограничение частоты запросов (rate_limit_exceeded)
export function isQuotaError(err) {
  const code = err?.code ?? err?.error?.code ?? err?.error?.error?.code;
  return QUOTA_CODES.has(code);
}

export const QUOTA_ALERT_TEXT = [
  'Проект: Финник',
  '',
  '🔴 На счёте OpenAI закончились деньги (ответ insufficient_quota).',
  'Бот не разбирает записи, людям показывается «Мне надо немного отдохнуть» с кнопкой ручной записи.',
  'Пополни баланс: platform.openai.com → Settings → Billing → Buy credits. Бот заработает сразу после пополнения.',
].join('\n');

let lastNotifyAt = 0;
export function resetQuotaNotifyForTests() { lastNotifyAt = 0; }

// Шлёт тревогу, если не слали недавно. Ничего не бросает.
export async function notifyQuotaExhausted({ now = Date.now(), tg = sendTelegramAlert, mail = sendEmail, env = process.env, logger = console } = {}) {
  if (lastNotifyAt && now - lastNotifyAt < QUOTA_NOTIFY_COOLDOWN_MS) return false;
  lastNotifyAt = now;
  logger.error('[openai] insufficient_quota: на счёте OpenAI нет денег');
  const to = env.ADMIN_NOTIFY_EMAIL || env.MAIL_FROM_EMAIL;
  await Promise.allSettled([
    tg(QUOTA_ALERT_TEXT, env),
    to ? mail({ to, subject: '🔴 Финник: на счёте OpenAI закончились деньги', text: QUOTA_ALERT_TEXT }) : Promise.resolve(),
  ]);
  return true;
}

// Для обработчиков ошибок: если это «нет денег», отвечаем человеку, зовём администратора и возвращаем true
export async function replyIfQuota(err, bot, chatId, deps) {
  if (!isQuotaError(err)) return false;
  await notifyQuotaExhausted(deps);
  await denyAi(bot, chatId, { reason: 'global' });
  return true;
}
