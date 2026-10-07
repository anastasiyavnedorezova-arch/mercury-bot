// Собственная авторизация сайта: регистрация, вход, сброс пароля по e-mail.
// Заменяет Supabase Auth. Фабрика получает базу и «почтальона» снаружи — так её можно тестировать без сети.
import express from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  normalizeEmail, isValidEmail, validatePassword, hashPassword, verifyPassword, dummyHash,
  newResetToken, hashToken, isWebAccount, RESET_TTL_MS,
} from './authCore.js';
import { createRateLimiter } from './rateLimit.js';
import { maskEmail } from '../utils/email.js';

const DEFAULT_LIMITS = {
  loginIp:       { windowMs: 15 * 60_000, max: 30 }, // неудачных входов с одного IP
  loginEmail:    { windowMs: 15 * 60_000, max: 8 },  // неудачных входов на один e-mail
  registerIp:    { windowMs: 60 * 60_000, max: 10 },
  forgotIp:      { windowMs: 60 * 60_000, max: 10 },
  forgotEmail:   { windowMs: 60 * 60_000, max: 3 },
  resetIp:       { windowMs: 60 * 60_000, max: 20 },
};

const clean = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export function createAuthRouter({ db, mailer, limits = {}, getBaseUrl, getJwtSecret } = {}) {
  const router = express.Router();
  const L = Object.fromEntries(
    Object.entries(DEFAULT_LIMITS).map(([k, v]) => [k, createRateLimiter({ ...v, ...(limits[k] || {}) })])
  );
  const baseUrl = () => (getBaseUrl?.() || process.env.APP_BASE_URL || 'https://finnikbot.ru').replace(/\/+$/, '');
  const jwtSecret = () => (getJwtSecret?.() ?? process.env.JWT_SECRET);

  router.use('/api/auth', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  function tooMany(res, sec) {
    res.setHeader('Retry-After', String(sec));
    return res.status(429).json({
      error: 'too_many_requests',
      message: 'Слишком много попыток. Попробуйте через несколько минут.',
      retry_after: sec,
    });
  }

  function signToken(user) {
    const secret = jwtSecret();
    if (!secret) throw new Error('JWT_SECRET is not set');
    return jwt.sign({ userId: user.id, telegramId: user.external_id || null }, secret, { expiresIn: '30d' });
  }

  // Все учётные записи с входом по паролю для данного e-mail (обычно одна)
  async function findWebAccounts(email) {
    const { data, error } = await db
      .from('users')
      .select('id, external_id, status, password_hash, created_at')
      .eq('email', email);
    if (error) throw error;
    return (data ?? []).filter(isWebAccount).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }

  // ── Регистрация ───────────────────────────────────────────
  router.post('/api/auth/register', async (req, res) => {
    try {
      const ip = req.ip || 'unknown';
      const wait = L.registerIp.retryAfterSec(ip);
      if (wait) return tooMany(res, wait);
      L.registerIp.record(ip);

      const b = req.body ?? {};
      const email = normalizeEmail(b.email);
      if (!email) return res.status(400).json({ error: 'validation', field: 'email', message: 'Обязательное поле' });
      if (!isValidEmail(email)) return res.status(400).json({ error: 'validation', field: 'email', message: 'Введите корректный e-mail' });
      const pwErr = validatePassword(b.password);
      if (pwErr) return res.status(400).json({ error: 'validation', field: 'password', message: pwErr });
      if (b.terms_accepted !== true) {
        return res.status(400).json({ error: 'validation', field: 'terms', message: 'Нужно принять условия' });
      }

      const takenMsg = 'Этот e-mail уже зарегистрирован. Войдите или восстановите пароль.';
      if ((await findWebAccounts(email)).length) return res.status(409).json({ error: 'email_taken', message: takenMsg });

      const passwordHash = await hashPassword(b.password);
      const id = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      const name = clean(b.name, 100);

      const { error: insertError } = await db.from('users').insert({
        id,
        channel: 'web',
        external_id: id,
        web_username: name,
        email,
        password_hash: passwordHash,
        password_changed_at: nowIso,
        tg_username: clean(b.telegram, 64)?.replace(/^@/, '') ?? null,
        terms_accepted_at: nowIso,
        terms_version: '1.0',
        email_letters_accepted: b.email_letters_accepted === true,
        created_at: nowIso,
        last_active_at: nowIso,
      });
      // 23505 — тот же e-mail занят параллельным запросом (двойной клик)
      if (insertError?.code === '23505') return res.status(409).json({ error: 'email_taken', message: takenMsg });
      if (insertError) throw insertError;

      Promise.resolve(mailer?.sendWelcomeEmail?.({ to: email, name, userId: id }))
        .then((r) => console.log('[email] welcome:', r?.ok ? 'sent' : (r?.skipped ? 'skipped' : 'failed ' + (r?.status ?? r?.error))))
        .catch(() => {});

      res.status(201).json({ token: signToken({ id, external_id: id }) });
    } catch (err) {
      console.error('[auth] register error:', err.message);
      res.status(500).json({ error: 'internal', message: 'Не удалось создать аккаунт. Попробуйте ещё раз.' });
    }
  });

  // ── Вход ──────────────────────────────────────────────────
  router.post('/api/auth/login', async (req, res) => {
    try {
      const ip = req.ip || 'unknown';
      const b = req.body ?? {};
      const email = normalizeEmail(b.email);
      const password = typeof b.password === 'string' ? b.password : '';
      if (!email || !password) {
        return res.status(400).json({ error: 'validation', message: 'Укажите e-mail и пароль' });
      }

      const ipKey = ip;
      const emailKey = email;
      const wait = Math.max(L.loginIp.retryAfterSec(ipKey), L.loginEmail.retryAfterSec(emailKey));
      if (wait) return tooMany(res, wait);

      const [user] = await findWebAccounts(email);
      const ok = await verifyPassword(password, user ? user.password_hash : await dummyHash());
      if (!user || !ok) {
        L.loginIp.record(ipKey);
        L.loginEmail.record(emailKey);
        return res.status(401).json({ error: 'invalid_credentials', message: 'Неверный e-mail или пароль' });
      }

      L.loginEmail.clear(emailKey);
      res.json({ token: signToken(user) });
    } catch (err) {
      console.error('[auth] login error:', err.message);
      res.status(500).json({ error: 'internal', message: 'Не удалось войти. Попробуйте ещё раз.' });
    }
  });

  // ── Запрос письма для сброса пароля ───────────────────────
  // Всегда отвечает «ok», чтобы нельзя было узнать, зарегистрирован ли e-mail.
  router.post('/api/auth/forgot', async (req, res) => {
    try {
      const ip = req.ip || 'unknown';
      const wait = L.forgotIp.retryAfterSec(ip);
      if (wait) return tooMany(res, wait);
      L.forgotIp.record(ip);

      const email = normalizeEmail(req.body?.email);
      if (!isValidEmail(email)) return res.status(400).json({ error: 'validation', field: 'email', message: 'Введите корректный e-mail' });

      // Лимит на один адрес: сверх лимита письмо молча не отправляется
      if (L.forgotEmail.retryAfterSec(email)) return res.json({ ok: true });
      L.forgotEmail.record(email);

      const [user] = await findWebAccounts(email);
      if (user) {
        const nowIso = new Date().toISOString();
        // Прежние неиспользованные ссылки перестают работать
        await db.from('password_resets').update({ used_at: nowIso }).eq('user_id', user.id).is('used_at', null);
        const { token, tokenHash } = newResetToken();
        const { error } = await db.from('password_resets').insert({
          user_id: user.id,
          token_hash: tokenHash,
          expires_at: new Date(Date.now() + RESET_TTL_MS).toISOString(),
        });
        if (error) throw error;
        // Токен в адресной строке после «#»: он не попадает в логи серверов и в Referer
        const link = `${baseUrl()}/cabinet/reset-password#token=${token}`;
        Promise.resolve(mailer?.sendPasswordResetEmail?.({ to: email, link }))
          .then((r) => console.log('[email] password reset to', maskEmail(email) + ':', r?.ok ? 'sent' : (r?.skipped ? 'skipped' : 'failed ' + (r?.status ?? r?.error))))
          .catch(() => {});
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[auth] forgot error:', err.message);
      res.status(500).json({ error: 'internal', message: 'Не удалось отправить письмо. Попробуйте ещё раз.' });
    }
  });

  // ── Установка нового пароля по ссылке из письма ───────────
  router.post('/api/auth/reset', async (req, res) => {
    try {
      const ip = req.ip || 'unknown';
      const wait = L.resetIp.retryAfterSec(ip);
      if (wait) return tooMany(res, wait);
      L.resetIp.record(ip);

      const { token, password } = req.body ?? {};
      const invalid = () => res.status(400).json({ error: 'invalid_token', message: 'Ссылка недействительна или устарела. Запросите новое письмо.' });
      if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return invalid();
      const pwErr = validatePassword(password);
      if (pwErr) return res.status(400).json({ error: 'validation', field: 'password', message: pwErr });

      const { data: row, error } = await db
        .from('password_resets')
        .select('id, user_id, expires_at, used_at')
        .eq('token_hash', hashToken(token))
        .maybeSingle();
      if (error) throw error;
      if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now()) return invalid();

      const nowIso = new Date().toISOString();
      // Забираем токен «атомарно»: при двойном запросе сработает только один
      const { data: claimed, error: claimError } = await db
        .from('password_resets')
        .update({ used_at: nowIso })
        .eq('id', row.id)
        .is('used_at', null)
        .select('id');
      if (claimError) throw claimError;
      if (!claimed?.length) return invalid();

      const { data: user } = await db.from('users').select('id, status, password_hash').eq('id', row.user_id).maybeSingle();
      if (!user || ['deleted', 'merged'].includes(user.status ?? 'active')) return invalid();

      const passwordHash = await hashPassword(password);
      const { error: updError } = await db
        .from('users')
        .update({ password_hash: passwordHash, password_changed_at: nowIso })
        .eq('id', row.user_id);
      if (updError) throw updError;

      // Остальные ссылки этого пользователя больше не нужны
      await db.from('password_resets').update({ used_at: nowIso }).eq('user_id', row.user_id).is('used_at', null);
      res.json({ ok: true });
    } catch (err) {
      console.error('[auth] reset error:', err.message);
      res.status(500).json({ error: 'internal', message: 'Не удалось сохранить пароль. Попробуйте ещё раз.' });
    }
  });

  return router;
}
