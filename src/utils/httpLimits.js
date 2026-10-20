// Ограничение частоты запросов к сайту (в памяти процесса, скользящее окно; при перезапуске счётчики обнуляются).
// Вход, регистрация и сброс пароля ограничены отдельно в auth/authRouter.js. Здесь остальные места, где один
// человек или один скрипт может нагрузить сервер или наши платные сервисы: оплата, обратная связь, ссылка на Telegram,
// сообщения веб-чата, вход через Telegram, вебхуки.
// Аварийное выключение: RATE_LIMITS=off в env-файле (и перезапуск сервиса).
import { createRateLimiter } from '../auth/rateLimit.js';

export const TOO_MANY_MESSAGE = 'Слишком много попыток. Подожди немного и попробуй снова.';

export const ipKey = (req) => req.ip || 'unknown';
export const userKey = (req) => String(req.userId || req.ip || 'unknown');

export function limitsOff(env = process.env) {
  return String(env.RATE_LIMITS || '').toLowerCase() === 'off';
}

// Один раз в минуту на ключ пишем в лог, что запрос отклонён (иначе при атаке лог забьётся).
function makeLogger(name, logger) {
  const last = new Map();
  return (key, sec) => {
    const t = Date.now();
    if (t - (last.get(key) ?? 0) < 60_000) return;
    last.set(key, t);
    if (last.size > 5000) last.clear();
    (logger ?? console).warn?.(`[limit] ${name}: отклонено, ключ=${key}, подождать ${sec} с`);
  };
}

/**
 * Middleware: не больше `max` запросов за `windowMs` на ключ (по умолчанию IP, для вошедших — userKey).
 * Считаются все запросы, в том числе неудачные. Лишний запрос получает 429 с Retry-After и понятным текстом.
 * onLimited(req, res, sec) позволяет ответить по-своему (например, веб-чат отвечает сообщением бота).
 */
export function rateLimit({ name, windowMs, max, key = ipKey, message = TOO_MANY_MESSAGE, onLimited, now, env, logger }) {
  const limiter = createRateLimiter({ windowMs, max, ...(now ? { now } : {}) });
  const log = makeLogger(name, logger);
  const mw = (req, res, next) => {
    if (limitsOff(env)) return next();
    const k = key(req);
    const sec = limiter.retryAfterSec(k);
    if (sec) {
      log(k, sec);
      if (onLimited) return onLimited(req, res, sec);
      res.setHeader('Retry-After', String(sec));
      return res.status(429).json({ error: 'too_many', message, retry_after: sec });
    }
    limiter.record(k);
    return next();
  };
  mw.limiter = limiter;
  return mw;
}

/**
 * Для вебхуков с секретом в адресе: считаем только неудачные попытки с одного IP.
 * blocked(ip) — true, если IP слишком много раз ошибся; fail(ip) — записать ошибку.
 */
export function createFailureGuard({ name, windowMs = 60 * 60_000, max = 20, now, env, logger } = {}) {
  const limiter = createRateLimiter({ windowMs, max, ...(now ? { now } : {}) });
  const log = makeLogger(name, logger);
  return {
    blocked(ip) {
      if (limitsOff(env)) return false;
      const sec = limiter.retryAfterSec(ip);
      if (sec) log(ip, sec);
      return sec > 0;
    },
    fail(ip) { limiter.record(ip); },
  };
}
