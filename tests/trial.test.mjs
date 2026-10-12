import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { makeDb } from './helpers/testDb.mjs';
import {
  TRIAL_DAYS, rowsHadTrial, hadTrial, pickSubscription, startTrial, expireRow, hasLaterAccess,
} from '../src/utils/trial.js';

let ctx;
before(async () => { ctx = await makeDb(); });
after(async () => { await ctx?.close(); });

const DAY = 86_400_000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

async function newUser(extra = {}) {
  const id = crypto.randomUUID();
  const { error } = await ctx.db.from('users').insert({ id, external_id: id, channel: 'web', email: `${id}@t.ru`, ...extra });
  assert.ifError(error);
  return id;
}
const addSub = (user_id, row) => ctx.db.from('subscriptions').insert({ user_id, starts_at: iso(-10), ...row });
const subsOf = async (uid) => (await ctx.db.from('subscriptions').select('*').eq('user_id', uid)).data;

test('rowsHadTrial: триал считается использованным, даже когда закончился', () => {
  assert.equal(rowsHadTrial([]), false);
  assert.equal(rowsHadTrial([{ status: 'trial', payment_id: null }]), true);
  assert.equal(rowsHadTrial([{ status: 'expired', payment_id: null }]), true);   // закончившийся триал
  assert.equal(rowsHadTrial([{ status: 'expired', payment_id: 'pay_1' }]), false); // закончившаяся платная подписка
  assert.equal(rowsHadTrial([{ status: 'active', payment_id: 'pay_1' }]), false);
});

test('pickSubscription: действующий доступ с самой поздней датой, иначе свежая запись, иначе free', () => {
  const now = new Date();
  const rows = [
    { status: 'trial', ends_at: iso(5) },
    { status: 'active', ends_at: iso(200) },
    { status: 'expired', ends_at: iso(-30) },
  ];
  assert.equal(pickSubscription(rows, now).status, 'active');
  assert.equal(pickSubscription([{ status: 'expired', ends_at: iso(-30) }, { status: 'expired', ends_at: iso(-3) }], now).ends_at, iso(-3).slice(0, 10) + pickSubscription([{ status: 'expired', ends_at: iso(-3) }], now).ends_at.slice(10));
  assert.equal(pickSubscription([{ status: 'trial', ends_at: iso(-1) }], now).status, 'trial'); // закончился по дате, но ещё не помечен
  assert.equal(pickSubscription([], now).status, 'free');
  assert.equal(pickSubscription(null, now).status, 'free');
});

test('startTrial: новому пользователю даёт 30 дней, повторно и после триала — нет', async () => {
  const uid = await newUser();
  const t = await startTrial(ctx.db, uid);
  assert.equal(t.ok, true);
  const rows = await subsOf(uid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'trial');
  assert.equal(rows[0].payment_id, null);
  const days = Math.round((new Date(rows[0].ends_at) - new Date(rows[0].starts_at)) / DAY);
  assert.equal(days, TRIAL_DAYS);

  const again = await startTrial(ctx.db, uid);
  assert.deepEqual([again.ok, again.reason], [false, 'exists']);
  assert.equal((await subsOf(uid)).length, 1);

  // закончившийся триал: автоматически новый не выдаётся, и hadTrial это видит
  const u2 = await newUser();
  await addSub(u2, { status: 'expired', ends_at: iso(-1), payment_id: null });
  assert.equal((await startTrial(ctx.db, u2)).reason, 'exists');
  assert.equal(await hadTrial(ctx.db, u2), true);
  assert.equal(await hadTrial(ctx.db, await newUser()), false);
});

test('startTrial без ограничения (кнопка «Активировать»): вставляет запись', async () => {
  const uid = await newUser();
  await addSub(uid, { status: 'expired', ends_at: iso(-5), payment_id: 'pay_old', amount_rub: 399, period_months: 1 });
  const t = await startTrial(ctx.db, uid, { onlyIfNoSubscriptions: false });
  assert.equal(t.ok, true);
  assert.equal((await subsOf(uid)).length, 2);
});

