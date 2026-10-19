import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { makeDb } from './helpers/testDb.mjs';
import { decideLetter, runChain, inSendWindow } from '../src/emails/chain.js';
import { needsPay } from '../src/emails/letters.js';
import { classify, normalizeEvent, extractEvents, createRusenderRouter } from '../src/emails/events.js';
import { sendWelcomeEmail } from '../src/utils/email.js';

process.env.JWT_SECRET = 'test-secret';
const H = 3600e3, D = 24 * H;
const NOW = new Date('2026-10-20T12:00:00+03:00'); // рабочее окно
const ago = (ms, now = NOW) => new Date(now.getTime() - ms).toISOString();
const inFuture = (ms, now = NOW) => new Date(now.getTime() + ms).toISOString();

function facts(over = {}) {
  return {
    now: NOW,
    user: { created_at: ago(10 * D), email_letters_accepted: true, email_unsubscribed_at: null, ...(over.user ?? {}) },
    isNew: true, sent: {}, subs: [], hasTransactions: false, payReady: true, testimonialsOk: true,
    ...over,
    ...(over.user ? { user: { created_at: ago(10 * D), email_letters_accepted: true, email_unsubscribed_at: null, ...over.user } } : {}),
  };
}
const trial = (endsIn, now = NOW) => ({ status: 'trial', ends_at: inFuture(endsIn, now), payment_id: null });
const sentRow = (agoMs) => ({ status: 'sent', sent_at: ago(agoMs), created_at: ago(agoMs) });
const key = (f) => decideLetter(f)?.key ?? null;

test('окно отправки 10:00–20:00 по Москве', () => {
  assert.equal(inSendWindow(new Date('2026-10-20T09:59:00+03:00')), false);
  assert.equal(inSendWindow(new Date('2026-10-20T10:00:00+03:00')), true);
  assert.equal(inSendWindow(new Date('2026-10-20T19:59:00+03:00')), true);
  assert.equal(inSendWindow(new Date('2026-10-20T20:00:00+03:00')), false);
});

test('письма с кнопками «Оплатить» определяются автоматически', () => {
  for (const k of ['trial5', 'trial1', 'trialover', 'sub5', 'sub1', 'subover']) assert.equal(needsPay(k), true, k);
  for (const k of ['welcome', 'activation', 'activation2', 'help', 'features', 'sub_started']) assert.equal(needsPay(k), false, k);
});

test('№1 приветствие: через 5 минут, в любое время суток, не позже суток', () => {
  const night = new Date('2026-10-20T03:00:00+03:00');
  const f = (ageMs, now = night) => facts({ now, user: { created_at: ago(ageMs, now) }, subs: [trial(30 * D, now)] });
  assert.equal(key(f(2 * 60e3)), null);
  assert.equal(key(f(6 * 60e3)), 'welcome');
  assert.equal(key(f(23 * H)), 'welcome');
  assert.equal(key(f(25 * H)), null);
  assert.equal(key({ ...f(6 * 60e3), sent: { welcome: sentRow(60e3) } }), null, 'второй раз не шлём');
  assert.equal(key({ ...f(6 * 60e3), isNew: false }), null, 'старым аккаунтам приветствие не нужно');
});

test('№2 активация: 48 часов, есть согласие, нет записей, в окне', () => {
  const base = { subs: [trial(20 * D)], sent: { welcome: sentRow(47 * H) } };
  assert.equal(key(facts({ ...base, user: { created_at: ago(47 * H) } })), null);
  assert.equal(key(facts({ ...base, user: { created_at: ago(49 * H) } })), 'activation');
  assert.equal(key(facts({ ...base, user: { created_at: ago(49 * H) }, hasTransactions: true })), null);
  assert.equal(key(facts({ ...base, user: { created_at: ago(49 * H), email_letters_accepted: false } })), null);
  assert.equal(key(facts({ ...base, user: { created_at: ago(49 * H), email_unsubscribed_at: ago(H) } })), null);
  assert.equal(key(facts({ ...base, user: { created_at: ago(11 * D) } })), null, 'слишком поздно');
  const evening = new Date('2026-10-20T21:00:00+03:00');
  assert.equal(key(facts({ now: evening, subs: [trial(20 * D, evening)], user: { created_at: ago(49 * H, evening) }, sent: { welcome: sentRow(48 * H) } })), null, 'вне окна');
});

