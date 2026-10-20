// Сами проверки. Каждая возвращает { name, ok, detail } и никогда не бросает исключение.
// В detail нельзя попадать токенам и ключам — только короткая причина.
import fs from 'node:fs';
import tls from 'node:tls';
import pg from 'pg';
import { telegramApiBase } from './endpoints.js';
import { aiLimitsConfig, GLOBAL_SUBJECT } from './aiLimit.js';

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
    // Приложение перенаправляет на https, если нет заголовка от nginx — сообщаем, что запрос «как будто пришёл по https»
    const res = await fetch(`http://127.0.0.1:${port}/cabinet/login`, {
      headers: { 'X-Forwarded-Proto': 'https' },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
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

// ── Ночная копия базы: в логе cron должна быть успешная строка не старше 26 часов ───────────────
export const BACKUP_MAX_AGE_H = 26;

// Время последней строки «… backup OK …» в логе копий (мс) или null
export function parseLastBackupOk(logText) {
  let last = null;
  for (const m of String(logText).matchAll(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) backup OK/gm)) last = Date.parse(m[1]);
  return Number.isFinite(last) ? last : null;
}

export async function checkBackup(env = process.env, now = Date.now()) {
  const name = 'backup';
  const file = env.BACKUP_LOG || '/var/log/finnik-backup.log';
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { name, ok: false, detail: 'не могу прочитать лог копий' }; }
  const last = parseLastBackupOk(text);
  if (last === null) return { name, ok: false, detail: 'в логе нет ни одной успешной копии' };
  const hours = Math.floor((now - last) / 3600e3);
  if (hours >= BACKUP_MAX_AGE_H) return { name, ok: false, detail: `последняя успешная копия ${hours} ч назад` };
  return { name, ok: true };
}

// ── Место на диске: тревога, когда занято 85% и больше ─────────────────────────────────────────
export const DISK_MAX_PERCENT = 85;
export function diskUsedPercent(stat) {
  return Math.round((1 - stat.bavail / stat.blocks) * 100);
}
export async function checkDisk(env = process.env) {
  const name = 'disk';
  const max = Number.parseInt(env.DISK_MAX_PERCENT, 10) || DISK_MAX_PERCENT;
  try {
    const used = diskUsedPercent(fs.statfsSync(env.HEALTH_DISK_PATH || '/'));
    if (used >= max) return { name, ok: false, detail: `диск занят на ${used}%` };
    return { name, ok: true };
  } catch { return { name, ok: false, detail: 'не удалось узнать место на диске' }; }
}

// ── Сертификат сайта: тревога за 14 дней до окончания ──────────────────────────────────────────
export const CERT_MIN_DAYS = 14;
export function certDaysLeft(validTo, now = Date.now()) {
  const t = Date.parse(validTo);
  return Number.isFinite(t) ? Math.floor((t - now) / 86400e3) : null;
}
// Сайт и ретранслятор: HEALTH_CERT_HOST — список через запятую (по умолчанию оба)
export const CERT_HOSTS_DEFAULT = 'finnikbot.ru,relay.finnikbot.ru';
export async function checkCert(env = process.env, now = Date.now()) {
  const name = 'cert';
  const hosts = (env.HEALTH_CERT_HOST || CERT_HOSTS_DEFAULT).split(',').map((h) => h.trim()).filter(Boolean);
  const results = await Promise.all(hosts.map((h) => checkCertHost(h, env, now)));
  const bad = results.filter((r) => !r.ok);
  return bad.length ? { name, ok: false, detail: bad.map((r) => r.detail).join('; ') } : { name, ok: true };
}

async function checkCertHost(host, env, now) {
  const name = 'cert';
  try {
    const validTo = await new Promise((resolve, reject) => {
      // Проверку подлинности отключаем: нас интересует только срок, и просроченный сертификат тоже надо уметь прочитать
      const socket = tls.connect({ host, port: Number(env.HEALTH_CERT_PORT) || 443, servername: host, timeout: TIMEOUT_MS, rejectUnauthorized: false }, () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        resolve(cert?.valid_to);
      });
      socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
      socket.on('error', reject);
    });
    const days = certDaysLeft(validTo, now);
    if (days === null) return { name, ok: false, detail: `не удалось прочитать срок сертификата ${host}` };
    if (days < CERT_MIN_DAYS) return { name, ok: false, detail: `сертификат ${host} истекает через ${Math.max(days, 0)} дн.` };
    return { name, ok: true };
  } catch (err) {
    return { name, ok: false, detail: err?.message === 'timeout' ? `${host} не ответил по https за 10 секунд` : `не удалось проверить сертификат ${host}` };
  }
}

// ── Расход ИИ: тревога, когда за сутки потрачено 80% общего предела ───────────────────────────
export const AI_WARN_SHARE = 0.8;
export async function checkAiUsage(env = process.env) {
  const name = 'ai_usage';
  if (!env.DATABASE_URL) return { name, ok: false, detail: 'не задан DATABASE_URL' };
  const limit = aiLimitsConfig(env).global;
  const client = new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: TIMEOUT_MS });
  client.on('error', () => {});
  try {
    await client.connect();
    const r = await client.query(
      `SELECT requests FROM public.ai_usage WHERE subject = $1 AND day = (now() AT TIME ZONE 'Europe/Moscow')::date`,
      [GLOBAL_SUBJECT],
    );
    const used = Number(r.rows[0]?.requests ?? 0);
    if (used >= limit * AI_WARN_SHARE) return { name, ok: false, detail: `за сегодня потрачено ${used} из ${limit} (${Math.round((used / limit) * 100)}%)` };
    return { name, ok: true };
  } catch (err) {
    if (err?.code === '42P01') return { name, ok: true };   // таблицы счётчиков ещё нет — проверять нечего
    return { name, ok: false, detail: `не удалось прочитать расход ИИ${err?.code ? ` (${err.code})` : ''}` };
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}

export const ALL_CHECKS = {
  app: checkApp, db: checkDb, telegram: checkTelegram, openai: checkOpenAI,
  backup: checkBackup, disk: checkDisk, cert: checkCert, ai_usage: checkAiUsage,
};

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
