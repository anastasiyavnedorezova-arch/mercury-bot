// Клиент ЮKassa: создание платежа (с чеком) и проверка платежа по номеру.
// Ключи берутся из окружения: YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY (на сервере, в чат не отправлять).
import crypto from 'crypto';
import { PRICES } from '../utils/plans.js';

const API = 'https://api.yookassa.ru/v3';
export const PLAN_MONTHS = [1, 6, 12];

export const yookassaConfigured = () => Boolean(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY);
export const isPlanMonths = (m) => PLAN_MONTHS.includes(Number(m));

const money = (rub) => ({ value: Number(rub).toFixed(2), currency: 'RUB' });

export function planTitle(months) {
  return `Подписка на сервис Финник, ${months} мес.`;
}

// Тело запроса «создать платёж». Систему налогообложения в чеке не передаём: берётся из настроек магазина
// (в API ЮKassa нет кода для АУСН). НДС — «без НДС» (vat_code 1), услуга, полная предоплата.
export function buildPaymentBody({ months, userId, email, returnUrl }) {
  const price = PRICES[months];
  return {
    amount: money(price),
    capture: true,
    confirmation: { type: 'redirect', return_url: returnUrl },
    description: planTitle(months),
    metadata: { user_id: String(userId), months: String(months) },
    receipt: {
      customer: { email },
      items: [{
        description: planTitle(months),
        quantity: '1.00',
        amount: money(price),
        vat_code: 1,
        payment_subject: 'service',
        payment_mode: 'full_prepayment',
      }],
    },
  };
}

async function call(method, path, { body, idempotenceKey, fetchImpl = fetch } = {}) {
  const auth = Buffer.from(`${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' };
  if (idempotenceKey) headers['Idempotence-Key'] = idempotenceKey;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetchImpl(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
    let json = null;
    try { json = await res.json(); } catch { /* пустой ответ */ }
    return { status: res.status, ok: res.ok, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns {Promise<{ ok: true, id: string, url: string } | { ok: false, reason: string }>}
 *  reason: not_configured | bad_months | no_email | yookassa_error
 */
export async function createPayment({ months, userId, email, returnUrl }, deps = {}) {
  if (!yookassaConfigured()) return { ok: false, reason: 'not_configured' };
  if (!isPlanMonths(months)) return { ok: false, reason: 'bad_months' };
  if (!email) return { ok: false, reason: 'no_email' };
  try {
    const r = await call('POST', '/payments', {
      body: buildPaymentBody({ months: Number(months), userId, email, returnUrl }),
      idempotenceKey: crypto.randomUUID(),
      fetchImpl: deps.fetch,
    });
    const url = r.json?.confirmation?.confirmation_url;
    if (!r.ok || !url || !r.json?.id) {
      console.error(`[yookassa] create failed: status=${r.status} code=${r.json?.code ?? '-'} desc=${String(r.json?.description ?? '').slice(0, 120)}`);
      return { ok: false, reason: 'yookassa_error' };
    }
    return { ok: true, id: r.json.id, url };
  } catch (e) {
    console.error('[yookassa] create error:', e.message);
    return { ok: false, reason: 'yookassa_error' };
  }
}

/** Достаёт платёж из ЮKassa по номеру (так мы убеждаемся, что уведомление не подделано). */
export async function fetchPayment(id, deps = {}) {
  if (!yookassaConfigured()) return { ok: false, reason: 'not_configured' };
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(id)) return { ok: false, reason: 'bad_id' };
  try {
    const r = await call('GET', `/payments/${encodeURIComponent(id)}`, { fetchImpl: deps.fetch });
    if (!r.ok || !r.json) return { ok: false, reason: r.status === 404 ? 'not_found' : 'yookassa_error' };
    return { ok: true, payment: r.json };
  } catch (e) {
    console.error('[yookassa] fetch error:', e.message);
    return { ok: false, reason: 'yookassa_error' };
  }
}
