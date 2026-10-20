import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { makeDb } from './helpers/testDb.mjs';
import { buildPaymentBody, createPayment } from '../src/payments/yookassa.js';
import { processYookassaEvent, monthsFor } from '../src/payments/process.js';
import { createPaymentRouter } from '../src/payments/routes.js';
import { normalizeCode, priceWithPromo, checkPromo, recordRedemption, CODE_RE } from '../src/payments/promo.js';
import { createPromo, setPromoActive, listPromos, describePromo, endOfDayMsk } from '../src/payments/promoAdmin.js';

process.env.JWT_SECRET = 'test-secret';
process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:1/test';
const { grantSubscription } = await import('../src/utils/grantSubscription.js');

let ctx;
before(async () => { ctx = await makeDb(); });
after(async () => { await ctx?.close(); });
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

let n = 0;
async function newUser(over = {}) {
  n += 1;
  const id = crypto.randomUUID();
  const { error } = await ctx.db.from('users').insert({ id, external_id: `pr${n}`, channel: 'telegram', email: over.email === undefined ? `promo${n}@example.com` : over.email });
  assert.ifError(error);
  return id;
}
let codeN = 0;
const uniqueCode = () => `TEST${Date.now().toString(36).toUpperCase()}${++codeN}`;
async function newPromo(over = {}) {
  const r = await createPromo(ctx.db, { code: over.code ?? uniqueCode(), off: over.off ?? 200, ...over });
  assert.equal(r.ok, true, r.error);
  return r.promo;
}
async function redeem(code, userId, off = 200) {
  const r = await recordRedemption(ctx.db, { code, userId, paymentId: `pay-${crypto.randomUUID()}`, amountOff: off });
  assert.equal(r.ok, true);
}

test('нормализация кода и цена со скидкой: 399 → 199, 1995 → 1795, 3990 → 3790; скидка не может съесть всю цену', () => {
  assert.equal(normalizeCode('  ttestt 300 '), 'TTESTT300');
  assert.equal(normalizeCode(null), '');
  assert.ok(CODE_RE.test('TTESTT300') && !CODE_RE.test('ab') && !CODE_RE.test('код'));
  assert.equal(priceWithPromo(1, 200), 199);
  assert.equal(priceWithPromo(6, 200), 1795);
  assert.equal(priceWithPromo(12, 200), 3790);
  assert.equal(priceWithPromo(1, 300), 99);
  assert.equal(priceWithPromo(1, 398), 1);
  assert.equal(priceWithPromo(1, 399), null);
  assert.equal(priceWithPromo(3, 100), null);
});

test('создание кода: проверка параметров и срок до конца дня по Москве', async () => {
  const bad = async (o) => (await createPromo(ctx.db, o)).ok;
  assert.equal(await bad({ code: 'ab', off: 100 }), false);
  assert.equal(await bad({ code: 'GOODCODE', off: 0 }), false);
  assert.equal(await bad({ code: 'GOODCODE', off: 399 }), false, 'скидка должна оставлять платёж не меньше 1 ₽');
  assert.equal(await bad({ code: 'GOODCODE', off: 'abc' }), false);
  assert.equal(await bad({ code: 'GOODCODE', off: 100, max: 0 }), false);
  assert.equal(await bad({ code: 'GOODCODE', off: 100, perUser: 0 }), false);
  assert.equal(await bad({ code: 'GOODCODE', off: 100, until: '31.12.2026' }), false);
  assert.equal(endOfDayMsk('2026-12-31').toISOString(), '2026-12-31T20:59:59.000Z');

  const code = uniqueCode();
  const ok = await createPromo(ctx.db, { code: code.toLowerCase(), off: '300', max: '5', until: '2026-12-31', note: 'тест' });
  assert.equal(ok.ok, true);
  assert.equal(ok.promo.code, code, 'код хранится заглавными');
  assert.equal(ok.promo.amount_off_rub, 300);
  assert.equal(ok.promo.max_uses, 5);
  assert.equal(ok.promo.per_user_limit, 1);
  const dup = await createPromo(ctx.db, { code, off: 100 });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /уже существует/);
});

