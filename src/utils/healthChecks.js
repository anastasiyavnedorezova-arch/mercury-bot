// Сами проверки. Каждая возвращает { name, ok, detail } и никогда не бросает исключение.
// В detail нельзя попадать токенам и ключам — только короткая причина.
import pg from 'pg';
import { telegramApiBase } from './endpoints.js';

const TIMEOUT_MS = 10_000;

function reason(err) {
  const code = err?.cause?.code || err?.code;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'нет ответа за 10 секунд';
  if (code) return `ошибка соединения (${code})`;
  return 'ошибка соединения';
}

export async function checkTelegram(env = process.env) {
  const name = 'telegram';
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { name, ok: false, detail: 'не задан TELEGRAM_BOT_TOKEN' };
  try {
    const res = await fetch(`${telegramApiBase()}/bot${token}/getMe`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    let body = null;
    try { body = await res.json(); } catch { /* не JSON */ }
    if (res.ok && body && body.ok === true) return { name, ok: true };
    return { name, ok: false, detail: `Telegram ответил статусом ${res.status}` };
  } catch (err) {
    return { name, ok: false, detail: reason(err) };
  }
}

export async function checkOpenAI(env = process.env) {
  const name = 'openai';
  const key = env.OPENAI_API_KEY;
  if (!key) return { name, ok: false, detail: 'не задан OPENAI_API_KEY' };
  const base = ((env.OPENAI_BASE_URL || '').trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { name, ok: true };
    return { name, ok: false, detail: `OpenAI ответил статусом ${res.status}` };
  } catch (err) {
    return { name, ok: false, detail: reason(err) };
  }
}

export async function checkApp(env = process.env) {
  const name = 'app';
  const port = env.PORT || '3000';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/cabinet/login`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) return { name, ok: true };
    return { name, ok: false, detail: `приложение ответило статусом ${res.status}` };
  } catch (err) {
    return { name, ok: false, detail: reason(err) };
  }
}

export async function checkDb(env = process.env) {
  const name = 'db';
  if (!env.DATABASE_URL) return { name, ok: false, detail: 'не задан DATABASE_URL' };
  const client = new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: TIMEOUT_MS });
  client.on('error', () => {});
  try {
    await client.connect();
    await client.query('SELECT 1');
    return { name, ok: true };
  } catch (err) {
    return { name, ok: false, detail: `база не отвечает${err?.code ? ` (${err.code})` : ''}` };
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}

export const ALL_CHECKS = { app: checkApp, db: checkDb, telegram: checkTelegram, openai: checkOpenAI };

// HEALTHCHECK_SKIP=db,openai — пропустить проверки; HEALTHCHECK_FORCE_FAIL=telegram — имитировать поломку (для проверки писем)
export async function runChecks(env = process.env) {
  const skip = new Set((env.HEALTHCHECK_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean));
  const force = new Set((env.HEALTHCHECK_FORCE_FAIL || '').split(',').map((s) => s.trim()).filter(Boolean));
  const names = Object.keys(ALL_CHECKS).filter((n) => !skip.has(n));
  return Promise.all(
    names.map((n) => (force.has(n)
      ? Promise.resolve({ name: n, ok: false, detail: 'тестовая имитация поломки' })
      : ALL_CHECKS[n](env)))
  );
}
