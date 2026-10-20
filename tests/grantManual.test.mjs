// Ручная выдача подписки (tools/grant.mjs): расчёт периода, запись без платежа, любые аккаунты.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { makeDb } from './helpers/testDb.mjs';
import { findAccounts, paidSubscriptions } from '../src/payments/refunds.js';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:1/test';   // grantSubscription подключает db.js; боевой базы в тестах нет
const { validMonths, planGrant, applyGrant, accessUntil } = await import('../src/accounts/grantManual.js');

let ctx; let db;
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const uid = () => crypto.randomUUID();
const D = 86400e3;
before(async () => { ctx = await makeDb(); db = ctx.db; });
after(async () => { await ctx?.close(); });

async function webAccount(email) {
  const id = uid();
  const { error } = await db.from('users').insert({ id, external_id: id, channel: 'web', email: email ?? `g-${id.slice(0, 8)}@t.ru`, password_hash: 'x' });
  assert.ifError(error);
  return id;
}
async function addSub(userId, { status = 'active', startsIn, endsIn, paymentId = null }) {
  const { error } = await db.from('subscriptions').insert({
    user_id: userId, status, period_months: 1,
    starts_at: new Date(Date.now() + startsIn * D).toISOString(),
    ends_at: new Date(Date.now() + endsIn * D).toISOString(), payment_id: paymentId,
  });
  assert.ifError(error);
}

test('validMonths: целое число от 1 до 24', () => {
  assert.equal(validMonths('1'), 1);
  assert.equal(validMonths(12), 12);
  assert.equal(validMonths('24'), 24);
  for (const bad of ['0', '25', '-1', '1.5', 'abc', '', undefined, null]) assert.equal(validMonths(bad), null, String(bad));
});

test('выдача веб-аккаунту без доступа: период начинается сейчас', async () => {
  const u = await webAccount();
  const now = new Date();
  const plan = await planGrant(db, u, 3, now);
  assert.equal(plan.current, null);
  assert.equal(plan.startsAt.getTime(), now.getTime());
  assert.ok(plan.endsAt.getTime() > now.getTime() + 85 * D && plan.endsAt.getTime() < now.getTime() + 95 * D);
  assert.equal(await accessUntil(db, u), null, 'планирование ничего не записывает');
  const r = await applyGrant(db, u, 3);
  const until = await accessUntil(db, u);
  assert.equal(until.getTime(), r.endsAt.getTime());
});

test('если доступ ещё действует, новый период идёт после него', async () => {
  const u = await webAccount();
  await addSub(u, { status: 'trial', startsIn: -5, endsIn: 10 });
  const plan = await planGrant(db, u, 1);
  assert.ok(Math.abs(plan.current.getTime() - (Date.now() + 10 * D)) < 5000);
  assert.equal(plan.startsAt.getTime(), plan.current.getTime());
  await applyGrant(db, u, 1);
  const until = await accessUntil(db, u);
  assert.ok(until.getTime() > Date.now() + 38 * D, 'пробный период не потерян, месяц добавлен сверху');
});

test('закончившийся доступ не считается: период начинается сейчас', async () => {
  const u = await webAccount();
  await addSub(u, { startsIn: -40, endsIn: -10, paymentId: 'old-pay' });
  const plan = await planGrant(db, u, 1);
  assert.equal(plan.current, null);
  assert.ok(Math.abs(plan.startsAt.getTime() - Date.now()) < 5000);
});

test('запись без платежа: возврату по tools/refund.mjs не подлежит, статус active', async () => {
  const u = await webAccount();
  await applyGrant(db, u, 2);
  const { data } = await db.from('subscriptions').select('*').eq('user_id', u);
  assert.equal(data.length, 1);
  assert.equal(data[0].status, 'active');
  assert.equal(data[0].payment_id, null);
  assert.deepEqual(await paidSubscriptions(db, u), []);
});

test('поиск аккаунта: по email, id и telegram id; объединённые и удалённые не находятся', async () => {
  const email = `grant-${uid().slice(0, 6)}@t.ru`;
  const w = await webAccount(email);
  assert.equal((await findAccounts(db, email.toUpperCase()))[0]?.id, w);
  assert.equal((await findAccounts(db, w))[0]?.id, w);
  const tg = String(Math.floor(Math.random() * 1e9) + 1e9);
  const t = uid();
  await db.from('users').insert({ id: t, external_id: tg, channel: 'telegram' });
  assert.equal((await findAccounts(db, tg))[0]?.id, t);
  await db.from('users').update({ status: 'merged' }).eq('id', t);
  assert.equal((await findAccounts(db, tg)).length, 0);
});

test('tools/grant.mjs: по умолчанию ничего не пишет, выдаёт только с --yes', () => {
  const src = read('tools/grant.mjs');
  assert.match(src, /includes\('--yes'\)/);
  assert.ok(src.indexOf('if (!yes)') < src.indexOf('applyGrant(supabase'), 'проверка --yes стоит до записи');
  assert.match(src, /Пока ничего не изменено/);
});
