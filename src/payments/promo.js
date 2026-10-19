// Промокоды: скидка в рублях на любой тариф. Проверка кода и учёт использований.
// Использование засчитывается только после успешной оплаты (см. process.js), а не при создании платежа:
// так брошенные платежи не «сжигают» код. Цена: PRICES[месяцы] - скидка (складывается со скидкой за длинный тариф).
import { PRICES } from '../utils/plans.js';

export const CODE_RE = /^[A-Z0-9_-]{3,32}$/;

/** Приводит ввод пользователя к виду кода: без пробелов, заглавными. */
export function normalizeCode(input) {
  return String(input ?? '').replace(/\s+/g, '').toUpperCase();
}

/** Цена тарифа со скидкой; null, если скидка съедает всю цену (минимум платежа — 1 ₽). */
export function priceWithPromo(months, amountOff) {
  const base = PRICES[months];
  if (!base) return null;
  const price = base - Number(amountOff || 0);
  return price >= 1 ? price : null;
}

// Не даём перебирать промокоды: не больше 10 проверок в минуту на пользователя
// (общий счётчик для кабинета и бота; хранится в памяти процесса, при перезапуске сбрасывается)
const checks = new Map();
export function tooManyChecks(userId, now = Date.now()) {
  const recent = (checks.get(userId) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  checks.set(userId, recent);
  return recent.length > 10;
}

export const PROMO_MESSAGES = {
  not_found: 'Такого промокода нет. Проверь, правильно ли он введён.',
  expired: 'Срок действия промокода закончился.',
  used_up: 'Этот промокод уже использовали максимальное число раз.',
  already_used: 'Ты уже использовал этот промокод.',
  not_applicable: 'Промокод не подходит для этого тарифа.',
};

/**
 * Проверяет промокод для пользователя.
 * @returns {Promise<{ ok: true, promo: { code: string, amountOff: number } } | { ok: false, reason: string }>}
 *  reason: not_found | expired | used_up | already_used
 */
export async function checkPromo(db, rawCode, userId, { now = new Date() } = {}) {
  const code = normalizeCode(rawCode);
  if (!CODE_RE.test(code)) return { ok: false, reason: 'not_found' };

  const { data: promo, error } = await db.from('promo_codes').select('*').eq('code', code).maybeSingle();
  if (error) throw new Error(`promo lookup failed: ${error.message}`);
  if (!promo || !promo.active) return { ok: false, reason: 'not_found' };
  if (promo.expires_at && new Date(promo.expires_at) <= now) return { ok: false, reason: 'expired' };

  const { data: used, error: usedError } = await db.from('promo_redemptions').select('user_id').eq('code', code);
  if (usedError) throw new Error(`promo usage lookup failed: ${usedError.message}`);
  const all = used ?? [];
  if (promo.max_uses != null && all.length >= promo.max_uses) return { ok: false, reason: 'used_up' };
  if (userId && all.filter((r) => r.user_id === userId).length >= (promo.per_user_limit ?? 1)) return { ok: false, reason: 'already_used' };

  return { ok: true, promo: { code, amountOff: Number(promo.amount_off_rub) } };
}

/** Записывает использование кода после успешной оплаты. Повторное уведомление по тому же платежу ничего не меняет. */
export async function recordRedemption(db, { code, userId, paymentId, amountOff }) {
  const normalized = normalizeCode(code);
  if (!CODE_RE.test(normalized) || !paymentId) return { ok: false };
  const { error } = await db.from('promo_redemptions').insert({
    code: normalized,
    user_id: userId,
    payment_id: paymentId,
    amount_off_rub: Math.round(Number(amountOff) || 0),
  });
  if (error && error.code !== '23505') {
    console.error('[promo] redemption not saved:', error.message);
    return { ok: false };
  }
  return { ok: true };
}
