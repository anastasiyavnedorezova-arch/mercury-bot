// Патч 58 (+58b): цели на тарифе free. Рабочая цель одна, её выбирает человек, и выбор ОДНОРАЗОВЫЙ
// (иначе три цели можно вести бесплатно, переключаясь между ними). Пока выбора нет, все цели закрыты.
// Остальные цели можно смотреть и удалять; пополнение, правка и взносы текстом идут только в рабочую.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { makeDb } from './helpers/testDb.mjs';
import { splitGoals, getGoalsByAccess, getUsableGoals, setWorkingGoal, maxGoals } from '../src/utils/goalAccess.js';
import { addGoalContribution } from '../src/cabinet/goalContribution.js';
import { planGoalContributions, syncTxGoalLink } from '../src/utils/goalProgress.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const uid = () => crypto.randomUUID();

let ctx; let db; let CAT;
before(async () => {
  ctx = await makeDb();
  db = ctx.db;
  const gid = uid();
  assert.ifError((await db.from('category_groups').insert({ id: gid, name: 'Цель', type: 'goal', sort_order: 1 })).error);
  CAT = uid();
  assert.ifError((await db.from('categories').insert({ id: CAT, name: 'Цель', type: 'goal', group_id: gid, user_id: null, is_system: true, is_active: true })).error);
});
after(async () => { await ctx?.close(); });

async function newUser() {
  const id = uid();
  assert.ifError((await db.from('users').insert({ id, external_id: id, channel: 'web', email: `${id}@t.ru` })).error);
  return id;
}
let n = 0;
async function newGoal(user_id, name, extra = {}) {
  const id = uid();
  n += 1;
  assert.ifError((await db.from('goals').insert({
    id, user_id, name, target_amount: 90000, future_value: 100000, initial_saved: 0, monthly_payment: 5000,
    target_date: '2027-12-01', status: 'active', created_at: new Date(Date.UTC(2026, 0, n)).toISOString(), ...extra,
  })).error);
  return id;
}
const G = (id, created_at) => ({ id, created_at });

test('лимиты: free 1 цель, остальные до 3', () => {
  assert.equal(maxGoals('free'), 1);
  assert.equal(maxGoals('trial'), 3);
  assert.equal(maxGoals('active'), 3);
});

test('splitGoals: на платном тарифе все рабочие; на free одна цель рабочая сама, при нескольких надо выбрать', () => {
  const goals = [G('a', '2026-01-01'), G('b', '2026-02-01'), G('c', '2026-03-01')];
  for (const access of ['trial', 'active']) {
    const r = splitGoals(goals, access, null);
    assert.equal(r.usable.length, 3);
    assert.equal(r.locked.length, 0);
    assert.equal(r.needsChoice, false);
  }
  // одна цель — рабочая без выбора
  const one = splitGoals([G('a', '2026-01-01')], 'free', null);
  assert.deepEqual(one.usable.map((g) => g.id), ['a']);
  assert.equal(one.needsChoice, false);
  // несколько целей, выбора нет — закрыты все
  const none = splitGoals(goals, 'free', null);
  assert.equal(none.usable.length, 0);
  assert.equal(none.locked.length, 3);
  assert.equal(none.needsChoice, true);
  // выбор неактуален (цель удалена) — снова надо выбирать
  assert.equal(splitGoals(goals, 'free', 'удалённая').needsChoice, true);
  // выбор сделан
  const f = splitGoals(goals, 'free', 'c');
  assert.deepEqual(f.usable.map((g) => g.id), ['c']);
  assert.deepEqual(f.locked.map((g) => g.id).sort(), ['a', 'b']);
  assert.equal(f.needsChoice, false);
});

