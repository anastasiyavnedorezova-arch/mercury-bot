// Патч 54 (27.10.2026): бюджет в боте считает все расходы, а в прогнозе крупные траты не растягиваются на месяц.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { makeDb } from './helpers/testDb.mjs';
import { LARGE_CATEGORIES, LARGE_NOTE, getMonthExpenses, splitExpenses, buildForecast, forecastText } from '../src/utils/budgetCalc.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const uid = () => crypto.randomUUID();
let ctx; let db;
before(async () => { ctx = await makeDb(); db = ctx.db; });
after(async () => { await ctx.close(); });

test('крупные траты — те же три категории, которые бот раньше пропускал', () => {
  assert.deepEqual(LARGE_CATEGORIES, ['Жильё', 'Кредиты и займы', 'Цель']);
  assert.match(LARGE_NOTE, /Из расчёта темпа я исключаю крупные траты типа: жильё, кредиты и займы, цель\./);
});

test('getMonthExpenses считает всё, включая жильё (60 165 ₽, как в кабинете)', async () => {
  const groupId = uid(); const userId = uid(); const other = uid();
  await db.from('category_groups').insert({ id: groupId, name: 'Тест', type: 'expense' });
  const cat = {};
  for (const [name, isSystem] of [['Жильё', true], ['Продукты', false], ['Кафе и рестораны', false]]) {
    cat[name] = uid();
    const { error } = await db.from('categories').insert({ id: cat[name], group_id: groupId, name, type: 'expense', is_system: isSystem });
    assert.ifError(error);
  }
  for (const u of [userId, other]) await db.from('users').insert({ id: u, external_id: String(Math.floor(Math.random() * 1e9)), channel: 'telegram' });
  const tx = (u, c, amount, date, type = 'expense') => ({ user_id: u, category_id: cat[c], type, amount, transaction_date: date });
  const { error } = await db.from('transactions').insert([
    tx(userId, 'Жильё', 20000, '2026-10-02'),
    tx(userId, 'Продукты', 30000, '2026-10-05'),
    tx(userId, 'Кафе и рестораны', 10165, '2026-10-10'),
    tx(userId, 'Продукты', 999, '2026-09-30'),
    tx(userId, 'Продукты', 777, '2026-11-01'),
    tx(other, 'Жильё', 5000, '2026-10-03'),
  ]);
  assert.ifError(error);
  const s = await getMonthExpenses(db, userId, '2026-10-01', '2026-11-01');
  assert.equal(s.total, 60165);
  assert.equal(s.large, 20000);
  assert.equal(s.regular, 40165);
  assert.equal(s.byCategory['Жильё'], 20000);
});

test('прогноз: оплаченное жильё входит как факт, но не умножается на остаток месяца', () => {
  const stats = splitExpenses([
    { amount: 20000, categories: { name: 'Жильё' } },
    { amount: 40165, categories: { name: 'Продукты' } },
  ]);
  const f = buildForecast(stats, 10, 30);
  assert.equal(f.total, 60165);
  assert.equal(f.large, 20000);
  assert.equal(f.avgDaily, 4016.5);
  assert.equal(Math.round(f.forecast), 60165 + 4016.5 * 20);
  // без крупных трат прогноз был бы заметно меньше, если бы мы растягивали жильё: проверяем, что этого нет
  assert.ok(f.forecast < (60165 / 10) * 30);
});

test('текст прогноза: строка про исключение крупных трат есть всегда, без «вы»', () => {
  const stats = splitExpenses([{ amount: 20000, categories: { name: 'Жильё' } }, { amount: 30000, categories: { name: 'Продукты' } }]);
  const f = buildForecast(stats, 15, 30);
  for (const budget of [undefined, 50000, 500000]) {
    const t = forecastText(f, budget);
    assert.ok(t.includes(LARGE_NOTE), String(budget));
    assert.match(t, /Из них крупные траты: 20\s000/);
    assert.ok(!/\bвы\b|ите\b|ете\b/i.test(t), t);
  }
  assert.match(forecastText(f, 50000), /перерасходуешь бюджет на/);
  assert.match(forecastText(f, 500000), /израсходуешь \d+% своего бюджета/);
  const plain = forecastText(buildForecast(splitExpenses([{ amount: 100, categories: { name: 'Продукты' } }]), 5, 30), 1000);
  assert.ok(!/Из них крупные/.test(plain));
});

test('код: бот, виджет и уведомления больше не отбрасывают категории по is_system', () => {
  for (const f of ['src/handlers/budget.js', 'src/handlers/analytics.js', 'src/notifications/index.js']) {
    const s = read(f);
    assert.ok(!/is_system/.test(s), `${f}: фильтр is_system не нужен`);
  }
  assert.ok(read('src/notifications/index.js').includes('LARGE_NOTE'), 'алерт прогноза объясняет, что исключено');
  assert.match(read('src/handlers/budget.js'), /В бюджет входят все расходы, включая жильё и кредиты\./);
});