test('№2.1 через сутки после №2, №2.2 через двое суток после №2.1; запись останавливает цепочку', () => {
  const subs = [trial(20 * D)];
  const user = { created_at: ago(6 * D) };
  assert.equal(key(facts({ subs, user, sent: { welcome: sentRow(6 * D), activation: sentRow(23 * H) } })), null);
  assert.equal(key(facts({ subs, user, sent: { welcome: sentRow(6 * D), activation: sentRow(25 * H) } })), 'activation2');
  const s2 = { welcome: sentRow(6 * D), activation: sentRow(4 * D), activation2: sentRow(47 * H) };
  assert.equal(key(facts({ subs, user, sent: s2 })), null);
  s2.activation2 = sentRow(49 * H);
  assert.equal(key(facts({ subs, user, sent: s2 })), 'help');
  assert.equal(key(facts({ subs, user, sent: s2, testimonialsOk: false })), null);
  assert.equal(key(facts({ subs, user, sent: s2, hasTransactions: true })), null);
});

test('пауза между маркетинговыми письмами — не меньше 20 часов', () => {
  const subs = [trial(20 * D)];
  const user = { created_at: ago(6 * D) };
  // №2 отправлено 25 часов назад → №2.1 можно; но если другое письмо ушло 10 часов назад — нельзя
  const sent = { activation: sentRow(25 * H), trial5: sentRow(10 * H) };
  assert.equal(key(facts({ subs, user, sent })), null);
});

test('№3 возможности: 5 дней с регистрации и с последнего письма, пока в пробном ≥ 2 дней', () => {
  const user = { created_at: ago(6 * D) };
  const sent = { welcome: sentRow(6 * D) };
  assert.equal(key(facts({ user, sent, subs: [trial(20 * D)], hasTransactions: true })), 'features');
  const chainDone = { welcome: sentRow(12 * D), activation: sentRow(10 * D), activation2: sentRow(9 * D), help: sentRow(7 * D) };
  assert.equal(key(facts({ user: { created_at: ago(12 * D) }, sent: chainDone, subs: [trial(20 * D)] })), 'features', 'после всей цепочки активации');
  assert.equal(key(facts({ user: { created_at: ago(12 * D) }, sent: { ...chainDone, help: sentRow(4 * D) }, subs: [trial(20 * D)] })), null);
  assert.equal(key(facts({ user: { created_at: ago(4 * D) }, sent: { welcome: sentRow(4 * D) }, subs: [trial(20 * D)], hasTransactions: true })), null, 'ещё нет 5 дней с регистрации');
  assert.equal(key(facts({ user, sent: { welcome: sentRow(6 * D), activation: sentRow(3 * D) }, subs: [trial(20 * D)], hasTransactions: true })), null, 'после последнего письма прошло < 5 дней');
  assert.equal(key(facts({ user, sent, subs: [trial(1.5 * D)], hasTransactions: true })), null, 'пробный почти закончился: ни №3, ни №4.1');
  assert.equal(key(facts({ user, sent, subs: [{ status: 'active', ends_at: inFuture(20 * D), payment_id: 'p' }], hasTransactions: true })), null, 'платным не шлём');
  assert.equal(key(facts({ user, sent, subs: [trial(20 * D)], hasTransactions: true })), 'features', 'и тем, кто уже ведёт записи');
});

test('№4.1 / №4.2: за 5 и за 1 день до конца пробного, только без платной подписки', () => {
  const f = (endsIn, extra = {}) => facts({ isNew: false, subs: [trial(endsIn)], ...extra });
  assert.equal(key(f(6 * D)), null);
  assert.equal(key(f(4.9 * D)), 'trial5');
  assert.equal(key(f(2.5 * D)), 'trial5');
  assert.equal(key(f(1.5 * D)), null);
  assert.equal(key(f(0.9 * D)), 'trial1');
  assert.equal(key(f(0.9 * D, { sent: { trial5: sentRow(3 * D) } })), 'trial1');
  assert.equal(key(f(4 * D, { sent: { trial5: sentRow(H) } })), null, 'второй раз не шлём');
  assert.equal(key(f(4 * D, { subs: [trial(4 * D), { status: 'active', ends_at: inFuture(60 * D), payment_id: 'p' }] })), null, 'оплатил — не напоминаем');
  assert.equal(key(f(4 * D, { payReady: false })), null, 'нет ссылок оплаты — не шлём');
  assert.equal(key(f(4 * D, { user: { email_letters_accepted: false, email_unsubscribed_at: ago(D) } })), 'trial5', 'сервисное письмо уходит и отписавшимся');
  const night = new Date('2026-10-20T08:00:00+03:00');
  assert.equal(key(facts({ now: night, isNew: false, subs: [trial(4 * D, night)] })), null, 'вне окна');
});

