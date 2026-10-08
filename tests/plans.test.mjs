import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PRICES, monthsForAmount, addMonths, computePeriod } from '../src/utils/plans.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

test('цены едины: 399 / 1995 / 3990', () => {
  assert.deepEqual(PRICES, { 1: 399, 6: 1995, 12: 3990 });
});

test('сумма платежа -> количество месяцев', () => {
  assert.equal(monthsForAmount(399), 1);
  assert.equal(monthsForAmount('399.00'), 1);
  assert.equal(monthsForAmount(1995), 6);
  assert.equal(monthsForAmount(3990), 12);
  assert.equal(monthsForAmount(5000), 12);
  assert.equal(monthsForAmount(398), 0);
  assert.equal(monthsForAmount(0), 0);
  assert.equal(monthsForAmount('abc'), 0);
});

test('addMonths не перескакивает через конец месяца', () => {
  assert.equal(addMonths(new Date(2027, 0, 31), 1).getMonth(), 1);
  assert.equal(addMonths(new Date(2027, 0, 31), 1).getDate(), 28);
  assert.equal(addMonths(new Date(2027, 0, 15), 6).getMonth(), 6);
  assert.equal(addMonths(new Date(2026, 10, 30), 3).getFullYear(), 2027);
});

test('новый период идёт после действующего доступа', () => {
  const now = new Date(2026, 9, 8);
  const future = new Date(2026, 10, 8);
  const p = computePeriod(future, 1, now);
  assert.equal(p.startsAt.getTime(), future.getTime());
  assert.equal(p.endsAt.getMonth(), 11);
  const q = computePeriod(new Date(2026, 8, 1), 1, now);
  assert.equal(q.startsAt.getTime(), now.getTime());
  assert.equal(computePeriod(null, 12, now).endsAt.getFullYear(), 2027);
});

test('цены в тексте бота, кабинета и лендинга совпадают с PRICES', () => {
  const bot = read('src/handlers/subscription.js');
  const profile = read('public/cabinet/profile.html');
  const index = read('public/index.html');
  for (const n of [1, 6, 12]) {
    assert.ok(bot.includes(`${fmt(PRICES[n])} ₽`), `бот: ${PRICES[n]}`);
  }
  for (const n of [1, 6, 12]) {
    assert.ok(profile.includes(`${fmt(PRICES[n])} руб.`), `кабинет: ${PRICES[n]}`);
    assert.ok(index.includes(`${fmt(PRICES[n])} руб.`), `лендинг: ${PRICES[n]}`);
  }
  for (const old of ['499', '2 490', '4 490', '2490', '4490']) {
    assert.ok(!bot.includes(old), `в боте осталась цена ${old}`);
    assert.ok(!profile.includes(`${old} руб`), `в кабинете осталась цена ${old}`);
    assert.ok(!index.includes(`${old} руб`), `на лендинге осталась цена ${old}`);
  }
  assert.ok(!read('src/webhook.js').match(/4490|2490/), 'в webhook остались старые пороги');
});

test('веб-чат: поиск пользователя по external_id не привязан к каналу telegram', () => {
  for (const f of ['budget', 'categories', 'fileUpload', 'goal', 'transaction', 'history', 'analytics', 'subscription']) {
    const src = read(`src/handlers/${f}.js`);
    const lookups = src.split('\n').filter((l, i, a) =>
      l.includes("'channel', 'telegram'") && a[i - 1] && a[i - 1].includes("'external_id'") && !a[i + 1]?.includes('.update'));
    const bad = lookups.filter(() => f !== 'subscription');
    assert.equal(bad.length, 0, `${f}.js: фильтр channel=telegram в поиске по external_id`);
  }
});

test('activateSubscription не использует upsert по user_id', () => {
  assert.ok(!read('src/handlers/subscription.js').includes('upsert'));
  assert.ok(read('src/handlers/subscription.js').includes('grantSubscription'));
  assert.ok(read('src/webhook.js').includes('grantSubscription'));
});
