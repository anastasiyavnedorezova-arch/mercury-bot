// Команда /stats: цифры воронки, источников, денег и ИИ; только владелец; возвраты, склейки и бесплатные выдачи не считаются.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeDb } from './helpers/testDb.mjs';
import { collectStats, formatStats, parseStatsCommand, sourceLabel } from '../src/utils/stats.js';

let ctx; let db; let cat;
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
before(async () => {
  ctx = await makeDb(); db = ctx.db;
  const g = (await ctx.query(`INSERT INTO public.category_groups (name, type) VALUES ('g','expense') RETURNING id`)).rows[0].id;
  cat = (await ctx.query(`INSERT INTO public.categories (group_id, name, type) VALUES ($1,'c','expense') RETURNING id`, [g])).rows[0].id;
});
after(async () => { await ctx?.close(); });

let n = 0;
async function user({ daysAgo = 1, utm = null, channel = 'telegram', mergedInto = null } = {}) {
  n += 1;
  const r = await ctx.query(
    `INSERT INTO public.users (external_id, channel, created_at, utm, merged_into) VALUES ($1,$2, now() - make_interval(days => $3::int), $4::jsonb, $5) RETURNING id`,
    [`ext${n}`, channel, daysAgo, utm ? JSON.stringify(utm) : null, mergedInto],
  );
  return r.rows[0].id;
}
const record = (id) => ctx.query(`INSERT INTO public.transactions (user_id, category_id, type, amount, transaction_date) VALUES ($1,$2,'expense',100,current_date)`, [id, cat]);
const sub = (id, o = {}) => ctx.query(
  `INSERT INTO public.subscriptions (user_id, status, period_months, starts_at, ends_at, payment_id, amount_rub, created_at)
   VALUES ($1,$2,$3, now() - interval '1 day', now() + make_interval(days => $4::int), $5, $6, now() - make_interval(days => $7::int))`,
  [id, o.status ?? 'active', o.months ?? 1, o.endsIn ?? 30, o.pay ?? null, o.rub ?? null, o.ago ?? 0],
);

test('подписи источников', () => {
  assert.equal(sourceLabel({ src: 'yandex', med: 'cpc', camp: 'brand' }), 'yandex / cpc / brand');
  assert.equal(sourceLabel({ src: 'tg' }), 'tg');
  assert.equal(sourceLabel({ ref: 'vk' }), 'сайт: vk');
  assert.equal(sourceLabel({}), 'без метки');
});

test('разбор команды: число дней, по умолчанию 30, лишнее не принимается', () => {
  assert.deepEqual(parseStatsCommand('/stats'), { days: 30 });
  assert.deepEqual(parseStatsCommand('/stats 7'), { days: 7 });
  assert.deepEqual(parseStatsCommand('/stats@FinnikMoneyBot 90'), { days: 90 });
  assert.deepEqual(parseStatsCommand('/stats 999'), { days: 365 });
  assert.deepEqual(parseStatsCommand('/stats 0'), { days: 30 });
  assert.equal(parseStatsCommand('/stats abc'), null);
  assert.equal(parseStatsCommand('/statsx'), null);
  assert.equal(parseStatsCommand('привет'), null);
});

test('воронка, источники и деньги считаются верно, лишнее не попадает', async () => {
  const ya = { utm_source: 'yandex', utm_medium: 'cpc', utm_campaign: 'brand' };
  const a = await user({ daysAgo: 2, utm: ya });          // запись + оплата 399
  const b = await user({ daysAgo: 3, utm: ya });          // только запись
  const c = await user({ daysAgo: 4, utm: ya });          // ничего
  const d = await user({ daysAgo: 5 });                   // без метки, запись
  const e = await user({ daysAgo: 6, utm: { ref: 'blog' } });
  const old = await user({ daysAgo: 60, utm: ya });       // вне окна 30 дней, но в «всего»
  await user({ daysAgo: 1, channel: 'merged', mergedInto: a }); // склеенный — не считается
  await record(a); await record(a); await record(b); await record(d);
  await sub(a, { pay: 'p1', rub: 399, ago: 1 });
  await sub(b, { status: 'trial', months: null, endsIn: 3 });   // триал без платежа
  await sub(e, { pay: 'p2', rub: 399, ago: 1, status: 'refunded' }); // возврат — не выручка
  await sub(d, { pay: null, rub: 0, ago: 1 });                  // бесплатная выдача
  await sub(old, { pay: 'p3', rub: 2000, ago: 45, months: 6 }); // старый платёж: только «за всё время»

  const s = await collectStats(db, { days: 30 });
  assert.equal(s.users.total, 6);
  assert.equal(s.users.dn, 5);
  assert.equal(s.now.trial_now, 1);
  assert.equal(s.now.paying_now, 2);
  assert.deepEqual([s.pay.n, s.pay.rub, s.pay.n_all, s.pay.rub_all], [1, 399, 2, 2399]);
  const y = s.cohort.find((r) => r.src === 'yandex');
  assert.deepEqual([y.regs, y.recs, y.paid, y.rub], [3, 2, 1, 399]);
  const none = s.cohort.find((r) => !r.src && !r.ref);
  assert.deepEqual([none.regs, none.recs, none.paid], [1, 1, 0]);
  assert.equal(s.cohort.reduce((x, r) => x + r.regs, 0), 5);

  const text = formatStats(s);
  assert.match(text, /Регистраций= 5/);
  assert.match(text, /За сутки= \d+, за 7 дн\.= \d+, за 30 дн\.= 5/);
  assert.match(text, /Всего зарегистрировано= 6/);
  assert.match(text, /Сделали первую запись= 3 \(60%\)/);
  assert.match(text, /Оплатили= 1 \(20%\)/);
  assert.match(text, /yandex \/ cpc \/ brand= 3 рег, 2 с записью, 1 оплатили, 399 ₽/);
  assert.match(text, /сайт: blog= 1 рег/);
  assert.match(text, /без метки= 1 рег/);
});

test('траты на ИИ: среднее на человека в активный день', async () => {
  await ctx.query(`DELETE FROM public.ai_usage`);
  await ctx.query(`INSERT INTO public.ai_usage (subject, day, requests) VALUES ('u1', (now() AT TIME ZONE 'Europe/Moscow')::date, 10), ('u2', (now() AT TIME ZONE 'Europe/Moscow')::date, 20), ('*', (now() AT TIME ZONE 'Europe/Moscow')::date, 30)`);
  const s = await collectStats(db, { days: 7 });
  assert.deepEqual([s.ai.weights, s.ai.person_days], [30, 2]);
  assert.match(formatStats(s), /в среднем 15,0 запросов на человека/);
});

test('пустая база: без ошибок и деления на ноль', async () => {
  const empty = await makeDb();
  try {
    const s = await collectStats(empty.db, { days: 30 });
    const text = formatStats(s);
    assert.match(text, /Регистраций= 0/);
    assert.match(text, /\(—\)/);
    assert.match(text, /пока никого/);
    assert.match(text, /данных пока нет/);
  } finally { await empty.close(); }
});

test('подключение: команда только для владельца и только читает', () => {
  const bot = read('src/bot.js');
  assert.match(bot, /bot\.onText\(\/\^\\\/stats/);
  const block = bot.slice(bot.indexOf('/stats или /stats 7'), bot.indexOf('/broadcast'));
  assert.match(block, /ADMIN_TELEGRAM_ID/);
  assert.match(block, /!process\.env\.ADMIN_TELEGRAM_ID \|\|/);
  const src = read('src/utils/stats.js');
  assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/);
});
