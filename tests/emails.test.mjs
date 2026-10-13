import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { makeDb } from './helpers/testDb.mjs';
import { LETTERS, LETTER_KEYS, renderLetter } from '../src/emails/letters.js';
import { unsubToken, verifyUnsubToken, unsubscribeUrl, createEmailRouter } from '../src/emails/unsubscribe.js';
import { sendLetter } from '../src/emails/send.js';
import { PRICES } from '../src/utils/plans.js';

process.env.JWT_SECRET = 'test-secret';
let ctx;
before(async () => { ctx = await makeDb(); });
after(async () => { await ctx?.close(); });

let n = 0;
async function newUser(over = {}) {
  n += 1;
  const u = { external_id: `e${n}`, channel: 'web', email: `u${n}@example.com`, email_letters_accepted: false, status: 'active', ...over };
  const r = await ctx.query(
    'INSERT INTO public.users (external_id, channel, email, email_letters_accepted, status) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [u.external_id, u.channel, u.email, u.email_letters_accepted, u.status]
  );
  return r.rows[0].id;
}
const hrefs = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

test('все 12 писем собираются: тема, баннер 600×350, текстовая версия, размер до 100 КБ', () => {
  assert.equal(LETTER_KEYS.length, 12);
  for (const key of LETTER_KEYS) {
    const { subject, html, text } = renderLetter(key, { userId: '00000000-0000-4000-8000-000000000001' });
    assert.ok(subject.length > 5 && subject.length < 80, key);
    assert.match(html, /<img src="https:\/\/finnikbot\.ru\/email\/banners\/[a-z0-9-]+\.png" width="600" height="350" alt="[^"]+"/, key);
    assert.ok(Buffer.byteLength(html) < 100 * 1024, `${key}: письмо больше 100 КБ — Gmail его обрежет`);
    assert.ok(text.length > 100, key);
    assert.doesNotMatch(html + text, /undefined|\[object|\{\{/, key);
    assert.match(html, /<title>/, key);
  }
});

test('ссылки в письмах — как заказал владелец', () => {
  const links = (k) => hrefs(renderLetter(k, { userId: '00000000-0000-4000-8000-000000000001' }).html);
  assert.ok(links('welcome').includes('https://finnikbot.ru/cabinet/bot'));
  assert.ok(links('activation').includes('https://finnikbot.ru/cabinet/bot'));
  assert.ok(links('help').includes('mailto:hello@finnikbot.ru'));
  for (const p of ['budget', 'goals', 'categories']) assert.ok(links('features').includes(`https://finnikbot.ru/cabinet/${p}`), p);
  for (const k of LETTER_KEYS) assert.ok(links(k).includes('https://finnikbot.ru/cabinet/how-to'), `${k}: нет ссылки «по этой инструкции»`);
  assert.ok(links('welcome').includes('https://finnikbot.ru/cabinet/profile'));
  assert.ok(links('sub_started').includes('https://finnikbot.ru/cabinet/profile'));
});

test('кнопки оплаты пока без ссылки: нарисованы, но не кликабельны', () => {
  for (const k of ['trial5', 'trial1', 'trialover', 'sub5', 'sub1', 'subover']) {
    const { html, text } = renderLetter(k, { userId: '00000000-0000-4000-8000-000000000001' });
    for (const label of ['Оплатить 1 мес', 'Оплатить 6 мес', 'Оплатить 12 мес']) {
      assert.ok(html.includes(label), `${k}: нет «${label}»`);
      assert.doesNotMatch(html, new RegExp(`<a [^>]*>${label}</a>`), `${k}: «${label}» не должна быть ссылкой`);
    }
    assert.doesNotMatch(text, /Оплатить/, k);
  }
});

test('цены в письмах — те же, что на сайте и в боте', () => {
  const { html } = renderLetter('trial5', { userId: '00000000-0000-4000-8000-000000000001' });
  const flat = html.replace(/ /g, ' ');
  assert.ok(flat.includes(`1 месяц — ${PRICES[1]} ₽`));
  assert.ok(flat.includes('2 394 ₽') && flat.includes('1 995 ₽'));
  assert.ok(flat.includes('4 788 ₽') && flat.includes('3 990 ₽'));
});

test('ссылка на отписку: в подвале всех писем, кроме «Подписка активирована»', () => {
  const uid = '00000000-0000-4000-8000-000000000001';
  for (const k of LETTER_KEYS) {
    const { html, text } = renderLetter(k, { userId: uid });
    const has = html.includes('/unsubscribe?u=');
    assert.equal(has, k !== 'sub_started', k);
    assert.equal(text.includes('/unsubscribe?u='), k !== 'sub_started', k);
    assert.ok(html.includes('ОГРНИП 326508100607489'), k);
  }
});

test('подпись отписки: верная проходит, подделанная и чужая — нет', () => {
  const a = '00000000-0000-4000-8000-000000000001';
  const b = '00000000-0000-4000-8000-000000000002';
  const t = unsubToken(a);
  assert.ok(verifyUnsubToken(a, t));
  assert.ok(!verifyUnsubToken(b, t));
  assert.ok(!verifyUnsubToken(a, t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A')));
  assert.ok(!verifyUnsubToken(a, ''));
  assert.match(unsubscribeUrl(a), /^https:\/\/finnikbot\.ru\/unsubscribe\?u=00000000-0000-4000-8000-000000000001&t=[\w-]{32}$/);
});

async function startRouter() {
  const app = express();
  app.use(createEmailRouter({ db: ctx.db }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}
const flagOf = async (id) => (await ctx.query('SELECT email_letters_accepted AS a, email_unsubscribed_at AS at FROM public.users WHERE id=$1', [id])).rows[0];

test('отписка: открытие ссылки ничего не меняет, кнопка отписывает, «вернуть» включает снова', async () => {
  const id = await newUser({ email_letters_accepted: true });
  const t = unsubToken(id);
  const srv = await startRouter();
  try {
    const page = await fetch(`${srv.base}/unsubscribe?u=${id}&t=${t}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Да, отписаться/);
    assert.equal((await flagOf(id)).a, true, 'просмотр страницы не должен отписывать');

    const post = await fetch(`${srv.base}/unsubscribe`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `u=${id}&t=${t}` });
    assert.equal(post.status, 200);
    assert.match(await post.text(), /ты отписался/);
    const f = await flagOf(id);
    assert.equal(f.a, false);
    assert.ok(f.at);

    const re = await fetch(`${srv.base}/unsubscribe`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `u=${id}&t=${t}&action=resubscribe` });
    assert.equal(re.status, 200);
    const f2 = await flagOf(id);
    assert.equal(f2.a, true);
    assert.equal(f2.at, null);
  } finally { await srv.close(); }
});

test('отписка «в один клик» из почтового клиента: данные в адресе, в теле List-Unsubscribe=One-Click', async () => {
  const id = await newUser({ email_letters_accepted: true });
  const srv = await startRouter();
  try {
    const r = await fetch(`${srv.base}/unsubscribe?u=${id}&t=${unsubToken(id)}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    assert.equal(r.status, 200);
    assert.equal((await flagOf(id)).a, false);
  } finally { await srv.close(); }
});

test('отписка: неверная подпись и мусор в адресе — отказ, ничего не меняется', async () => {
  const id = await newUser({ email_letters_accepted: true });
  const srv = await startRouter();
  try {
    for (const q of [`u=${id}&t=bad`, `u=not-a-uuid&t=${unsubToken(id)}`, '']) {
      const g = await fetch(`${srv.base}/unsubscribe?${q}`);
      assert.equal(g.status, 400, q);
      const p = await fetch(`${srv.base}/unsubscribe?${q}`, { method: 'POST' });
      assert.equal(p.status, 400, q);
    }
    assert.equal((await flagOf(id)).a, true);
  } finally { await srv.close(); }
});

// «Почтальон» для тестов: запоминает письма
function mailer(result = { ok: true, uuid: 'prov-1' }) {
  const sent = [];
  return { sent, sendEmail: async (m) => { sent.push(m); return typeof result === 'function' ? result(m) : result; } };
}

test('сервисное письмо уходит и тем, кто не отмечал согласие; повторно не отправляется', async () => {
  const id = await newUser({ email_letters_accepted: false });
  const m = mailer();
  const r1 = await sendLetter(ctx.db, id, 'welcome', m);
  assert.deepEqual(r1, { ok: true });
  assert.equal(m.sent.length, 1);
  assert.equal(m.sent[0].to.startsWith('u'), true);
  assert.match(m.sent[0].html, /\/unsubscribe\?u=/);
  const r2 = await sendLetter(ctx.db, id, 'welcome', m);
  assert.deepEqual(r2, { ok: false, reason: 'already' });
  assert.equal(m.sent.length, 1);
  const log = (await ctx.query("SELECT status, provider_uuid FROM public.email_log WHERE user_id=$1 AND letter='welcome'", [id])).rows;
  assert.deepEqual(log, [{ status: 'sent', provider_uuid: 'prov-1' }]);
});

test('рекламное письмо — только с согласием и без отписки', async () => {
  const m = mailer();
  const no = await newUser({ email_letters_accepted: false });
  assert.deepEqual(await sendLetter(ctx.db, no, 'activation', m), { ok: false, reason: 'not_opted_in' });
  const yes = await newUser({ email_letters_accepted: true });
  assert.deepEqual(await sendLetter(ctx.db, yes, 'activation', m), { ok: true });
  const unsub = await newUser({ email_letters_accepted: true });
  await ctx.query('UPDATE public.users SET email_unsubscribed_at = now() WHERE id=$1', [unsub]);
  assert.deepEqual(await sendLetter(ctx.db, unsub, 'features', m), { ok: false, reason: 'not_opted_in' });
  assert.equal(m.sent.length, 1);
});

test('не пишем: без почты, с недоступной почтой, удалённым и объединённым аккаунтам', async () => {
  const m = mailer();
  const noMail = await newUser({ email: '' });
  assert.equal((await sendLetter(ctx.db, noMail, 'welcome', m)).reason, 'no_email');
  const blocked = await newUser();
  await ctx.query("UPDATE public.users SET email_blocked_at = now(), email_block_reason='hard_bounce' WHERE id=$1", [blocked]);
  assert.equal((await sendLetter(ctx.db, blocked, 'trial5', m)).reason, 'blocked');
  for (const status of ['deleted', 'merged']) {
    const id = await newUser({ status });
    assert.equal((await sendLetter(ctx.db, id, 'welcome', m)).reason, 'inactive', status);
  }
  assert.equal((await sendLetter(ctx.db, '00000000-0000-4000-8000-0000000000ff', 'welcome', m)).reason, 'no_user');
  assert.equal((await sendLetter(ctx.db, noMail, 'nope', m)).reason, 'unknown_letter');
  assert.equal(m.sent.length, 0);
});

test('письмо с отзывами: выключатель в config.js (по умолчанию включено — владелец подтвердил, что отзывы настоящие)', async () => {
  const id = await newUser({ email_letters_accepted: true });
  const m = mailer();
  assert.equal((await sendLetter(ctx.db, id, 'help', { ...m, testimonialsConfirmed: false })).reason, 'testimonials_not_confirmed');
  assert.deepEqual(await sendLetter(ctx.db, id, 'help', m), { ok: true });
});

test('письмо №2.1 — повтор №2 с другими темой и прехедером; тема и прехедер каждого письма на месте', () => {
  const a = renderLetter('activation', { userId: '00000000-0000-4000-8000-000000000001' });
  const b = renderLetter('activation2', { userId: '00000000-0000-4000-8000-000000000001' });
  assert.notEqual(a.subject, b.subject);
  assert.equal(b.subject, 'Финансы начинаются с одной записи ✍️');
  assert.ok(b.html.includes('Начать проще, чем кажется'));
  assert.ok(a.html.includes('Одного сообщения достаточно, чтобы начать вести учет.'));
  assert.equal(LETTERS.activation2.kind, 'marketing');
  for (const k of LETTER_KEYS) assert.ok(LETTERS[k].preheader && LETTERS[k].preheader.length > 5, k);
  assert.equal(new Set(LETTER_KEYS.map((k) => LETTERS[k].subject)).size, LETTER_KEYS.length, 'темы писем не должны повторяться');
});

test('сбой отправки: письмо помечается failed и может быть отправлено повторно, дублей нет', async () => {
  const id = await newUser();
  const bad = mailer({ ok: false, status: 500, error: 'boom' });
  assert.deepEqual(await sendLetter(ctx.db, id, 'trial5', bad), { ok: false, reason: 'send_failed' });
  assert.equal((await ctx.query("SELECT status FROM public.email_log WHERE user_id=$1 AND letter='trial5'", [id])).rows[0].status, 'failed');
  const good = mailer();
  assert.deepEqual(await sendLetter(ctx.db, id, 'trial5', good), { ok: true });
  assert.equal((await ctx.query("SELECT count(*)::int AS c FROM public.email_log WHERE user_id=$1 AND letter='trial5'", [id])).rows[0].c, 1);
  assert.deepEqual(await sendLetter(ctx.db, id, 'trial5', good), { ok: false, reason: 'already' });
});

test('почта не настроена: письмо не считается отправленным, журнал чистый', async () => {
  const id = await newUser();
  const m = mailer({ ok: false, skipped: true });
  assert.deepEqual(await sendLetter(ctx.db, id, 'welcome', m), { ok: false, reason: 'not_configured' });
  assert.equal((await ctx.query('SELECT count(*)::int AS c FROM public.email_log WHERE user_id=$1', [id])).rows[0].c, 0);
});