test('№5: пробный закончился не больше 3 дней назад, платных записей нет', () => {
  const expired = (agoMs) => ({ status: 'expired', ends_at: ago(agoMs), payment_id: null });
  const f = (subs, extra = {}) => facts({ isNew: false, subs, ...extra });
  assert.equal(key(f([expired(H)])), 'trialover');
  assert.equal(key(f([expired(2.9 * D)])), 'trialover');
  assert.equal(key(f([expired(3.1 * D)])), null);
  assert.equal(key(f([expired(D), { status: 'expired', ends_at: ago(2 * D), payment_id: 'p1' }])), 'subover', 'раньше платил — это не «пробный закончился», а «подписка закончилась»');
  assert.equal(key(f([expired(D), { status: 'expired', ends_at: ago(20 * D), payment_id: 'p1' }])), null, 'платная давно закончилась — не пишем');
  assert.equal(key(f([expired(D), { status: 'active', ends_at: inFuture(5 * D), payment_id: 'p' }])), 'sub5', 'доступ действует — не «пробный закончился»');
  assert.equal(key(f([expired(D), { status: 'active', ends_at: inFuture(20 * D), payment_id: 'p' }])), null);
  assert.equal(key(f([expired(D)], { payReady: false })), null);
  assert.equal(key(f([])), null, 'без записей подписки ничего не шлём');
});

const paid = (endsInMs, extra = {}) => ({ status: 'active', ends_at: inFuture(endsInMs), payment_id: 'pay', ...extra });
const paidEnded = (agoMs) => ({ status: 'expired', ends_at: ago(agoMs), payment_id: 'pay' });
const day = (ms) => new Date(Date.parse(inFuture(ms))).toISOString().slice(0, 10);

test('оплаченная подписка: за 5 дней и за 1 день до конца, один раз на каждый период', () => {
  const f = (endsIn, extra = {}) => facts({ isNew: false, subs: [paid(endsIn)], ...extra });
  assert.equal(key(f(6 * D)), null);
  assert.equal(key(f(4.9 * D)), 'sub5');
  assert.equal(key(f(2.5 * D)), 'sub5');
  assert.equal(key(f(1.5 * D)), null);
  assert.equal(key(f(0.9 * D)), 'sub1');
  assert.equal(decideLetter(f(4 * D)).logKey, `sub5:${day(4 * D)}`, 'в журнале ключ с датой окончания периода');
  assert.equal(decideLetter(f(0.5 * D)).logKey, `sub1:${day(0.5 * D)}`);
  assert.equal(key(f(4 * D, { sent: { [`sub5:${day(4 * D)}`]: sentRow(H) } })), null, 'второй раз за период не шлём');
  assert.equal(key(f(0.9 * D, { sent: { [`sub5:${day(0.9 * D)}`]: sentRow(4 * D) } })), 'sub1', 'после «5 дней» всё равно придёт «1 день»');
  assert.equal(key(f(0.9 * D, { sent: { [`sub1:${day(0.9 * D)}`]: sentRow(H) } })), null);
  assert.equal(key(f(4 * D, { sent: { 'sub5:2026-01-01': sentRow(300 * D) } })), 'sub5', 'письмо за прошлый период не мешает новому');
  assert.equal(key(f(4 * D, { payReady: false })), null, 'нет ссылок оплаты — не шлём');
  assert.equal(key(f(4 * D, { user: { email_letters_accepted: false, email_unsubscribed_at: ago(D) } })), 'sub5', 'сервисное письмо уходит и отписавшимся');
  const night = new Date('2026-10-20T08:00:00+03:00');
  assert.equal(key(facts({ now: night, isNew: false, subs: [paid(4 * D, {})].map((r) => ({ ...r, ends_at: inFuture(4 * D, night) })) })), null, 'вне окна');
  assert.equal(key(f(4 * D, { isNew: true })), 'sub5', 'новым аккаунтам тоже');
});

