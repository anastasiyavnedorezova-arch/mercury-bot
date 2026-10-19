// Возвраты: расчёт по п. 6.3 оферты и отмена подписки после возврата денег (tools/refund.mjs).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { makeDb } from './helpers/testDb.mjs';
import { calcRefundable, findAccounts, paidSubscriptions, cancelAfterRefund } from '../src/payments/refunds.js';

let ctx; let db;
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const uid = () => crypto.randomUUID();
const D = 86400e3;
before(async () => { ctx = await makeDb(); db = ctx.db; });
after(async () => { await ctx?.close(); });

const sub = (startsIso, endsIso, paid) => ({ starts_at: startsIso, ends_at: endsIso, amount_rub: paid });

test('п. 6.3: уплаченная сумма ÷ дней срока × неиспользованных дней', () => {
  const s = sub('2026-10-01T10:00:00Z', '2026-10-31T10:00:00Z', 399); // 30 дней
  const c = calcRefundable(s, new Date('2026-10-11T10:00:00Z'));
  assert.deepEqual(c, { paid: 399, totalDays: 30, unusedDays: 20, amount: 266 });
  assert.equal(calcRefundable(s, new Date('2026-10-01T10:00:00Z')).amount, 399, 'в день оплаты — вся сумма');
  assert.equal(calcRefundable(s, new Date('2026-10-30T10:00:00Z')).amount, 13.3, 'остался 1 день: 399/30');
  assert.equal(calcRefundable(s, new Date('2026-10-31T09:00:00Z')).amount, 0, 'меньше суток — не возвращается');
});

test('п. 6.3: считаются только полные неиспользованные сутки', () => {
  const s = sub('2026-10-01T10:00:00Z', '2026-10-31T10:00:00Z', 300);
  assert.equal(calcRefundable(s, new Date('2026-10-20T22:00:00Z')).unusedDays, 10, '10 суток 12 часов → 10');
});

test('п. 6.3: бонусные месяцы входят в срок, расчёт от фактически уплаченной суммы', () => {
  const s = sub('2026-10-01T00:00:00Z', '2027-04-01T00:00:00Z', 1995); // 6 мес. по цене 5: 182 дня
  const c = calcRefundable(s, new Date('2026-12-01T00:00:00Z'));
  assert.equal(c.totalDays, 182); assert.equal(c.unusedDays, 121);
  assert.equal(c.amount, Math.round((1995 / 182) * 121 * 100) / 100);
  const promo = calcRefundable(sub('2026-10-01T00:00:00Z', '2026-10-31T00:00:00Z', 99), new Date('2026-10-16T00:00:00Z'));
  assert.equal(promo.amount, 49.5, 'с промокодом считается от 99 ₽, а не от 399 ₽');
});

test('п. 6.3: период ещё не начался — вся сумма; уже закончился — ноль', () => {
  const queued = sub('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z', 399);
  assert.equal(calcRefundable(queued, new Date('2026-10-20T00:00:00Z')).amount, 399);
  assert.equal(calcRefundable(queued, new Date('2026-12-05T00:00:00Z')).amount, 0);
});

// ── Отмена после возврата ──
async function account({ email } = {}) {
  const id = uid();
  const { error } = await db.from('users').insert({ id, external_id: id, channel: 'web', email: email ?? `r-${id.slice(0, 8)}@t.ru`, password_hash: 'x' });
  assert.ifError(error);
  return id;
}
async function paid(userId, { startsIn = -10, endsIn = 20, amount = 399, payment = 'pay-' + uid(), status = 'active' } = {}) {
  const now = Date.now();
  const { error } = await db.from('subscriptions').insert({
    user_id: userId, status, period_months: 1, payment_id: payment, amount_rub: amount,
    starts_at: new Date(now + startsIn * D).toISOString(), ends_at: new Date(now + endsIn * D).toISOString(),
  });
  assert.ifError(error);
  return payment;
}
const getSub = async (payment) => (await db.from('subscriptions').select('*').eq('payment_id', payment).single()).data;
const okRefunds = (...amounts) => async () => ({ ok: true, refunds: amounts.map((a, i) => ({ id: 'r' + i, status: 'succeeded', amount: a })) });
// Как в боте: есть ли у человека доступ сейчас
const hasAccess = async (userId) => ((await db.from('subscriptions').select('status').eq('user_id', userId).in('status', ['trial', 'active']).gt('ends_at', new Date().toISOString())).data ?? []).length > 0;

test('отмена: после возврата доступ заканчивается сразу, запись получает статус refunded', async () => {
  const u = await account(); const p = await paid(u);
  assert.equal(await hasAccess(u), true);
  const now = new Date();
  const r = await cancelAfterRefund(db, { userId: u, paymentId: p, now, fetchRefunds: okRefunds(266) });
  assert.deepEqual(r, { ok: true, refunded: 266, freedPromo: false });
  const row = await getSub(p);
  assert.equal(row.status, 'refunded');
  assert.equal(new Date(row.ends_at).getTime(), now.getTime());
  assert.equal(await hasAccess(u), false);
  assert.equal((await cancelAfterRefund(db, { userId: u, paymentId: p, fetchRefunds: okRefunds(1) })).reason, 'already', 'повторно нельзя');
});

