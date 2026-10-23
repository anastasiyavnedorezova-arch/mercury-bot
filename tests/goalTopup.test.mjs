// Патч B по целям: «Пополнить» в карточке цели (бот и кабинет), название цели в истории взноса.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { makeDb } from './helpers/testDb.mjs';
import { addGoalContribution } from '../src/cabinet/goalContribution.js';
import { parseAmountStrict } from '../src/utils/parseAmount.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const uid = () => crypto.randomUUID();

let ctx; let db;
before(async () => {
  ctx = await makeDb();
  db = ctx.db;
  const gid = uid();
  assert.ifError((await db.from('category_groups').insert({ id: gid, name: 'Цель', type: 'goal', sort_order: 1 })).error);
  assert.ifError((await db.from('categories').insert({ id: uid(), name: 'Цель', type: 'goal', group_id: gid, user_id: null, is_system: true, is_active: true })).error);
});
after(async () => { await ctx?.close(); });

async function newUser() {
  const id = uid();
  assert.ifError((await db.from('users').insert({ id, external_id: id, channel: 'web', email: `${id}@t.ru` })).error);
  return id;
}
async function newGoal(user_id, extra = {}) {
  const id = uid();
  assert.ifError((await db.from('goals').insert({
    id, user_id, name: 'Отпуск', target_amount: 90000, future_value: 100000, initial_saved: 10000, monthly_payment: 5000,
    target_date: '2027-12-01', status: 'active', ...extra,
  })).error);
  return id;
}

test('кабинет «Пополнить»: взнос записывается на выбранную цель, в истории видно её название', async () => {
  const u = await newUser();
  const a = await newGoal(u, { name: 'Отпуск' });
  const b = await newGoal(u, { name: 'Машина', initial_saved: 0 });
  const r = await addGoalContribution(db, u, a, { amount: '5000.50' }, '2026-10-23');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, saved: 15000.5, target: 100000, percent: 15 });

  const { data } = await db.from('transactions').select('*, categories(name)').eq('user_id', u);
  assert.equal(data.length, 1);
  const t = data[0];
  assert.equal(t.type, 'goal');
  assert.equal(t.goal_id, a);
  assert.equal(t.comment, 'Отпуск');
  assert.equal(t.categories.name, 'Цель');
  assert.equal(t.transaction_date, '2026-10-23');
  assert.equal(Number(t.amount), 5000.5);

  // вторая цель не изменилась
  const r2 = await addGoalContribution(db, u, b, { amount: 100 }, '2026-10-23');
  assert.equal(r2.json.saved, 100);
});

test('кабинет «Пополнить»: плохие суммы и чужие/архивные цели отклоняются, ничего не пишется', async () => {
  const u = await newUser(); const other = await newUser();
  const g = await newGoal(u); const archived = await newGoal(u, { status: 'archived' }); const foreign = await newGoal(other);
  for (const amount of [0, -5, 'abc', null, undefined, 1e10, NaN]) {
    assert.equal((await addGoalContribution(db, u, g, { amount })).status, 400, String(amount));
  }
  assert.equal((await addGoalContribution(db, u, g, undefined)).status, 400);
  assert.equal((await addGoalContribution(db, u, archived, { amount: 10 })).status, 404);
  assert.equal((await addGoalContribution(db, u, foreign, { amount: 10 })).status, 404);
  assert.equal((await addGoalContribution(db, u, 'not-a-uuid', { amount: 10 })).status, 404);
  const { data } = await db.from('transactions').select('id').in('user_id', [u, other]);
  assert.equal(data.length, 0);
});

test('бот ждёт сумму после «Пополнить»: принимаются только суммы', () => {
  assert.equal(parseAmountStrict('5000'), 5000);
  assert.equal(parseAmountStrict('5 тыс'), 5000);
  assert.equal(parseAmountStrict('кофе 200'), null);
  assert.equal(parseAmountStrict('пять'), null);
});

test('код бота: кнопка «Пополнить» в карточке цели и в прогрессе, обработчик подключён раньше общих кнопок цели', () => {
  const goal = read('src/handlers/goal.js');
  assert.ok(goal.includes('`goal:topup:${id}`') && goal.includes('`goal:topup:${goal.id}`'));
  assert.ok(goal.includes('нажми «➕ Пополнить»'));
  const d = read('src/handlers/callbackDispatcher.js');
  assert.ok(d.includes("action.startsWith('goal:topup')"));
  assert.ok(d.indexOf("goal:topup") < d.indexOf("action.startsWith('goal:')"));
  const m = read('src/handlers/message.js');
  assert.ok(m.includes('handleGoalTopupText') && m.includes('goal:topup_cancel'));
  assert.ok(m.includes('item.comment = goal.name') && m.includes('?.name ?? item.comment'), 'название цели попадает в комментарий взноса');
  assert.ok(m.indexOf('handleGoalTopupText(bot, msg)') > 0);
});

test('код кабинета: кнопка, окно ввода суммы и маршрут с проверкой тарифа и лимитом', () => {
  const page = read('public/cabinet/goals.html');
  assert.ok(page.includes('window.openTopUpModal') && page.includes('id="modal-topup"') && page.includes("'/contribute'"));
  assert.ok(page.includes("(faded ? '' : '<button class=\"btn btn-primary btn-sm\" onclick=\"window.openTopUpModal"), 'у неактивных карточек кнопки нет');
  assert.ok(page.includes('class="goal-trash-btn"') && !/>Удалить<\/button>' \+\s*\n\s*'<button class="btn btn-mini-dark/.test(page), 'в карточке цели удаление — иконка-корзина, а не текст');
  const route = read('src/cabinetRoutes.js');
  assert.ok(route.includes("router.post('/api/goals/:id/contribute', requireAuth, limitGoalTopUp"));
  assert.ok(route.includes("=== 'free'") && route.includes('addGoalContribution'));
});