test('оплаченная подписка: продлил — напоминаний нет; пробный период — не «подписка»', () => {
  const f = (subs, extra = {}) => facts({ isNew: false, subs, ...extra });
  assert.equal(key(f([paid(4 * D), paid(34 * D)])), null, 'продлил заранее — конец сдвинулся');
  assert.equal(key(f([paidEnded(40 * D), paid(4 * D)])), 'sub5', 'старые периоды не считаются');
  assert.equal(key(f([trial(4 * D)])), 'trial5', 'пробный получает свои письма, не «подписочные»');
  assert.equal(key(f([paid(3 * D), trial(10 * D)])), null, 'пока есть более длинный доступ — молчим');
});

test('оплаченная подписка закончилась: письмо в течение 3 дней, один раз, если не продлил', () => {
  const f = (subs, extra = {}) => facts({ isNew: false, subs, ...extra });
  assert.equal(key(f([paidEnded(H)])), 'subover');
  assert.equal(key(f([paidEnded(2.9 * D)])), 'subover');
  assert.equal(key(f([paidEnded(3.1 * D)])), null);
  const k = decideLetter(f([paidEnded(D)])).logKey;
  assert.match(k, /^subover:\d{4}-\d{2}-\d{2}$/);
  assert.equal(key(f([paidEnded(D)], { sent: { [k]: sentRow(H) } })), null, 'второй раз не шлём');
  assert.equal(key(f([paidEnded(D), paid(20 * D)])), null, 'уже продлил — не пишем');
  assert.equal(key(f([paidEnded(D)], { payReady: false })), null);
  assert.equal(key(f([paidEnded(D)], { user: { email_letters_accepted: false, email_unsubscribed_at: ago(D) } })), 'subover');
  assert.equal(key(f([{ status: 'expired', ends_at: ago(D), payment_id: null }])), 'trialover', 'без оплаты это «пробный закончился»');
  assert.equal(key(f([{ status: 'expired', ends_at: ago(5 * D), payment_id: null }, paidEnded(D)])), 'subover');
});

test('сбой отправки: повтор через час, не больше 3 попыток', () => {
  const failed = (agoMs, attempts) => ({ status: 'failed', created_at: ago(5 * D), attempted_at: ago(agoMs), attempts });
  const f = (entry) => facts({ isNew: false, subs: [trial(4 * D)], sent: { trial5: entry } });
  assert.equal(key(f(failed(10 * 60e3, 1))), null);
  assert.equal(key(f(failed(2 * H, 1))), 'trial5');
  assert.equal(key(f(failed(2 * H, 3))), null);
  assert.equal(key(f({ status: 'sending', created_at: ago(2 * H) })), null, 'зависшее «отправляется» не повторяем (защита от дублей)');
});

// ── Запуск по базе ──────────────────────────────────────────────────────────

let ctx;
before(async () => { ctx = await makeDb(); });
after(async () => { await ctx?.close(); });

let n = 0;
async function user(over = {}) {
  n += 1;
  const u = { email: `c${n}@example.com`, created_at: ago(10 * D), accepted: true, status: 'active', ...over };
  const r = await ctx.query(
    'INSERT INTO public.users (external_id, channel, email, email_letters_accepted, status, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [`c${n}`, 'web', u.email, u.accepted, u.status, u.created_at]
  );
  return r.rows[0].id;
}
const addTrial = (id, endsIn) => ctx.query("INSERT INTO public.subscriptions (user_id, status, starts_at, ends_at) VALUES ($1,'trial',$2,$3)", [id, ago(5 * D), inFuture(endsIn)]);
const sender = () => { const calls = []; return { calls, fn: async (db, id, k) => { calls.push([id, k]); return { ok: true }; } }; };
const reset = async () => { await ctx.query('DELETE FROM public.email_events'); await ctx.query('DELETE FROM public.email_log'); await ctx.query('DELETE FROM public.transactions'); await ctx.query('DELETE FROM public.subscriptions'); await ctx.query('DELETE FROM public.users'); };
const START = new Date(ago(30 * D));
const base = { now: NOW, chainStart: START, only: null, payReady: true, testimonialsOk: true, pauseMs: 0 };