test('free: выбор рабочей цели ОДНОРАЗОВЫЙ, переключаться нельзя (лазейка 58b)', async () => {
  const u = await newUser(); const other = await newUser();
  const a = await newGoal(u, 'Отпуск'); const b = await newGoal(u, 'Машина'); const c = await newGoal(u, 'Квартира');
  const foreign = await newGoal(other, 'Чужая');

  // пока не выбрано: все закрыты
  assert.equal((await getUsableGoals(db, u, 'free')).length, 0);
  assert.equal((await getGoalsByAccess(db, u, 'free')).needsChoice, true);
  // чужую и несуществующую выбрать нельзя
  assert.equal((await setWorkingGoal(db, u, foreign, 'free')).ok, false);
  assert.equal((await setWorkingGoal(db, u, uid(), 'free')).status, 404);

  // первый выбор проходит
  assert.ok((await setWorkingGoal(db, u, b, 'free')).ok);
  assert.equal((await getUsableGoals(db, u, 'free')).map((g) => g.name).join(), 'Машина');
  assert.equal((await getGoalsByAccess(db, u, 'free')).needsChoice, false);

  // второй выбор другой цели отклоняется, рабочей остаётся «Машина»
  const again = await setWorkingGoal(db, u, a, 'free');
  assert.equal(again.ok, false);
  assert.equal(again.status, 409);
  assert.equal(again.reason, 'chosen');
  assert.equal((await setWorkingGoal(db, u, c, 'free')).reason, 'chosen');
  assert.equal((await getUsableGoals(db, u, 'free')).map((g) => g.name).join(), 'Машина');
  // повторный выбор той же цели безвреден
  assert.ok((await setWorkingGoal(db, u, b, 'free')).ok);

  // на платном тарифе выбирать не нужно: все рабочие, выбор не принимается
  assert.equal((await getUsableGoals(db, u, 'active')).length, 3);
  assert.equal((await setWorkingGoal(db, u, a, 'active')).reason, 'paid');

  // выбранную цель удалили: снова надо выбрать из оставшихся (двух)
  await db.from('goals').update({ status: 'archived' }).eq('id', b);
  const after = await getGoalsByAccess(db, u, 'free');
  assert.equal(after.needsChoice, true);
  assert.equal(after.usable.length, 0);
  assert.ok((await setWorkingGoal(db, u, c, 'free')).ok);
  assert.equal((await getUsableGoals(db, u, 'free')).map((g) => g.name).join(), 'Квартира');

  // осталась одна цель: она рабочая без выбора
  await db.from('goals').update({ status: 'archived' }).eq('id', c);
  assert.equal((await getUsableGoals(db, u, 'free')).map((g) => g.name).join(), 'Отпуск');
});

test('кабинет «Пополнить» на free: рабочая цель принимает взнос, закрытая отвечает 403 и ничего не пишет', async () => {
  const u = await newUser();
  const a = await newGoal(u, 'Отпуск'); const b = await newGoal(u, 'Машина');
  // рабочая ещё не выбрана: все цели закрыты, просим выбрать
  const early = await addGoalContribution(db, u, a, { amount: 1000 }, '2026-10-29', 'free');
  assert.equal(early.status, 403);
  assert.match(early.json.message, /выбери рабочую/i);

  await setWorkingGoal(db, u, a, 'free');
  const ok = await addGoalContribution(db, u, a, { amount: 1000 }, '2026-10-29', 'free');
  assert.equal(ok.status, 200);
  const no = await addGoalContribution(db, u, b, { amount: 1000 }, '2026-10-29', 'free');
  assert.equal(no.status, 403);
  assert.match(no.json.message, /подписк/i);
  const { data } = await db.from('transactions').select('goal_id').eq('user_id', u);
  assert.deepEqual(data.map((t) => t.goal_id), [a]);

  // переключиться на другую нельзя: «Машина» по-прежнему закрыта
  await setWorkingGoal(db, u, b, 'free');
  assert.equal((await addGoalContribution(db, u, b, { amount: 1 }, '2026-10-29', 'free')).status, 403);
  assert.equal((await addGoalContribution(db, u, a, { amount: 1 }, '2026-10-29', 'free')).status, 200);

  // пробный и платный: обе цели принимают взносы
  assert.equal((await addGoalContribution(db, u, a, { amount: 1 }, '2026-10-29', 'trial')).status, 200);
});

test('взнос текстом («на цель 5000») на free идёт в рабочую цель без вопроса, на платном при нескольких целях бот спрашивает', async () => {
  const u = await newUser();
  await newGoal(u, 'Отпуск'); const b = await newGoal(u, 'Машина');
  const item = () => ({ type: 'goal', amount: 5000, category: 'Цель', comment: '' });

  // рабочая не выбрана: взнос никуда не идёт (бот просит выбрать цель)
  const early = planGoalContributions(await getUsableGoals(db, u, 'free'), [item()], 'на цель 5000');
  assert.equal(early.toSave.length, 0);
  assert.equal(early.dropped, 1);

  await setWorkingGoal(db, u, b, 'free');
  const free = planGoalContributions(await getUsableGoals(db, u, 'free'), [item()], 'на цель 5000');
  assert.equal(free.pending.length, 0);
  assert.equal(free.toSave[0].goalId, b);

  const paid = planGoalContributions(await getUsableGoals(db, u, 'active'), [item()], 'на цель 5000');
  assert.equal(paid.pending.length, 1);
});

