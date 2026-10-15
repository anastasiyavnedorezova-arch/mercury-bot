import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { makeDb } from './helpers/testDb.mjs';
import { buildPaymentBody, createPayment, fetchPayment, yookassaConfigured } from '../src/payments/yookassa.js';
import { processYookassaEvent, monthsFor, findRecentPaidSubscription } from '../src/payments/process.js';
import { createPaymentRouter } from '../src/payments/routes.js';
import { paymentsReady, maySendTo } from '../src/emails/config.js';

process.env.JWT_SECRET = 'test-secret';
process.env.SUPABASE_URL ||= 'http://localhost:1';   // grantSubscription подключает db.js; боевой базы в тестах нет
process.env.SUPABASE_SERVICE_KEY ||= 'x';
const { grantSubscription } = await import('../src/utils/grantSubscription.js');

let ctx;
before(async () => { ctx = await makeDb(); });
after(async () => { await ctx?.close(); });
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function withKeys(fn) {
  return async (...a) => {
    const keep = { id: process.env.YOOKASSA_SHOP_ID, key: process.env.YOOKASSA_SECRET_KEY };
    process.env.YOOKASSA_SHOP_ID = 'shop-1'; process.env.YOOKASSA_SECRET_KEY = 'secret-1';
    try { return await fn(...a); } finally {
      for (const [k, v] of [['YOOKASSA_SHOP_ID', keep.id], ['YOOKASSA_SECRET_KEY', keep.key]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
}
const jsonRes = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json });

test('запрос на платёж: сумма, чек (услуга, полная предоплата, без НДС), метки пользователя; системы налогообложения в чеке нет', () => {
  for (const [m, price] of [[1, '399.00'], [6, '1995.00'], [12, '3990.00']]) {
    const b = buildPaymentBody({ months: m, userId: 'u-1', email: 'a@b.ru', returnUrl: 'https://x.ru/back' });
    assert.deepEqual(b.amount, { value: price, currency: 'RUB' });
    assert.equal(b.capture, true);
    assert.deepEqual(b.confirmation, { type: 'redirect', return_url: 'https://x.ru/back' });
    assert.deepEqual(b.metadata, { user_id: 'u-1', months: String(m) });
    assert.deepEqual(b.receipt.customer, { email: 'a@b.ru' });
    const it = b.receipt.items[0];
    assert.equal(it.quantity, '1.00');
    assert.deepEqual(it.amount, { value: price, currency: 'RUB' });
    assert.equal(it.vat_code, 1);
    assert.equal(it.payment_subject, 'service');
    assert.equal(it.payment_mode, 'full_prepayment');
    assert.ok(it.description.length <= 128);
    assert.equal(b.receipt.tax_system_code, undefined);
  }
});

test('createPayment: ключи в заголовке, ссылка из ответа; без ключей / тарифа / email — отказ без запроса', withKeys(async () => {
  assert.equal(yookassaConfigured(), true);
  let seen;
  const fetchOk = async (url, init) => { seen = { url, init }; return jsonRes(200, { id: 'pay-12345678', confirmation: { confirmation_url: 'https://yoomoney.ru/pay/1' } }); };
  const r = await createPayment({ months: 6, userId: 'u', email: 'a@b.ru', returnUrl: 'https://x.ru' }, { fetch: fetchOk });
  assert.deepEqual(r, { ok: true, id: 'pay-12345678', url: 'https://yoomoney.ru/pay/1' });
  assert.equal(seen.url, 'https://api.yookassa.ru/v3/payments');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Basic ' + Buffer.from('shop-1:secret-1').toString('base64'));
  assert.match(seen.init.headers['Idempotence-Key'], /^[0-9a-f-]{36}$/);
  assert.equal(JSON.parse(seen.init.body).amount.value, '1995.00');

  let calls = 0;
  const never = async () => { calls += 1; return jsonRes(200, {}); };
  assert.equal((await createPayment({ months: 3, userId: 'u', email: 'a@b.ru', returnUrl: 'x' }, { fetch: never })).reason, 'bad_months');
  assert.equal((await createPayment({ months: 1, userId: 'u', email: '', returnUrl: 'x' }, { fetch: never })).reason, 'no_email');
  assert.equal(calls, 0);
  assert.equal((await createPayment({ months: 1, userId: 'u', email: 'a@b.ru', returnUrl: 'x' }, { fetch: async () => jsonRes(400, { code: 'invalid_request' }) })).reason, 'yookassa_error');
  assert.equal((await createPayment({ months: 1, userId: 'u', email: 'a@b.ru', returnUrl: 'x' }, { fetch: async () => { throw new Error('net'); } })).reason, 'yookassa_error');
}));

test('createPayment без ключей: not_configured', async () => {
  delete process.env.YOOKASSA_SHOP_ID; delete process.env.YOOKASSA_SECRET_KEY;
  assert.equal(yookassaConfigured(), false);
  assert.equal((await createPayment({ months: 1, userId: 'u', email: 'a@b.ru', returnUrl: 'x' })).reason, 'not_configured');
});

test('fetchPayment: проверяет формат номера, различает «не найден» и сбой', withKeys(async () => {
  assert.equal((await fetchPayment('../etc', { fetch: async () => jsonRes(200, {}) })).reason, 'bad_id');
  assert.equal((await fetchPayment('pay-12345678', { fetch: async () => jsonRes(404, {}) })).reason, 'not_found');
  assert.equal((await fetchPayment('pay-12345678', { fetch: async () => jsonRes(500, {}) })).reason, 'yookassa_error');
  const ok = await fetchPayment('pay-12345678', { fetch: async () => jsonRes(200, { id: 'pay-12345678', status: 'succeeded' }) });
  assert.equal(ok.ok, true);
}));

test('monthsFor: срок из метки, если сумма сходится с ценой; иначе по сумме', () => {
  const p = (value, months) => ({ amount: { value }, metadata: months ? { months: String(months) } : {} });
  assert.equal(monthsFor(p('399.00', 1)), 1);
  assert.equal(monthsFor(p('1995.00', 6)), 6);
  assert.equal(monthsFor(p('3990.00', 12)), 12);
  assert.equal(monthsFor(p('399.00', 12)), 1, 'метка 12 мес, а заплачено 399 — даём 1 месяц');
  assert.equal(monthsFor(p('1995.00')), 6, 'старый платёж без метки');
  assert.equal(monthsFor(p('100.00', 1)), 0);
});

let n = 0;
async function newUser(over = {}) {
  n += 1;
  const id = crypto.randomUUID();
  const { error } = await ctx.db.from('users').insert({ id, external_id: `p${n}`, channel: over.channel ?? 'telegram', email: over.email === undefined ? `pay${n}@example.com` : over.email });
  assert.ifError(error);
  return id;
}
const subsOf = async (id) => (await ctx.db.from('subscriptions').select('*').eq('user_id', id)).data;
const evt = (id) => ({ event: 'payment.succeeded', object: { id } });
const paymentOf = (over = {}) => ({ id: 'pay-aaaaaaaa', status: 'succeeded', paid: true, amount: { value: '1995.00' }, metadata: {}, ...over });
function deps(payment, extra = {}) {
  const log = { granted: [], unmatched: [] };
  return {
    log,
    fetchPayment: async () => (payment === null ? { ok: false, reason: extra.reason ?? 'yookassa_error' } : { ok: true, payment }),
    grant: (uid, months, o) => grantSubscription(uid, months, { ...o, db: ctx.db }),
    onGranted: async (x) => { log.granted.push(x); },
    onUnmatched: async (x) => { log.unmatched.push(x); },
  };
}

test('платёж прошёл: подписка включена тому, чей user_id в метке платежа (email в ЮKassa может быть любой)', async () => {
  const uid = await newUser();
  const d = deps(paymentOf({ id: 'pay-00000001', metadata: { user_id: uid, months: '6' }, receipt: { customer: { email: 'someone-else@x.ru' } } }));
  const r = await processYookassaEvent(ctx.db, evt('pay-00000001'), d);
  assert.deepEqual([r.status, r.result], [200, 'granted']);
  const rows = await subsOf(uid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'active'); assert.equal(rows[0].period_months, 6);
  assert.equal(rows[0].payment_id, 'pay-00000001'); assert.equal(rows[0].amount_rub, 1995);
  assert.equal(d.log.granted.length, 1);
});

test('то же уведомление повторно (в том числе одновременно) не даёт второй подписки', async () => {
  const uid = await newUser();
  const pay = paymentOf({ id: 'pay-00000002', metadata: { user_id: uid, months: '1' }, amount: { value: '399.00' } });
  const results = await Promise.all([1, 2, 3].map(() => processYookassaEvent(ctx.db, evt('pay-00000002'), deps(pay))));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal((await subsOf(uid)).length, 1);
  const again = await processYookassaEvent(ctx.db, evt('pay-00000002'), deps(pay));
  assert.equal(again.result, 'duplicate');
});

test('оплата во время пробного периода: оплаченный срок идёт после триала', async () => {
  const uid = await newUser();
  const trialEnd = new Date(Date.now() + 10 * 86400000);
  await ctx.db.from('subscriptions').insert({ user_id: uid, status: 'trial', starts_at: new Date().toISOString(), ends_at: trialEnd.toISOString() });
  await processYookassaEvent(ctx.db, evt('pay-00000003'), deps(paymentOf({ id: 'pay-00000003', metadata: { user_id: uid, months: '1' }, amount: { value: '399.00' } })));
  const paid = (await subsOf(uid)).find((r) => r.status === 'active');
  assert.ok(new Date(paid.starts_at) >= trialEnd);
});

test('не обрабатываем: другие события, неоплаченный платёж, подделку (ЮKassa не знает такого платежа)', async () => {
  const uid = await newUser();
  const d = deps(paymentOf({ metadata: { user_id: uid, months: '6' } }));
  assert.equal((await processYookassaEvent(ctx.db, { event: 'payment.canceled', object: { id: 'pay-x' } }, d)).result, 'ignored');
  assert.equal((await processYookassaEvent(ctx.db, evt('pay-00000004'), deps(paymentOf({ id: 'pay-00000004', status: 'pending', paid: false, metadata: { user_id: uid, months: '6' } })))).result, 'not_paid');
  const fake = await processYookassaEvent(ctx.db, evt('pay-fake0001'), deps(null, { reason: 'not_found' }));
  assert.deepEqual([fake.status, fake.result], [200, 'not_found']);
  assert.equal((await subsOf(uid)).length, 0);
});

test('сбой проверки в ЮKassa: отвечаем 503, чтобы ЮKassa прислала уведомление позже; подписка не включается', async () => {
  const uid = await newUser();
  const r = await processYookassaEvent(ctx.db, evt('pay-00000005'), deps(null, { reason: 'yookassa_error' }));
  assert.deepEqual([r.status, r.result], [503, 'verify_failed']);
  assert.equal((await subsOf(uid)).length, 0);
});

test('сумма не совпала с тарифом: метка 12 мес. при оплате 399 ₽ даёт 1 месяц; сумма меньше цены — не включаем', async () => {
  const uid = await newUser();
  await processYookassaEvent(ctx.db, evt('pay-00000006'), deps(paymentOf({ id: 'pay-00000006', metadata: { user_id: uid, months: '12' }, amount: { value: '399.00' } })));
  assert.equal((await subsOf(uid))[0].period_months, 1);
  const uid2 = await newUser();
  const r = await processYookassaEvent(ctx.db, evt('pay-00000007'), deps(paymentOf({ id: 'pay-00000007', metadata: { user_id: uid2, months: '12' }, amount: { value: '100.00' } })));
  assert.equal(r.result, 'bad_amount');
  assert.equal((await subsOf(uid2)).length, 0);
});

test('старые платежи по статичным ссылкам (без метки): пользователь ищется по email из чека; не нашёлся — сообщаем владельцу', async () => {
  const uid = await newUser({ email: 'legacy@example.com' });
  const ok = await processYookassaEvent(ctx.db, evt('pay-00000008'), deps(paymentOf({ id: 'pay-00000008', receipt: { customer: { email: 'Legacy@Example.com' } } })));
  assert.equal(ok.result, 'granted');
  assert.equal((await subsOf(uid))[0].period_months, 6);
  const d = deps(paymentOf({ id: 'pay-00000009', receipt: { customer: { email: 'nobody@example.com' } } }));
  const r = await processYookassaEvent(ctx.db, evt('pay-00000009'), d);
  assert.equal(r.result, 'unmatched');
  assert.equal(d.log.unmatched.length, 1);
});

// ── /api/pay ────────────────────────────────────────────────────────────────

async function startApi(create) {
  const app = express();
  app.use(express.json());
  app.use(createPaymentRouter({ db: ctx.db, create }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/pay`;
  return { url, close: () => new Promise((r) => server.close(r)) };
}
const post = (url, token, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

test('/api/pay: нужен вход; неверный тариф; нет email; успех возвращает ссылку и передаёт нужные данные', async () => {
  const uid = await newUser({ email: 'cab@example.com' });
  const noMail = await newUser({ email: null });
  const calls = [];
  const create = async (o) => { calls.push(o); return { ok: true, id: 'pay-zzzzzzzz', url: 'https://yoomoney.ru/pay/9' }; };
  const srv = await startApi(create);
  try {
    const tok = (id) => jwt.sign({ userId: id }, process.env.JWT_SECRET);
    assert.equal((await post(srv.url, null, { months: 1 })).status, 401);
    assert.equal((await post(srv.url, tok(uid), { months: 5 })).status, 400);
    const nm = await post(srv.url, tok(noMail), { months: 1 });
    assert.equal(nm.status, 400);
    const ok = await post(srv.url, tok(uid), { months: 12 });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { url: 'https://yoomoney.ru/pay/9' });
    assert.equal(calls.length, 1, 'без email платёж не создаётся');
    assert.equal(calls[0].months, 12); assert.equal(calls[0].userId, uid); assert.equal(calls[0].email, 'cab@example.com');
    assert.match(calls[0].returnUrl, /\/cabinet\/profile\?paid=1$/);
  } finally { await srv.close(); }
  const bad = await startApi(async () => ({ ok: false, reason: 'not_configured' }));
  try {
    const r = await post(bad.url, jwt.sign({ userId: uid }, process.env.JWT_SECRET), { months: 1 });
    assert.equal(r.status, 503);
    assert.match((await r.json()).message, /временно недоступна/);
  } finally { await bad.close(); }
});

// ── Готовность к письмам, кабинет, бот ──────────────────────────────────────

test('письма с кнопками «Оплатить» разрешены только при заданных ключах ЮKassa (или тестовом разрешении)', () => {
  const keep = { ...process.env };
  try {
    delete process.env.YOOKASSA_SHOP_ID; delete process.env.YOOKASSA_SECRET_KEY; delete process.env.LETTERS_ALLOW_NO_PAY_LINKS;
    assert.equal(paymentsReady(), false);
    process.env.LETTERS_ALLOW_NO_PAY_LINKS = 'true';
    assert.equal(paymentsReady(), true);
    delete process.env.LETTERS_ALLOW_NO_PAY_LINKS;
    process.env.YOOKASSA_SHOP_ID = '1'; process.env.YOOKASSA_SECRET_KEY = 'k';
    assert.equal(paymentsReady(), true);
  } finally { process.env = keep; }
});

test('maySendTo: только в режиме on и только на разрешённые адреса', () => {
  const keep = { m: process.env.LETTERS_MODE, o: process.env.LETTERS_ONLY_TO };
  try {
    process.env.LETTERS_MODE = 'off'; delete process.env.LETTERS_ONLY_TO;
    assert.equal(maySendTo('a@b.ru'), false);
    process.env.LETTERS_MODE = 'on';
    assert.equal(maySendTo('a@b.ru'), true);
    process.env.LETTERS_ONLY_TO = 'x@y.ru';
    assert.equal(maySendTo('a@b.ru'), false);
    assert.equal(maySendTo('X@y.ru'), true);
  } finally {
    for (const [k, v] of [['LETTERS_MODE', keep.m], ['LETTERS_ONLY_TO', keep.o]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('кабинет: кнопки «К оплате» создают платёж (1, 6, 12 мес. в обоих окнах), заглушек нет', () => {
  const profile = read('public/cabinet/profile.html');
  assert.equal((profile.match(/startPayment\(1, this\)/g) || []).length, 2);
  assert.equal((profile.match(/startPayment\(6, this\)/g) || []).length, 2);
  assert.equal((profile.match(/startPayment\(12, this\)/g) || []).length, 2);
  assert.doesNotMatch(profile, /closeModal\('modal(Subscribe|Renew)'\)">К оплате/);
  assert.match(profile, /fetch\('\/api\/pay'/);
  assert.match(profile, /get\('pay'\)/);
  assert.match(read('public/cabinet/layout.js'), /redirect=/, 'после входа возвращаем туда, откуда пришли (оплата из письма)');
});

test('бот и сервер: статичных платёжных ссылок и поиска только по email больше нет', () => {
  assert.doesNotMatch(read('src/handlers/subscription.js'), /PAYMENT_LINK/);
  assert.doesNotMatch(read('src/webhook.js'), /monthsForAmount|PAYMENT_LINK/);
  assert.match(read('src/webhook.js'), /processYookassaEvent/);
});

test('кнопка «Я оплатил(а)»: находит свежую оплаченную подписку, пробный период и старые оплаты не считает', async () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const uid = await newUser();
  assert.equal(await findRecentPaidSubscription(ctx.db, uid, { now }), null);
  // пробный период без payment_id — не оплата
  await ctx.db.from('subscriptions').insert({ user_id: uid, status: 'trial', starts_at: now.toISOString(), ends_at: '2026-11-14T00:00:00Z', created_at: now.toISOString() });
  assert.equal(await findRecentPaidSubscription(ctx.db, uid, { now }), null);
  // оплата трёхчасовой давности — уже не «свежая»
  await ctx.db.from('subscriptions').insert({ user_id: uid, status: 'active', period_months: 1, starts_at: '2026-11-14T00:00:00Z', ends_at: '2026-12-14T00:00:00Z', payment_id: 'old-1', amount_rub: 399, created_at: '2026-10-15T09:00:00Z' });
  assert.equal(await findRecentPaidSubscription(ctx.db, uid, { now }), null);
  // оплата 5 минут назад — находим
  await ctx.db.from('subscriptions').insert({ user_id: uid, status: 'active', period_months: 6, starts_at: '2026-12-14T00:00:00Z', ends_at: '2027-06-14T00:00:00Z', payment_id: 'new-1', amount_rub: 1995, created_at: '2026-10-15T11:55:00Z' });
  const r = await findRecentPaidSubscription(ctx.db, uid, { now });
  assert.equal(new Date(r.endsAt).toISOString(), '2027-06-14T00:00:00.000Z');
  // чужая оплата не подтягивается
  assert.equal(await findRecentPaidSubscription(ctx.db, await newUser(), { now }), null);
});

test('бот: на «Я оплатил(а)» без найденной оплаты остаётся ответ «Проверяю оплату»', () => {
  const src = read('src/handlers/subscription.js');
  assert.ok(src.includes('findRecentPaidSubscription(supabase, userId)'));
  assert.ok(src.includes('Проверяю оплату'));
});