test('проверка кода: нет такого / выключен / срок истёк / лимит исчерпан / уже использован этим человеком', async () => {
  const u1 = await newUser(); const u2 = await newUser();
  const now = new Date('2026-10-16T12:00:00Z');

  assert.deepEqual(await checkPromo(ctx.db, 'NOPE123', u1, { now }), { ok: false, reason: 'not_found' });
  assert.deepEqual(await checkPromo(ctx.db, 'х', u1, { now }), { ok: false, reason: 'not_found' });

  const fine = await newPromo({ off: 300 });
  const r = await checkPromo(ctx.db, ` ${fine.code.toLowerCase()} `, u1, { now });
  assert.deepEqual(r, { ok: true, promo: { code: fine.code, amountOff: 300 } });

  const off = await newPromo();
  await setPromoActive(ctx.db, off.code, false);
  assert.equal((await checkPromo(ctx.db, off.code, u1, { now })).reason, 'not_found');
  await setPromoActive(ctx.db, off.code, true);
  assert.equal((await checkPromo(ctx.db, off.code, u1, { now })).ok, true);

  const old = await newPromo({ until: '2026-10-15' });
  assert.equal((await checkPromo(ctx.db, old.code, u1, { now })).reason, 'expired');
  const today = await newPromo({ until: '2026-10-16' });
  assert.equal((await checkPromo(ctx.db, today.code, u1, { now })).ok, true, 'в последний день код ещё действует');

  const limited = await newPromo({ max: 2 });
  await redeem(limited.code, u1); await redeem(limited.code, u2);
  assert.equal((await checkPromo(ctx.db, limited.code, await newUser(), { now })).reason, 'used_up');

  const once = await newPromo();
  await redeem(once.code, u1);
  assert.equal((await checkPromo(ctx.db, once.code, u1, { now })).reason, 'already_used');
  assert.equal((await checkPromo(ctx.db, once.code, u2, { now })).ok, true, 'другой человек может');

  const many = await newPromo({ perUser: 3 });
  await redeem(many.code, u1); await redeem(many.code, u1);
  assert.equal((await checkPromo(ctx.db, many.code, u1, { now })).ok, true);
  await redeem(many.code, u1);
  assert.equal((await checkPromo(ctx.db, many.code, u1, { now })).reason, 'already_used');
});

test('запрос на платёж со скидкой: в платёж и в чек идёт сниженная цена, в метках — код и размер скидки; без кода всё как раньше', () => {
  const promo = { code: 'FINNIK200', amountOff: 200 };
  for (const [m, price] of [[1, '199.00'], [6, '1795.00'], [12, '3790.00']]) {
    const b = buildPaymentBody({ months: m, userId: 'u-1', email: 'a@b.ru', returnUrl: 'https://x.ru', promo });
    assert.equal(b.amount.value, price);
    assert.equal(b.receipt.items[0].amount.value, price, 'в чеке та же сумма, что в платеже');
    assert.deepEqual(b.metadata, { user_id: 'u-1', months: String(m), promo: 'FINNIK200', promo_off: '200' });
  }
  const plain = buildPaymentBody({ months: 1, userId: 'u-1', email: 'a@b.ru', returnUrl: 'https://x.ru' });
  assert.equal(plain.amount.value, '399.00');
  assert.deepEqual(plain.metadata, { user_id: 'u-1', months: '1' });
});

test('createPayment: скидка, оставляющая меньше 1 ₽, отклоняется без запроса в ЮKassa', async () => {
  process.env.YOOKASSA_SHOP_ID = 's'; process.env.YOOKASSA_SECRET_KEY = 'k';
  try {
    const never = async () => { throw new Error('не должно быть запроса'); };
    const r = await createPayment({ months: 1, userId: 'u', email: 'a@b.ru', returnUrl: 'x', promo: { code: 'BIGBIG', amountOff: 399 } }, { fetch: never });
    assert.deepEqual(r, { ok: false, reason: 'promo_not_applicable' });
  } finally { delete process.env.YOOKASSA_SHOP_ID; delete process.env.YOOKASSA_SECRET_KEY; }
});