test('смена категории записи на «Цель» на free привязывает взнос к рабочей цели без вопроса', async () => {
  const u = await newUser();
  const a = await newGoal(u, 'Отпуск'); await newGoal(u, 'Машина');
  await setWorkingGoal(db, u, a, 'free');
  const tx = uid();
  assert.ifError((await db.from('transactions').insert({ id: tx, user_id: u, type: 'expense', amount: 700, category_id: CAT, transaction_date: '2026-10-29' })).error);
  const r = await syncTxGoalLink(db, tx, 'free');
  assert.equal(r.status, 'linked');
  const { data } = await db.from('transactions').select('goal_id').eq('id', tx).single();
  assert.equal(data.goal_id, a);

  const tx2 = uid();
  assert.ifError((await db.from('transactions').insert({ id: tx2, user_id: u, type: 'expense', amount: 700, category_id: CAT, transaction_date: '2026-10-29' })).error);
  assert.equal((await syncTxGoalLink(db, tx2, 'active')).status, 'needs_pick');
});

test('рабочая цель удалена из базы: выбор не ломает список, рабочей становится самая старая', async () => {
  const u = await newUser();
  const a = await newGoal(u, 'Отпуск'); const b = await newGoal(u, 'Машина');
  assert.ok((await setWorkingGoal(db, u, b, 'free')).ok);
  await db.from('goals').delete().eq('id', b);
  assert.deepEqual((await getUsableGoals(db, u, 'free')).map((g) => g.id), [a]);
});

test('бот: тексты и кнопки закрытых целей, защита правки и пополнения', () => {
  const goal = read('src/handlers/goal.js');
  assert.ok(goal.includes("callback_data: `goal:work:${id}`") && goal.includes("'⭐ Сделать рабочей'"));
  assert.ok(goal.includes("parts[1] === 'work'") && goal.includes("parts[1] === 'work_yes'") && goal.includes('goal:work_cancel'), 'выбор рабочей цели с подтверждением');
  assert.ok(goal.includes('GOAL_CHOSEN_MESSAGE'), 'повторный выбор отклоняется');
  assert.ok(goal.includes("(parts[1] || '').startsWith('edit_')") && goal.includes('GOAL_LOCKED_SHORT'), 'правка закрытой цели не открывается');
  // у закрытой цели нет «Пополнить» и «Изменить»
  const lockedBlock = goal.slice(goal.indexOf('if (locked) {'), goal.indexOf('const keyboard = ['));
  assert.ok(!lockedBlock.includes('goal:topup') && !lockedBlock.includes('goal:edit'));
  assert.ok(lockedBlock.includes('canChoose ?'), '«Сделать рабочей» только пока выбор не сделан');
  assert.ok(lockedBlock.includes('goal:delete') && lockedBlock.includes('goal:progress'));
  const msg = read('src/handlers/message.js');
  assert.ok(msg.includes('getGoalsByAccess(supabase, userId, access)') && msg.includes('GOAL_LOCKED_SHORT') && msg.includes('GOAL_CHOOSE_SHORT'));
  assert.ok(!/getActiveGoals\(supabase, state\.userId\)/.test(msg), 'взносы и ответы на «какая цель» идут только в рабочие цели');
});

test('кабинет: сервер отдаёт locked, страница использует его, localStorage больше не нужен', () => {
  const route = read('src/cabinetRoutes.js');
  assert.ok(route.includes("router.post('/api/goals/:id/work'") && route.includes('locked: lockedIds.has(g.id)'));
  assert.ok(!route.includes('Записывать взносы можно на пробном или платном тарифе'));
  const page = read('public/cabinet/goals.html');
  assert.ok(!page.includes('mercury_chosen_goal') && !page.includes('modalChooseGoal'));
  assert.ok(page.includes('window.makeWorkingGoal') && page.includes('🔒 Доступно в подписке') && page.includes('Сделать рабочей'));
  assert.ok(page.includes('goalsData.needs_choice') && page.includes('(needsChoice ?') && page.includes('window.confirm('), 'кнопка «Сделать рабочей» только пока выбор не сделан, с подтверждением');
  assert.ok(route.includes('needs_choice: split.needsChoice') && route.includes("res.status(409)"), 'сервер отдаёт needs_choice и отклоняет повторный выбор');
  // у закрытой карточки есть корзина (удаление) и нет «Пополнить» / «Редактировать»
  const card = page.slice(page.indexOf('function renderGoalCard'), page.indexOf('function renderBotCard'));
  assert.ok(card.includes('goal-trash-btn') && card.includes('locked'));
  assert.ok(!page.includes('.goal-card.locked { pointer-events'), 'закрытая карточка остаётся кликабельной');
});

test('миграция 013 добавляет users.working_goal_id', () => {
  const sql = read('db/migrations/013_working_goal.sql');
  assert.ok(/ADD COLUMN IF NOT EXISTS working_goal_id uuid;/.test(sql));
});
