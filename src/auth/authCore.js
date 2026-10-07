import bcrypt from 'bcryptjs';
import crypto from 'crypto';

export const BCRYPT_COST = 12;
export const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── Email ─────────────────────────────────────────────────────────────────────

export function normalizeEmail(raw) {
  return raw.trim().toLowerCase();
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ── Password ──────────────────────────────────────────────────────────────────

export function validatePassword(password) {
  if (typeof password !== 'string') return false;
  return password.length >= 8;
}

export async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}

export async function verifyPassword(password, hash) {
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

// Used when the user is not found — prevents timing-based user enumeration.
export async function dummyHash() {
  return bcrypt.compare('', await bcrypt.hash('', 4));
}

// ── Reset token ───────────────────────────────────────────────────────────────

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function newResetToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, tokenHash: hashToken(token) };
}

// ── Account type ──────────────────────────────────────────────────────────────

/** Returns true if the user row has a web password (i.e. can log in via web). */
export function isWebAccount(user) {
  return Boolean(user?.password_hash);
}