test('runChain: off — ничего; dry — только план, письма и журнал не трогает; on — отправляет', async () => {
  await reset();
  const id = await user({ created_at: ago(10 * 60e3) });
  await addTrial(id, 29 * D);
  const s = sender();
  assert.deepEqual((await runChain(ctx.db, { ...base, mode: 'off', sender: s.fn })).planned, []);
  const dry = await runChain(ctx.db, { ...base, mode: 'dry', sender: s.fn });
  assert.equal(dry.planned.length, 1);
  assert.equal(dry.planned[0].key, 'welcome');
  assert.match(dry.planned[0].email, /^c\*\*\*@example\.com$/, 'адрес в логе скрыт');
  assert.equal(s.calls.length, 0);
  const on = await runChain(ctx.db, { ...base, mode: 'on', sender: s.fn });
  assert.equal(on.sent, 1);
  assert.deepEqual(s.calls, [[id, 'welcome']]);
});

test('runChain: список разрешённых адресов, лимит, заблокированные и «старые» аккаунты', async () => {
  await reset();
  const a = await user({ email: 'a@example.com', created_at: ago(20 * 60e3) });
  const b = await user({ email: 'b@example.com', created_at: ago(15 * 60e3) });
  const blocked = await user({ email: 'x@example.com', created_at: ago(15 * 60e3) });
  await ctx.query("UPDATE public.users SET email_blocked_at = now() WHERE id=$1", [blocked]);
  const del = await user({ email: 'd@example.com', created_at: ago(15 * 60e3), status: 'deleted' });
  const old = await user({ email: 'o@example.com', created_at: ago(60 * D) }); // зарегистрирован до старта цепочки
  for (const id of [a, b, blocked, del]) await addTrial(id, 29 * D);
  await addTrial(old, 4 * D);

  let s = sender();
  await runChain(ctx.db, { ...base, mode: 'on', sender: s.fn });
  assert.deepEqual(s.calls.map((c) => c[1]).sort(), ['trial5', 'welcome', 'welcome'], 'старому — только про срок, заблокированному и удалённому — ничего');

  await reset();
  const a2 = await user({ email: 'a@example.com', created_at: ago(20 * 60e3) });
  const b2 = await user({ email: 'b@example.com', created_at: ago(15 * 60e3) });
  await addTrial(a2, 29 * D); await addTrial(b2, 29 * D);
  s = sender();
  await runChain(ctx.db, { ...base, mode: 'on', sender: s.fn, only: new Set(['b@example.com']) });
  assert.deepEqual(s.calls, [[b2, 'welcome']], 'только разрешённый адрес');
  s = sender();
  const r = await runChain(ctx.db, { ...base, mode: 'on', sender: s.fn, limit: 1 });
  assert.equal(r.planned.length, 1, 'лимит за один проход');
});

test('runChain: без LETTERS_CHAIN_START все аккаунты «старые»; без платёжных ссылок письма с оплатой не уходят', async () => {
  await reset();
  const fresh = await user({ created_at: ago(20 * 60e3) });
  const old = await user({ created_at: ago(60 * D) });
  await addTrial(fresh, 29 * D); await addTrial(old, 4 * D);
  let s = sender();
  await runChain(ctx.db, { ...base, chainStart: null, mode: 'on', sender: s.fn });
  assert.deepEqual(s.calls, [[old, 'trial5']]);
  s = sender();
  await runChain(ctx.db, { ...base, chainStart: null, payReady: false, mode: 'on', sender: s.fn });
  assert.deepEqual(s.calls, []);
});

test('runChain: письма про подписку уходят с ключом периода и не повторяются', async () => {
  await reset();
  const id = await user({ created_at: ago(60 * D) });
  const endsIn = 4 * D;
  await ctx.query("INSERT INTO public.subscriptions (user_id, status, starts_at, ends_at, payment_id, period_months) VALUES ($1,'active',$2,$3,'pay-1',1)", [id, ago(26 * D), inFuture(endsIn)]);
  const calls = [];
  const fn = async (db, uid, k, deps) => { calls.push([uid, k, deps?.logKey ?? null]); return { ok: true }; };
  const dry = await runChain(ctx.db, { ...base, mode: 'dry', sender: fn });
  assert.equal(dry.planned[0].key, 'sub5');
  assert.equal(calls.length, 0);
  await runChain(ctx.db, { ...base, mode: 'on', sender: fn });
  assert.deepEqual(calls, [[id, 'sub5', `sub5:${day(endsIn)}`]]);

  // настоящая отправка: запись в журнале с ключом периода, повторный проход ничего не шлёт
  const sent = [];
  const sendEmail = async (m) => { sent.push(m.subject); return { ok: true, uuid: 'u1' }; };
  const { sendLetter } = await import('../src/emails/send.js');
  const real = (db, uid, k, deps) => sendLetter(db, uid, k, { ...deps, sendEmail });
  await runChain(ctx.db, { ...base, mode: 'on', sender: real });
  await runChain(ctx.db, { ...base, mode: 'on', sender: real });
  assert.equal(sent.length, 1);
  const log = await ctx.query('SELECT letter, status FROM public.email_log WHERE user_id=$1', [id]);
  assert.deepEqual(log.rows, [{ letter: `sub5:${day(endsIn)}`, status: 'sent' }]);
});