test('отмена: без успешного возврата в ЮKassa ничего не меняется (нет возврата, возврат в обработке, сбой проверки)', async () => {
  const u = await account(); const p = await paid(u);
  const before = await getSub(p);
  assert.equal((await cancelAfterRefund(db, { userId: u, paymentId: p, fetchRefunds: okRefunds() })).reason, 'no_refund');
  const pending = async () => ({ ok: true, refunds: [{ id: 'r', status: 'pending', amount: 100 }] });
  assert.equal((await cancelAfterRefund(db, { userId: u, paymentId: p, fetchRefunds: pending })).reason, 'no_refund');
  const broken = async () => ({ ok: false, reason: 'yookassa_error' });
  const r = await cancelAfterRefund(db, { userId: u, paymentId: p, fetchRefunds: broken });
  assert.deepEqual({ ok: r.ok, reason: r.reason, detail: r.detail }, { ok: false, reason: 'check_failed', detail: 'yookassa_error' });
  assert.deepEqual(await getSub(p), before);
  assert.equal(await hasAccess(u), true);
  // --no-check: только когда деньги точно возвращены
  assert.equal((await cancelAfterRefund(db, { userId: u, paymentId: p, noCheck: true })).ok, true);
});

test('отмена: частичные возвраты суммируются; чужой платёж и неизвестный номер не подходят', async () => {
  const u = await account(); const other = await account(); const p = await paid(u);
  assert.equal((await cancelAfterRefund(db, { userId: other, paymentId: p, fetchRefunds: okRefunds(100) })).reason, 'not_found');
  assert.equal((await cancelAfterRefund(db, { userId: u, paymentId: 'нет-такого', fetchRefunds: okRefunds(100) })).reason, 'not_found');
  assert.equal(await hasAccess(u), true);
  const r = await cancelAfterRefund(db, { userId: u, paymentId: p, fetchRefunds: okRefunds(100, 66.5) });
  assert.equal(r.refunded, 166.5);
});

test('отмена: если после этого периода есть ещё оплаченный, нужен --force (иначе перерыв в доступе)', async () => {
  const u = await account();
  const first = await paid(u, { startsIn: -10, endsIn: 20 });
  const second = await paid(u, { startsIn: 20, endsIn: 50 });
  const r = await cancelAfterRefund(db, { userId: u, paymentId: first, fetchRefunds: okRefunds(100) });
  assert.deepEqual({ ok: r.ok, reason: r.reason, detail: r.detail }, { ok: false, reason: 'later_periods', detail: 1 });
  assert.equal((await getSub(first)).status, 'active');
  assert.equal((await cancelAfterRefund(db, { userId: u, paymentId: first, fetchRefunds: okRefunds(100), force: true })).ok, true);
  assert.equal((await getSub(second)).status, 'active', 'второй период не тронут');
});

test('отмена: период, который ещё не начался, закрывается нулевой длины; закончившийся сохраняет свои даты', async () => {
  const u = await account();
  const queued = await paid(u, { startsIn: 5, endsIn: 35 });
  const now = new Date();
  assert.equal((await cancelAfterRefund(db, { userId: u, paymentId: queued, now, fetchRefunds: okRefunds(399) })).ok, true);
  const q = await getSub(queued);
  assert.equal(new Date(q.starts_at).getTime(), now.getTime()); assert.equal(new Date(q.ends_at).getTime(), now.getTime());
  const old = await paid(u, { startsIn: -60, endsIn: -30 });
  const before = await getSub(old);
  await cancelAfterRefund(db, { userId: u, paymentId: old, fetchRefunds: okRefunds(10) });
  const after2 = await getSub(old);
  assert.equal(after2.ends_at, before.ends_at); assert.equal(after2.status, 'refunded');
});

test('промокод: по умолчанию остаётся использованным, с --free-promo освобождается', async () => {
  await db.from('promo_codes').insert({ code: 'RFND' + Date.now().toString(36).toUpperCase().slice(-5), amount_off_rub: 300 });
  const code = (await db.from('promo_codes').select('code').like('code', 'RFND%')).data[0].code;
  const u = await account(); const p1 = await paid(u, { amount: 99 }); const p2 = await paid(u, { amount: 99, startsIn: -100, endsIn: -70 });
  await db.from('promo_redemptions').insert([{ code, user_id: u, payment_id: p1, amount_off_rub: 300 }, { code, user_id: u, payment_id: p2, amount_off_rub: 300 }]);
  const count = async () => (await db.from('promo_redemptions').select('id', { count: 'exact', head: true }).eq('code', code)).count;
  assert.equal((await cancelAfterRefund(db, { userId: u, paymentId: p1, fetchRefunds: okRefunds(99) })).freedPromo, false);
  assert.equal(await count(), 2);
  assert.equal((await cancelAfterRefund(db, { userId: u, paymentId: p2, fetchRefunds: okRefunds(99), freePromo: true })).freedPromo, true);
  assert.equal(await count(), 1, 'освобождён только платёж, по которому вернули');
});

test('поиск аккаунта: по email (любой регистр), id и Telegram id; объединённые и удалённые пропускаются', async () => {
  const id = uid(); const tg = '55' + Math.floor(Math.random() * 1e6);
  await db.from('users').insert({ id, external_id: tg, channel: 'telegram', email: 'find.me@t.ru' });
  assert.equal((await findAccounts(db, 'find.me@t.RU'))[0]?.id, id);
  assert.equal((await findAccounts(db, id))[0]?.id, id);
  assert.equal((await findAccounts(db, tg))[0]?.id, id);
  await db.from('users').update({ status: 'merged' }).eq('id', id);
  assert.deepEqual(await findAccounts(db, id), []);
  assert.deepEqual(await findAccounts(db, ''), []);
  const u = await account(); await paid(u);
  assert.equal((await paidSubscriptions(db, u)).length, 1);
});

test('инструмент: команды calc и cancel, правила оферты и подключение проверки ЮKassa', () => {
  const tool = read('tools/refund.mjs');
  for (const w of ['calc', 'cancel', '--payment', '--free-promo', '--force', '--no-check', 'п. 6.3']) assert.ok(tool.includes(w), w);
  assert.ok(tool.includes('listRefunds') && read('src/payments/yookassa.js').includes('/refunds?payment_id='));
});
