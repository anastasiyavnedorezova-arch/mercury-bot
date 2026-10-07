import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import {
  normalizeEmail, isValidEmail, validatePassword,
  hashPassword, verifyPassword, dummyHash,
  hashToken, newResetToken, isWebAccount,
  RESET_TTL_MS,
} from './authCore.js';

const MSG_BAD_CREDENTIALS = 'Неверный e-mail или пароль';
const MSG_RESET_SENT      = 'Если такой e-mail зарегистрирован, письмо отправлено';

/**
 * createAuthRouter({ db, mailer, limits, getBaseUrl, getJwtSecret })
 *
 * db          — supabase-compatible QueryBuilder (pgClient or supabase-js)
 * mailer      — { sendWelcomeEmail, sendPasswordResetEmail }
 * limits      — { ipRegister, emailRegister, ipLogin, emailLogin, ipForgot, emailForgot }
 *               each is a hit(key)=>boolean rate-limiter
 * getBaseUrl  — () => string  (e.g. 'https://finnik.ru')
 * getJwtSecret— () => string
 */
export function createAuthRouter({ db, mailer, limits, getBaseUrl, getJwtSecret }) {
  const router = Router();

  // ── POST /api/auth/register ────────────────────────────────────────────────
  router.post('/register', async (req, res) => {
    const ip = req.ip;
    const { email: rawEmail, password, name } = req.body ?? {};

    if (!rawEmail || !password) {
      return res.status(400).json({ error: 'email и password обязательны' });
    }

    const email = normalizeEmail(rawEmail);

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Некорректный e-mail' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({ error: 'Пароль должен быть не менее 8 символов' });
    }

    if (!limits.ipRegister(ip) || !limits.emailRegister(email)) {
      return res.status(429).json({ error: 'Слишком много попыток, попробуйте позже' });
    }

    // Check if e-mail already taken
    const { data: existing } = await db
      .from('users')
      .select('id')
      .eq('email', email)
      .not('password_hash', 'is', null)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'E-mail уже зарегистрирован' });
    }

    const password_hash = await hashPassword(password);

    const { data: user, error } = await db
      .from('users')
      .insert({
        email,
        web_username: name?.trim() || null,
        external_id: crypto.randomUUID(),
        password_hash,
        password_changed_at: new Date().toISOString(),
        channel: 'web',
      })
      .select('id, email, web_username')
      .single();

    if (error) {
      console.error('[auth] register error:', error.message);
      return res.status(500).json({ error: 'Ошибка сервера' });
    }

    const token = jwt.sign(
      { sub: String(user.id), email: user.email },
      getJwtSecret(),
      { expiresIn: '30d' },
    );

    try {
      await mailer.sendWelcomeEmail({ to: user.email, name: user.web_username || 'пользователь', userId: String(user.id) });
    } catch (e) {
      console.error('[auth] welcome email failed:', e.message);
    }

    return res.status(201).json({ token, user: { id: user.id, email: user.email, name: user.web_username } });
  });

  // ── POST /api/auth/login ───────────────────────────────────────────────────
  router.post('/login', async (req, res) => {
    const ip = req.ip;
    const { email: rawEmail, password } = req.body ?? {};

    if (!rawEmail || !password) {
      return res.status(400).json({ error: 'email и password обязательны' });
    }

    const email = normalizeEmail(rawEmail);

    if (!limits.ipLogin(ip) || !limits.emailLogin(email)) {
      return res.status(429).json({ error: 'Слишком много попыток, попробуйте позже' });
    }

    const { data: user } = await db
      .from('users')
      .select('id, email, web_username, password_hash')
      .eq('email', email)
      .maybeSingle();

    if (!user || !isWebAccount(user)) {
      await dummyHash();
      return res.status(401).json({ error: MSG_BAD_CREDENTIALS });
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: MSG_BAD_CREDENTIALS });
    }

    const token = jwt.sign(
      { sub: String(user.id), email: user.email },
      getJwtSecret(),
      { expiresIn: '30d' },
    );

    return res.json({ token, user: { id: user.id, email: user.email, name: user.web_username } });
  });

  // ── POST /api/auth/forgot ──────────────────────────────────────────────────
  router.post('/forgot', async (req, res) => {
    const ip = req.ip;
    const { email: rawEmail } = req.body ?? {};

    if (!rawEmail) {
      return res.status(400).json({ error: 'email обязателен' });
    }

    const email = normalizeEmail(rawEmail);

    if (!limits.ipForgot(ip) || !limits.emailForgot(email)) {
      return res.status(429).json({ error: 'Слишком много попыток, попробуйте позже' });
    }

    // Always return same message to prevent user enumeration
    const { data: user } = await db
      .from('users')
      .select('id, email, web_username')
      .eq('email', email)
      .not('password_hash', 'is', null)
      .maybeSingle();

    if (!user) {
      return res.json({ message: MSG_RESET_SENT });
    }

    const { token, tokenHash } = newResetToken();
    const expiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();

    const { error } = await db
      .from('password_resets')
      .insert({
        user_id: user.id,
        token_hash: tokenHash,
        expires_at: expiresAt,
      });

    if (error) {
      console.error('[auth] insert reset token error:', error.message);
      return res.json({ message: MSG_RESET_SENT });
    }

    const resetUrl = `${getBaseUrl()}/cabinet/reset-password.html?token=${token}`;

    try {
      await mailer.sendPasswordResetEmail({ to: user.email, name: user.web_username || 'пользователь', resetUrl });
    } catch (e) {
      console.error('[auth] reset email failed:', e.message);
    }

    return res.json({ message: MSG_RESET_SENT });
  });

  // ── POST /api/auth/reset ───────────────────────────────────────────────────
  router.post('/reset', async (req, res) => {
    const { token, password } = req.body ?? {};

    if (!token || !password) {
      return res.status(400).json({ error: 'token и password обязательны' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({ error: 'Пароль должен быть не менее 8 символов' });
    }

    const tokenHash = hashToken(token);

    const { data: reset } = await db
      .from('password_resets')
      .select('id, user_id, expires_at, used_at')
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (!reset) {
      return res.status(400).json({ error: 'Ссылка недействительна' });
    }
    if (reset.used_at) {
      return res.status(400).json({ error: 'Ссылка уже использована' });
    }
    if (new Date(reset.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Ссылка устарела' });
    }

    const password_hash = await hashPassword(password);

    await db
      .from('users')
      .update({
        password_hash,
        password_changed_at: new Date().toISOString(),
      })
      .eq('id', reset.user_id);

    await db
      .from('password_resets')
      .update({ used_at: new Date().toISOString() })
      .eq('id', reset.id);

    return res.json({ message: 'Пароль изменён' });
  });

  return router;
}
