// Оповещения администратору в Telegram — отдельным ботом (не боту, с которым общаются пользователи).
// Нужны две переменные в env сервера: ALERT_BOT_TOKEN (токен бота оповещений) и ALERT_CHAT_ID (твой чат с ним).
// ALERT_TELEGRAM_API_BASE_URL задаёт независимый маршрут (например, quicksrv).
// ALERT_TELEGRAM_FALLBACK_API_BASE_URL — запасной маршрут для оповещений.
// Без отдельной настройки сохраняется прежний TELEGRAM_API_BASE_URL.
// В результат и логи токен не попадает.

export function alertApiBases(env = process.env) {
  const primary = (env.ALERT_TELEGRAM_API_BASE_URL || env.TELEGRAM_API_BASE_URL || 'https://api.telegram.org').trim();
  const fallback = (env.ALERT_TELEGRAM_FALLBACK_API_BASE_URL || '').trim();
  return [...new Set([primary, fallback].filter(Boolean).map((raw) => {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid alert API base');
    }
    return url.href.replace(/\/+$/, '');
  }))];
}

export function alertConfigured(env = process.env) {
  return Boolean((env.ALERT_BOT_TOKEN || '').trim() && (env.ALERT_CHAT_ID || '').trim());
}

// → { ok: true } | { ok: false, skipped?: true, error }
export async function sendTelegramAlert(text, env = process.env, fetchImpl = fetch) {
  if (!alertConfigured(env)) return { ok: false, skipped: true, error: 'не заданы ALERT_BOT_TOKEN / ALERT_CHAT_ID' };
  const token = env.ALERT_BOT_TOKEN.trim();
  let bases;
  try { bases = alertApiBases(env); }
  catch { return { ok: false, error: 'некорректный адрес API оповещений' }; }
  let lastError;
  for (const base of bases) {
    try {
      const res = await fetchImpl(`${base}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.ALERT_CHAT_ID.trim(), text: String(text).slice(0, 3900), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      let body = null;
      try { body = await res.json(); } catch { /* не JSON */ }
      if (res.ok && body?.ok === true) return { ok: true, route: new URL(base).host };
      lastError = `Telegram ответил статусом ${res.status}`;
    } catch (err) {
      const code = err?.cause?.code || err?.code;
      lastError = err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? 'нет ответа за 10 секунд'
        : ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)
          ? `ошибка соединения (${code})` : 'ошибка соединения';
    }
  }
  return { ok: false, error: lastError };
}
