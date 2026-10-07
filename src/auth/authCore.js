// Базовые функции собственной авторизации: нормализация e-mail, проверка пароля,
// хеширование (bcrypt), одноразовые токены сброса пароля.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

export const BCRYPT_COST = 12;
export const RESET_TTL_MS = 60 * 60 * 1000; // ссылка для сброса пароля живёт 1 час

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/; // то же правило, что на страницах входа и регистрации

export function normalizeEmail(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

export function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

// Возвращает текст ошибки по-русски или null, если пароль подходит.
// Ограничение 72 байта — у самого bcrypt: всё, что длиннее, он молча обрезает.
export function validatePassword(pw) {
  if (typeof pw !== 'string' || !pw) return 'Обязательное поле';
  if (pw.length < 6) return 'Минимум 6 символов';
  if (Buffer.byteLength(pw, 'utf8') > 72) return 'Слишком длинный пароль (максимум 72 байта)';
  return null;
}

export function hashPassword(pw) {
  return bcrypt.hash(pw, BCRYPT_COST);
}

// Работает и с хешами, перенесёнными из Supabase ($2a$10$…)
export async function verifyPassword(pw, hash) {
  try {
    return await bcrypt.compare(pw, hash);
  } catch {
    return false;
  }
}

// Хеш для «холостой» проверки, когда пользователь не найден: время ответа не выдаёт, есть ли такой e-mail
let _dummyHash = null;
export async function dummyHash() {
  if (!_dummyHash) _dummyHash = await bcrypt.hash('finnik-dummy-password', BCRYPT_COST);
  return _dummyHash;
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// В базе хранится только sha256 токена; сам токен уходит в письмо
export function newResetToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, tokenHash: hashToken(token) };
}

// Аккаунт с входом по паролю (не удалён и не объединён с другим)
export function isWebAccount(u) {
  return !!u?.password_hash && !['deleted', 'merged'].includes(u.status ?? 'active');
}
