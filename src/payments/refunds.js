// Возвраты: расчёт суммы по оферте (п. 6.3) и прекращение подписки после возврата денег.
// Деньги возвращает Анастасия вручную в кабинете ЮKassa (можно частично). Затем подписку у нас отменяет
// терминальный инструмент tools/refund.mjs. Модуль получает базу и функцию запроса возвратов параметрами,
// поэтому его проверяют тесты без боевых настроек.
const DAY_MS = 86_400_000;
const rubles = (n) => Math.round(n * 100) / 100;

/**
 * Сколько вернуть за неиспользованный срок: уплаченная сумма ÷ дней оплаченного срока × неиспользованных дней
 * (оферта, п. 6.3). Бонусные месяцы входят в срок, считается от фактически уплаченной суммы.
 * Дни считаем целыми календарными сутками: срок оплаты округляем до ближайших, неиспользованные берём только целые.
 * @param {{ starts_at: string, ends_at: string, amount_rub: number|null }} sub
 */
export function calcRefundable(sub, now = new Date()) {
  const paid = Number(sub.amount_rub) || 0;
  const starts = Date.parse(sub.starts_at);
  const ends = Date.parse(sub.ends_at);
  const totalDays = Math.max(1, Math.round((ends - starts) / DAY_MS));
  const from = Math.max(now.getTime(), starts);
  const unusedDays = Math.min(totalDays, Math.max(0, Math.floor((ends - from) / DAY_MS)));
  const amount = rubles((paid / totalDays) * unusedDays);
  return { paid, totalDays, unusedDays, amount };
}

const INACTIVE = new Set(['deleted', 'merged']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ищет аккаунты по email, полному id или Telegram id. Возвращает список (объединённые и удалённые пропускаются). */
export async function findAccounts(db, query) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  let res;
  if (UUID_RE.test(q)) res = await db.from('users').select('id, email, channel, external_id, status, tg_username').eq('id', q);
  else if (q.includes('@')) res = await db.from('users').select('id, email, channel, external_id, status, tg_username').eq('email', q.toLowerCase());
  else res = await db.from('users').select('id, email, channel, external_id, status, tg_username').eq('external_id', q);
  return (res.data ?? []).filter((u) => !INACTIVE.has(u.status ?? 'active'));
}

/** Оплаченные записи подписки аккаунта (с платежом), от новых к старым. */
export async function paidSubscriptions(db, userId) {
  const { data } = await db
    .from('subscriptions')
    .select('id, status, period_months, starts_at, ends_at, payment_id, amount_rub')
    .eq('user_id', userId)
    .not('payment_id', 'is', null)
    .order('ends_at', { ascending: false });
  return data ?? [];
}

/**
 * Прекращает оплаченный период после возврата денег: доступ заканчивается сейчас, запись получает статус refunded
 * (письма «подписка заканчивается» ей не уходят). Перед этим сверяется с ЮKassa: деньги действительно возвращены.
 * @param {object} db
 * @param {object} o { userId, paymentId, now, fetchRefunds, freePromo, force, noCheck }
 * @returns {Promise<{ ok: true, refunded: number, freedPromo: boolean } | { ok: false, reason: string, detail?: any }>}
 *  reason: not_found | already | no_refund | check_failed | later_periods | db
 */
export async function cancelAfterRefund(db, { userId, paymentId, now = new Date(), fetchRefunds, freePromo = false, force = false, noCheck = false }) {
  const { data: row } = await db.from('subscriptions').select('id, user_id, status, starts_at, ends_at, payment_id, amount_rub').eq('payment_id', paymentId).maybeSingle();
  if (!row || row.user_id !== userId) return { ok: false, reason: 'not_found' };
  if (row.status === 'refunded') return { ok: false, reason: 'already' };

  let refunded = 0;
  if (!noCheck) {
    const r = await fetchRefunds(paymentId);
    if (!r.ok) return { ok: false, reason: 'check_failed', detail: r.reason };
    refunded = r.refunds.filter((x) => x.status === 'succeeded').reduce((s, x) => s + x.amount, 0);
    if (refunded <= 0) return { ok: false, reason: 'no_refund' };
  }

  // Другие оплаченные периоды, которые начинаются после этого: после отмены у человека возник бы перерыв в доступе
  if (!force) {
    const { data: later } = await db
      .from('subscriptions')
      .select('id')
      .eq('user_id', userId)
      .in('status', ['active', 'trial'])
      .gte('starts_at', row.ends_at)
      .neq('id', row.id);
    if (later?.length) return { ok: false, reason: 'later_periods', detail: later.length };
  }

  const nowIso = now.toISOString();
  const endsAt = Date.parse(row.ends_at) > now.getTime() ? nowIso : row.ends_at;
  const startsAt = Date.parse(row.starts_at) > now.getTime() ? nowIso : row.starts_at;
  const upd = await db.from('subscriptions').update({ status: 'refunded', ends_at: endsAt, starts_at: startsAt }).eq('id', row.id);
  if (upd.error) return { ok: false, reason: 'db', detail: upd.error.message };

  let freedPromo = false;
  if (freePromo) {
    const del = await db.from('promo_redemptions').delete().eq('payment_id', paymentId);
    freedPromo = !del.error;
  }
  return { ok: true, refunded, freedPromo };
}