test('expireRow закрывает только одну запись: оплаченная подписка не пропадает при окончании триала', async () => {
  const uid = await newUser();
  await addSub(uid, { status: 'trial', ends_at: iso(-1), payment_id: null });
  await addSub(uid, { status: 'active', starts_at: iso(-1), ends_at: iso(180), payment_id: 'pay_1', amount_rub: 1995, period_months: 6 });
  const rows = await subsOf(uid);
  const trial = rows.find((r) => r.status === 'trial');
  await expireRow(ctx.db, trial.id);
  const after = await subsOf(uid);
  assert.equal(after.find((r) => r.id === trial.id).status, 'expired');
  assert.equal(after.filter((r) => r.status === 'active').length, 1);
});

test('hasLaterAccess: видит оплаченный период, идущий дольше триала', async () => {
  const uid = await newUser();
  await addSub(uid, { status: 'trial', ends_at: iso(3), payment_id: null });
  const trialEnd = iso(3);
  assert.equal(await hasLaterAccess(ctx.db, uid, trialEnd), false);
  await addSub(uid, { status: 'active', starts_at: iso(3), ends_at: iso(33), payment_id: 'pay_2', amount_rub: 399, period_months: 1 });
  assert.equal(await hasLaterAccess(ctx.db, uid, trialEnd), true);
});

test('разовый скрипт для существующих: даёт триал только тем, у кого нет записей подписки; повторный запуск безопасен', async () => {
  const consent = new Date().toISOString();
  const fresh = await newUser({ terms_accepted_at: consent });                       // получит триал
  const noConsent = await newUser();                                                // без согласия — не получит
  const manual = await newUser({ terms_accepted_at: consent });                      // триал вручную до 31.12.2026 — не трогаем
  await addSub(manual, { status: 'trial', ends_at: '2026-12-31T00:00:00Z', payment_id: null });
  const expired = await newUser({ terms_accepted_at: consent });                     // триал уже был — не трогаем
  await addSub(expired, { status: 'expired', ends_at: iso(-20), payment_id: null });
  const paid = await newUser({ terms_accepted_at: consent });
  await addSub(paid, { status: 'active', ends_at: iso(100), payment_id: 'p', amount_rub: 1995, period_months: 6 });

  const file = read('db/oneoff/2026-10-12_auto_trial_existing.sql');
  assert.ok(/BEGIN;[\s\S]*COMMIT;/.test(file));
  const start = file.indexOf('INSERT INTO');
  const insert = file.slice(start, file.indexOf(';', start) + 1); // сам оператор без BEGIN/COMMIT
  await ctx.query(insert);
  await ctx.query(insert);

  assert.equal((await subsOf(fresh)).length, 1);
  assert.equal((await subsOf(fresh))[0].status, 'trial');
  assert.equal((await subsOf(noConsent)).length, 0);
  const m = await subsOf(manual);
  assert.equal(m.length, 1);
  assert.equal(new Date(m[0].ends_at).toISOString(), '2026-12-31T00:00:00.000Z');
  assert.equal((await subsOf(expired)).length, 1);
  assert.equal((await subsOf(paid)).length, 1);
});

test('тексты и код: нет просьбы включать триал вручную, ошибки закрытия подписок исправлены', () => {
  const idx = read('public/index.html');
  assert.ok(!idx.includes('Активировать пробный период'));
  assert.ok(idx.includes('включатся сразу'));
  const n = read('src/notifications/index.js');
  assert.ok(!/update\(\{ status: 'expired' \}\)\s*\.eq\('user_id'/.test(n), 'закрытие всех записей пользователя');
  assert.ok(n.includes('expireRow(supabase, sub.id)'));
  const o = read('src/handlers/onboarding.js');
  assert.ok(o.includes('startTrial(supabase'));
  const kb = o.slice(o.indexOf('const STEP1_TRIAL_KEYBOARD'), o.indexOf('const CONSENT_TEXT'));
  assert.ok(!kb.includes('activate_trial'));
  for (const f of ['src/handlers/budget.js', 'src/handlers/analytics.js']) {
    assert.ok(!read(f).includes("callback_data: 'budget:trial'"), f);
  }
  assert.ok(read('src/auth/authRouter.js').includes('startTrial(db, id)'));
});