test('runChain: запись (транзакция) останавливает цепочку активации', async () => {
  await reset();
  const lazy = await user({ created_at: ago(3 * D) });
  const active = await user({ created_at: ago(3 * D) });
  await addTrial(lazy, 27 * D); await addTrial(active, 27 * D);
  await ctx.query("INSERT INTO public.email_log (user_id, letter, status, sent_at) SELECT id, 'welcome', 'sent', now() - interval '3 days' FROM public.users");
  const g = (await ctx.query("INSERT INTO public.category_groups (name, type) VALUES ('g','expense') RETURNING id")).rows[0].id;
  const c = (await ctx.query("INSERT INTO public.categories (group_id, name, type) VALUES ($1,'c','expense') RETURNING id", [g])).rows[0].id;
  await ctx.query("INSERT INTO public.transactions (user_id, category_id, type, amount, transaction_date) VALUES ($1,$2,'expense',100,'2026-10-19')", [active, c]);
  const s = sender();
  await runChain(ctx.db, { ...base, mode: 'on', sender: s.fn });
  assert.deepEqual(s.calls, [[lazy, 'activation']]);
});

test('runChain + sendLetter: настоящая отправка пишет в журнал и не шлёт дважды', async () => {
  await reset();
  const id = await user({ created_at: ago(10 * 60e3), email: 'real@example.com' });
  await addTrial(id, 29 * D);
  const { sendLetter } = await import('../src/emails/send.js');
  const mails = [];
  const sendWith = (db, uid, k) => sendLetter(db, uid, k, { sendEmail: async (m) => { mails.push(m); return { ok: true, uuid: 'u-1' }; } });
  await runChain(ctx.db, { ...base, mode: 'on', sender: sendWith });
  await runChain(ctx.db, { ...base, mode: 'on', sender: sendWith });
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'real@example.com');
  assert.equal((await ctx.query("SELECT count(*)::int AS c FROM public.email_log WHERE status='sent'")).rows[0].c, 1);
});

test('сбой отправки повторяется через час и увеличивает счётчик попыток', async () => {
  await reset();
  const t0 = new Date(); // здесь время настоящее: в журнале попытка записывается текущим временем
  const id = await user({ created_at: ago(10 * 60e3, t0) });
  await addTrial(id, 29 * D);
  const { sendLetter } = await import('../src/emails/send.js');
  let fail = true;
  const sendWith = (db, uid, k) => sendLetter(db, uid, k, { sendEmail: async () => (fail ? { ok: false, status: 500 } : { ok: true, uuid: 'u-2' }) });
  let r = await runChain(ctx.db, { ...base, now: t0, mode: 'on', sender: sendWith });
  assert.equal(r.failed, 1);
  r = await runChain(ctx.db, { ...base, now: new Date(), mode: 'on', sender: sendWith });
  assert.equal(r.planned.length, 0, 'сразу же не повторяем');
  fail = false;
  const later = new Date(t0.getTime() + 2 * H);
  r = await runChain(ctx.db, { ...base, now: later, mode: 'on', sender: sendWith });
  assert.equal(r.sent, 1);
  const row = (await ctx.query("SELECT status, attempts FROM public.email_log WHERE user_id=$1", [id])).rows[0];
  assert.deepEqual(row, { status: 'sent', attempts: 2 });
});

