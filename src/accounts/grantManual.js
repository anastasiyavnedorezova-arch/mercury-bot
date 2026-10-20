// Ручная выдача подписки из терминала (tools/grant.mjs): для поддержки, компенсаций, подарков.
// Работает с любым аккаунтом: веб, Telegram, объединённый. Запись без платежа (payment_id пустой):
// это не оплата, поэтому возврату по tools/refund.mjs она не подлежит.
import { computePeriod } from '../utils/plans.js';
import { grantSubscription } from '../utils/grantSubscription.js';

export const MAX_GRANT_MONTHS = 24;

export function validMonths(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_GRANT_MONTHS ? n : null;
}

/** До какой даты у человека сейчас есть доступ (пробный или оплаченный период), или null. */
export async function accessUntil(db, userId, now = new Date()) {
  const { data } = await db
    .from('subscriptions')
    .select('ends_at')
    .eq('user_id', userId)
    .in('status', ['trial', 'active'])
    .gt('ends_at', now.toISOString())
    .order('ends_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.ends_at ? new Date(data.ends_at) : null;
}

/** Что получится, если выдать N месяцев. Ничего не записывает. */
export async function planGrant(db, userId, months, now = new Date()) {
  const current = await accessUntil(db, userId, now);
  const { startsAt, endsAt } = computePeriod(current, months, now);
  return { current, startsAt, endsAt };
}

/** Выдаёт N месяцев: новый период начинается сейчас или после действующего доступа. */
export async function applyGrant(db, userId, months) {
  return grantSubscription(userId, months, { db });
}
