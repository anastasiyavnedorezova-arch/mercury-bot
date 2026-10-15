// Обработка уведомления ЮKassa «платёж прошёл»: проверка, поиск пользователя, включение подписки.
// ЮKassa не подписывает уведомления, поэтому ничего не берём из тела запроса на веру: номер платежа
// перепроверяем запросом в ЮKassa и дальше работаем только с тем, что вернула она.
import { PRICES, monthsForAmount } from '../utils/plans.js';
import { isPlanMonths } from './yookassa.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Сколько месяцев оплачено: из метки платежа, если сумма сходится с ценой; иначе по сумме (старые платежи по статичным ссылкам). */
export function monthsFor(payment) {
  const amount = parseFloat(payment?.amount?.value);
  const m = Number(payment?.metadata?.months);
  if (isPlanMonths(m) && Math.abs(amount - PRICES[m]) < 0.005) return m;
  return monthsForAmount(amount) || 0;
}

async function findUser(db, payment) {
  const metaId = payment.metadata?.user_id;
  if (typeof metaId === 'string' && UUID_RE.test(metaId)) {
    const { data } = await db.from('users').select('id, email, external_id, channel').eq('id', metaId).maybeSingle();
    if (data) return data;
  }
  const email = payment.receipt?.customer?.email ?? payment.metadata?.custEmail ?? payment.metadata?.customerNumber ?? null;
  if (email) {
    const { data } = await db.from('users').select('id, email, external_id, channel').eq('email', String(email).trim().toLowerCase()).limit(1);
    if (data?.[0]) return data[0];
  }
  return null;
}

/**
 * @param {object} db
 * @param {object} event тело уведомления ЮKassa
 * @param {object} deps { fetchPayment, grant, onGranted, onUnmatched }
 * @returns {Promise<{ status: number, result: string }>} status — что ответить ЮKassa (не 2xx → она повторит позже)
 */
export async function processYookassaEvent(db, event, deps) {
  if (event?.event !== 'payment.succeeded') return { status: 200, result: 'ignored' };
  const id = event.object?.id;

  const got = await deps.fetchPayment(id);
  if (!got.ok) {
    // Не смогли проверить (сбой сети/ЮKassa) — просим повторить уведомление позже. Подделку (не найден) не повторяем.
    return got.reason === 'not_found' || got.reason === 'bad_id'
      ? { status: 200, result: 'not_found' }
      : { status: 503, result: 'verify_failed' };
  }
  const payment = got.payment;
  if (payment.status !== 'succeeded' || payment.paid !== true) return { status: 200, result: 'not_paid' };

  const amount = parseFloat(payment.amount?.value);
  const months = monthsFor(payment);
  if (!months) return { status: 200, result: 'bad_amount', payment, amount };

  const { data: existing } = await db.from('subscriptions').select('id').eq('payment_id', payment.id).limit(1);
  if (existing?.length) return { status: 200, result: 'duplicate' };

  const user = await findUser(db, payment);
  if (!user) {
    await deps.onUnmatched?.({ payment, amount, months });
    return { status: 200, result: 'unmatched' };
  }

  let endsAt;
  try {
    ({ endsAt } = await deps.grant(user.id, months, { paymentId: payment.id, amountRub: Math.round(amount) }));
  } catch (e) {
    if (e.code === '23505') return { status: 200, result: 'duplicate' }; // параллельное уведомление уже записало платёж
    console.error('[payments] grant failed:', e.message);
    return { status: 500, result: 'grant_failed' };
  }
  await deps.onGranted?.({ user, months, endsAt, payment, amount });
  return { status: 200, result: 'granted' };
}