test('техническое приветствие не отправляется, когда приветствие идёт из цепочки', async () => {
  const keep = { m: process.env.LETTERS_MODE, s: process.env.LETTERS_CHAIN_START };
  process.env.LETTERS_MODE = 'on';
  process.env.LETTERS_CHAIN_START = '2026-10-14T00:00:00+03:00';
  try {
    assert.deepEqual(await sendWelcomeEmail({ to: 'a@example.com', userId: 'x' }), { ok: false, skipped: true });
  } finally {
    for (const [k, v] of [['LETTERS_MODE', keep.m], ['LETTERS_CHAIN_START', keep.s]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// ── Вебхук RuSender ─────────────────────────────────────────────────────────

test('названия событий разбираются на русском и английском', () => {
  const cases = {
    delivered: 'delivered', 'Доставлено': 'delivered', open: 'opened', 'Открытие': 'opened', click: 'clicked', 'Переход': 'clicked',
    unsubscribe: 'unsubscribed', 'Отписка': 'unsubscribed', spam_complaint: 'complaint', 'Жалоба': 'complaint',
    permanent_failure: 'hard_bounce', 'Не существует': 'hard_bounce', temporary_failure: 'soft_bounce', 'Переполнен': 'soft_bounce',
    'Недоступен': 'soft_bounce', not_delivered: 'error', hmm: 'unknown',
  };
  for (const [name, want] of Object.entries(cases)) assert.equal(classify(name), want, name);
  assert.equal(classify(undefined), 'unknown');
});

test('событие: тип, номер письма и адрес берутся из разных вариантов полей, в том числе вложенных', () => {
  assert.deepEqual(normalizeEvent({ event: 'delivered', uuid: 'abc', email: 'x@y.ru' }), { event: 'delivered', name: 'delivered', providerUuid: 'abc', email: 'x@y.ru' });
  const nested = normalizeEvent({ type: 'permanent_failure', data: { mail_uuid: 'm1', to: { email: 'q@w.ru' } } });
  assert.equal(nested.event, 'hard_bounce'); assert.equal(nested.providerUuid, 'm1'); assert.equal(nested.email, 'q@w.ru');
  assert.equal(extractEvents([{ a: 1 }, { b: 2 }]).length, 2);
  assert.equal(extractEvents({ events: [{ a: 1 }] }).length, 1);
  assert.equal(extractEvents({ a: 1 }).length, 1);
});

test('настоящие события RuSender (формат external_mail.*) разбираются', () => {
  const mk = (trigger) => ({ eventId: 'e', trigger, occurredAt: '2026-10-13T16:01:09.949Z', payload: { email: 'a@b.ru', taskId: 'task-1' } });
  assert.deepEqual(normalizeEvent(mk('external_mail.delivered')), { event: 'delivered', name: 'external_mail.delivered', providerUuid: 'task-1', email: 'a@b.ru' });
  assert.equal(normalizeEvent(mk('external_mail.open')).event, 'opened');
  assert.equal(normalizeEvent({ ...mk('external_mail.click'), payload: { email: 'a@b.ru', taskId: 't', linkUrl: 'https://x.ru' } }).event, 'clicked');
  assert.equal(normalizeEvent(mk('rusender.webhook_test')).event, 'unknown');
  assert.equal(normalizeEvent(mk('external_mail.spam_complaint')).event, 'complaint');
  assert.equal(normalizeEvent(mk('external_mail.unsubscribe')).event, 'unsubscribed');
  assert.equal(normalizeEvent(mk('external_mail.nonexistent')).event, 'hard_bounce');
});

test('событие находит письмо и пользователя по taskId, а если письма нет в журнале — по адресу', async () => {
  await reset();
  const id = await user({ email: 'known@example.com' });
  await ctx.query("INSERT INTO public.email_log (user_id, letter, status, provider_uuid) VALUES ($1,'trial5','sent','task-77')", [id]);
  const { handleEvents } = await import('../src/emails/events.js');
  await handleEvents(ctx.db, { trigger: 'external_mail.delivered', payload: { email: 'other@x.ru', taskId: 'task-77' } });
  await handleEvents(ctx.db, { trigger: 'external_mail.open', payload: { email: 'Known@Example.com', taskId: 'no-such-task' } });
  const rows = (await ctx.query('SELECT event, user_id, letter FROM public.email_events ORDER BY event')).rows;
  assert.deepEqual(rows, [{ event: 'delivered', user_id: id, letter: 'trial5' }, { event: 'opened', user_id: id, letter: null }]);
});

async function startHook() {
  const app = express();
  app.use(express.json());
  app.use(createRusenderRouter({ db: ctx.db }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}/webhook/rusender`;
  return { url, close: () => new Promise((r) => server.close(r)) };
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('вебхук: чужой секрет → 404 и ничего не сохраняется; без настроенного секрета закрыт совсем', async () => {
  await reset();
  const srv = await startHook();
  try {
    process.env.RUSENDER_WEBHOOK_SECRET = 'a'.repeat(32);
    assert.equal((await post(`${srv.url}/wrong`, { event: 'delivered' })).status, 404);
    assert.equal((await post(`${srv.url}/${'a'.repeat(32)}`, { event: 'delivered' })).status, 200);
    delete process.env.RUSENDER_WEBHOOK_SECRET;
    assert.equal((await post(`${srv.url}/undefined`, { event: 'delivered' })).status, 404);
    assert.equal((await ctx.query('SELECT count(*)::int AS c FROM public.email_events')).rows[0].c, 1);
  } finally { delete process.env.RUSENDER_WEBHOOK_SECRET; await srv.close(); }
});

test('вебхук: события сохраняются целиком; отказ и жалоба блокируют адрес; отписка выключает рассылку', async () => {
  await reset();
  const bounce = await user({ email: 'bounce@example.com' });
  const spam = await user({ email: 'spam@example.com' });
  const unsub = await user({ email: 'unsub@example.com' });
  const soft = await user({ email: 'soft@example.com' });
  await ctx.query("INSERT INTO public.email_log (user_id, letter, status, provider_uuid) VALUES ($1,'welcome','sent','prov-bounce')", [bounce]);
  const secret = 'b'.repeat(32);
  process.env.RUSENDER_WEBHOOK_SECRET = secret;
  const srv = await startHook();
  try {
    const url = `${srv.url}/${secret}`;
    const r1 = await (await post(url, { event: 'permanent_failure', uuid: 'prov-bounce', email: 'whatever@x.ru' })).json();
    assert.equal(r1.acted, 1);
    await post(url, [{ event: 'spam_complaint', email: 'SPAM@example.com' }, { event: 'unsubscribe', email: 'unsub@example.com' }, { event: 'temporary_failure', email: 'soft@example.com' }, { event: 'open', email: 'soft@example.com' }, { weird: true }]);
    const flags = async (id) => (await ctx.query('SELECT email_blocked_at AS b, email_block_reason AS r, email_letters_accepted AS a, email_unsubscribed_at AS u FROM public.users WHERE id=$1', [id])).rows[0];
    assert.equal((await flags(bounce)).r, 'hard_bounce');
    assert.equal((await flags(spam)).r, 'spam_complaint');
    const u = await flags(unsub);
    assert.equal(u.a, false); assert.ok(u.u); assert.equal(u.b, null, 'отписка — не блокировка');
    const s = await flags(soft);
    assert.equal(s.b, null, 'временная ошибка и открытие ничего не блокируют');
    const rows = (await ctx.query('SELECT event, user_id, letter, raw FROM public.email_events ORDER BY received_at, event')).rows;
    assert.equal(rows.length, 6);
    assert.ok(rows.find((x) => x.event === 'unknown' && x.raw.weird === true), 'непонятное событие сохранено как есть');
    assert.equal(rows.find((x) => x.event === 'hard_bounce').letter, 'welcome');
    // заблокированных цепочка больше не трогает
    await addTrial(bounce, 4 * D);
    const s2 = sender();
    const res = await runChain(ctx.db, { ...base, chainStart: null, mode: 'on', sender: s2.fn });
    assert.ok(!s2.calls.some((c) => c[0] === bounce));
    assert.ok(res);
  } finally { delete process.env.RUSENDER_WEBHOOK_SECRET; await srv.close(); }
});

test('вернувшему деньги (refunded) письмо «подписка закончилась» не уходит', () => {
  const f = (subs) => facts({ isNew: false, subs });
  assert.equal(key(f([{ status: 'refunded', ends_at: ago(H), payment_id: 'p-ref' }])), null);
  assert.equal(key(f([{ status: 'expired', ends_at: ago(2 * D), payment_id: null }, { status: 'refunded', ends_at: ago(H), payment_id: 'p-ref' }])), null, 'и «пробный закончился» тоже: он платил');
  assert.equal(key(f([{ status: 'refunded', ends_at: ago(H), payment_id: 'p-ref' }, { status: 'expired', ends_at: ago(D), payment_id: 'p-old' }])), 'subover', 'но более ранний оплаченный и закончившийся период остаётся поводом для письма');
});