test('monthsFor: оплата со скидкой по промокоду распознаётся только если сумма = цена минус скидка из меток', () => {
  const p = (value, months, off) => ({ amount: { value }, metadata: { months: String(months), ...(off ? { promo: 'X', promo_off: String(off) } : {}) } });
  assert.equal(monthsFor(p('199.00', 1, 200)), 1);
  assert.equal(monthsFor(p('1795.00', 6, 200)), 6);
  assert.equal(monthsFor(p('3790.00', 12, 200)), 12);
  assert.equal(monthsFor(p('199.00', 1)), 0, 'без меток промокода 199 ₽ — не оплата');
  assert.equal(monthsFor(p('250.00', 1, 200)), 0, 'сумма не сходится со скидкой');
  assert.equal(monthsFor(p('399.00', 1, 200)), 1, 'полная цена тоже принимается');
});

function deps(payment) {
  return {
    fetchPayment: async () => ({ ok: true, payment }),
    grant: (uid, months, o) => grantSubscription(uid, months, { ...o, db: ctx.db }),
  };
}
const evt = (id) => ({ event: 'payment.succeeded', object: { id } });

test('оплата с промокодом: подписка включена, использование кода записано один раз (повторное уведомление ничего не удваивает)', async () => {
  const uid = await newUser();
  const promo = await newPromo({ off: 300, max: 10 });
  const pay = { id: `pay-${crypto.randomUUID()}`, status: 'succeeded', paid: true, amount: { value: '1695.00' }, metadata: { user_id: uid, months: '6', promo: promo.code, promo_off: '300' } };
  const r = await processYookassaEvent(ctx.db, evt(pay.id), deps(pay));
  assert.equal(r.result, 'granted');
  const subs = (await ctx.db.from('subscriptions').select('*').eq('user_id', uid)).data;
  assert.equal(subs.length, 1);
  assert.equal(subs[0].period_months, 6);
  assert.equal(subs[0].amount_rub, 1695);
  const reds = (await ctx.db.from('promo_redemptions').select('*').eq('code', promo.code)).data;
  assert.equal(reds.length, 1);
  assert.equal(reds[0].user_id, uid); assert.equal(reds[0].payment_id, pay.id); assert.equal(reds[0].amount_off_rub, 300);
  assert.equal((await processYookassaEvent(ctx.db, evt(pay.id), deps(pay))).result, 'duplicate');
  assert.equal((await ctx.db.from('promo_redemptions').select('*').eq('code', promo.code)).data.length, 1);
  const list = (await listPromos(ctx.db)).find((p) => p.code === promo.code);
  assert.equal(list.used, 1);
});

test('оплата без промокода и платёж с неверной скидкой в метках не засчитывают код', async () => {
  const uid = await newUser();
  const promo = await newPromo();
  const plain = { id: `pay-${crypto.randomUUID()}`, status: 'succeeded', paid: true, amount: { value: '399.00' }, metadata: { user_id: uid, months: '1' } };
  assert.equal((await processYookassaEvent(ctx.db, evt(plain.id), deps(plain))).result, 'granted');
  // в метках скидка 200, а заплачено полную цену: подписка включается, но код не засчитывается
  const mismatch = { id: `pay-${crypto.randomUUID()}`, status: 'succeeded', paid: true, amount: { value: '399.00' }, metadata: { user_id: uid, months: '1', promo: promo.code, promo_off: '200' } };
  assert.equal((await processYookassaEvent(ctx.db, evt(mismatch.id), deps(mismatch))).result, 'granted');
  assert.equal((await ctx.db.from('promo_redemptions').select('*').eq('code', promo.code)).data.length, 0);
});

