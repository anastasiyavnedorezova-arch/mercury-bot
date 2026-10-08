// Единые цены и расчёт периода подписки. Цены дублируются в тексте
// лендинга, кабинета и бота — при изменении править везде (см. tests/plans.test.mjs).
export const PRICES = { 1: 399, 6: 1995, 12: 3990 };

// Сколько месяцев доступа даёт сумма платежа (0 — сумма меньше минимальной цены).
export function monthsForAmount(amount) {
  const a = Number(amount);
  if (!Number.isFinite(a)) return 0;
  if (a >= PRICES[12]) return 12;
  if (a >= PRICES[6]) return 6;
  if (a >= PRICES[1]) return 1;
  return 0;
}

// Прибавляет месяцы без «перескока» (31 января + 1 месяц = 28/29 февраля).
export function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d;
}

// Новый период начинается сейчас, а если доступ ещё действует — с его конца.
export function computePeriod(currentEndsAt, months, now = new Date()) {
  const cur = currentEndsAt ? new Date(currentEndsAt) : null;
  const startsAt = cur && cur.getTime() > now.getTime() ? cur : now;
  return { startsAt, endsAt: addMonths(startsAt, months) };
}
