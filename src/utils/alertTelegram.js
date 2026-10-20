// Оповещения администратору в Telegram — отдельным ботом (не боту, с которым общаются пользователи).
// Нужны две переменные в env сервера: ALERT_BOT_TOKEN (токен бота оповещений) и ALERT_CHAT_ID (твой чат с ним).
// Идёт через тот же ретранслятор, что и основной бот (TELEGRAM_API_BASE_URL). Если он недоступен, письмо на почту всё равно уйдёт.
// В результат и логи токен не попадает.
import { telegramApiBase } from './endpoints.js';

export function alertConfigured(env = process.env) {
  return Boolean((env.ALERT_BOT_TOKEN || '').trim() && (env.ALERT_CHAT_ID || '').trim());
}

// → { ok: true } | { ok: false, skipped?: true, error }
export async function sendTelegramAlert(text, env = process.env, fetchImpl = fetch) {
  if (!alertConfigured(env)) return { ok: false, skipped: true, error: 'не заданы ALERT_BOT_TOKEN / ALERT_CHAT_ID' };
  const token = env.ALERT_BOT_TOKEN.trim();
  try {
    const res = await fetchImpl(`${telegramApiBase()}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.ALERT_CHAT_ID.trim(), text: String(text).slice(0, 3900), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    let body = null;
    try { body = await res.json(); } catch { /* не JSON */ }
    if (res.ok && body?.ok === true) return { ok: true };
    return { ok: false, error: `Telegram ответил статусом ${res.status}${body?.description ? `: ${String(body.description).replaceAll(token, '***')}` : ''}` };
  } catch (err) {
    const code = err?.cause?.code || err?.code;
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { ok: false, error: 'нет ответа за 10 секунд' };
    return { ok: false, error: code ? `ошибка соединения (${code})` : 'ошибка соединения' };
  }
}