async function startApi(create) {
  const app = express();
  app.use(express.json());
  app.use(createPaymentRouter({ db: ctx.db, create }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}
const tok = (id) => jwt.sign({ userId: id }, process.env.JWT_SECRET);
const post = (url, token, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

test('/api/promo/check и /api/pay: скидка применяется, ошибки по коду понятные, платёж при ошибке не создаётся', async () => {
  const calls = [];
  const create = async (o) => { calls.push(o); return { ok: true, id: 'pay-pppppppp', url: 'https://yoomoney.ru/pay/p' }; };
  const srv = await startApi(create);
  try {
    const uid = await newUser();
    const promo = await newPromo({ off: 300 });
    assert.equal((await post(`${srv.base}/api/promo/check`, null, { code: promo.code })).status, 401);

    const ok = await post(`${srv.base}/api/promo/check`, tok(uid), { code: promo.code.toLowerCase() });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { code: promo.code, amount_off_rub: 300 });

    const nf = await post(`${srv.base}/api/promo/check`, tok(uid), { code: 'NOSUCH1' });
    assert.equal(nf.status, 400);
    const nfj = await nf.json();
    assert.equal(nfj.error, 'promo_not_found');
    assert.match(nfj.message, /Такого промокода нет/);

    const pay = await post(`${srv.base}/api/pay`, tok(uid), { months: 6, promo: promo.code });
    assert.equal(pay.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].promo, { code: promo.code, amountOff: 300 });
    assert.equal(calls[0].months, 6);

    const bad = await post(`${srv.base}/api/pay`, tok(uid), { months: 1, promo: 'NOSUCH1' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'promo_not_found');
    assert.equal(calls.length, 1, 'при неверном коде платёж не создаётся');

    const noPromo = await post(`${srv.base}/api/pay`, tok(uid), { months: 1 });
    assert.equal(noPromo.status, 200);
    assert.equal(calls[1].promo, undefined, 'без кода — обычная цена');

    const used = await newPromo({ max: 1 });
    await redeem(used.code, await newUser());
    const up = await post(`${srv.base}/api/pay`, tok(uid), { months: 1, promo: used.code });
    assert.equal((await up.json()).error, 'promo_used_up');
    const mine = await newPromo();
    await redeem(mine.code, uid);
    const au = await post(`${srv.base}/api/pay`, tok(uid), { months: 1, promo: mine.code });
    assert.equal((await au.json()).error, 'promo_already_used');
  } finally { await srv.close(); }
});

test('/api/promo/check: не больше 10 проверок в минуту (защита от перебора кодов)', async () => {
  const srv = await startApi(async () => ({ ok: true, id: 'x', url: 'y' }));
  try {
    const uid = await newUser();
    let last;
    for (let i = 0; i < 11; i += 1) last = await post(`${srv.base}/api/promo/check`, tok(uid), { code: `GUESS${i}X` });
    assert.equal(last.status, 429);
  } finally { await srv.close(); }
});

test('управление кодами: выключить, включить, список с числом использований и статусом', async () => {
  const u = await newUser();
  const p = await newPromo({ max: 2, note: 'акция' });
  await redeem(p.code, u);
  const row = (await listPromos(ctx.db)).find((x) => x.code === p.code);
  assert.equal(row.used, 1);
  const d = describePromo(row, new Date('2026-10-16T12:00:00Z'));
  assert.equal(d.used, '1/2'); assert.equal(d.status, 'действует'); assert.equal(d.until, 'без срока'); assert.equal(d.off, '−200 ₽'); assert.equal(d.note, 'акция');
  assert.equal((await setPromoActive(ctx.db, p.code, false)).ok, true);
  assert.equal(describePromo({ ...row, active: false }).status, 'выключен');
  assert.equal(describePromo({ ...row, used: 2 }).status, 'лимит исчерпан');
  assert.equal(describePromo({ ...row, expires_at: '2020-01-01T00:00:00Z' }).status, 'срок истёк');
  assert.equal((await setPromoActive(ctx.db, 'NOSUCHCODE', true)).ok, false);
});

test('кабинет и команда: поле «Промокод» в обоих окнах оплаты, проверка кода, код в запросе оплаты; команда promo.mjs и миграция на месте', () => {
  const profile = read('public/cabinet/profile.html');
  assert.equal((profile.match(/class="promo-box"/g) || []).length, 2, 'поле промокода в окнах «Оформить» и «Продлить»');
  assert.match(profile, /У меня есть промокод/);
  assert.match(profile, /fetch\('\/api\/promo\/check'/);
  assert.match(profile, /payload\.promo = appliedPromo\.code/);
  assert.match(profile, /qs\.get\('promo'\)/);
  const tool = read('tools/promo.mjs');
  for (const w of ["'list'", "'create'", "'off'", "'on'", '--off', '--max', '--until', '--per-user']) assert.ok(tool.includes(w), `команда promo.mjs: ${w}`);
  assert.match(read('db/migrations/006_promo_codes.sql'), /CREATE TABLE IF NOT EXISTS public\.promo_codes/);
});
