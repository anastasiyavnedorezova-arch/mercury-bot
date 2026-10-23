// Взносы на цели: каждый взнос привязан к своей цели, «накоплено» считается по ней (23.10.2026:
// «на цель 6000» прибавлялось сразу ко всем целям, а на странице /goals ничего не менялось).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { makeDb } from './helpers/testDb.mjs';
import {
  matchGoalByText, planGoalContributions, normalizeGoalItem, getContributions, goalSaved, goalProgress,
  getActiveGoals, attachGoalInfo, syncTxGoalLink,
} from '../src/utils/goalProgress.js';
import { buildConfirmationText, buildMultiConfirmationText, buildGoalPickKeyboard, goalProgressLine } from '../src/utils/botTexts.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const uid = () => crypto.randomUUID();

let ctx; let db; let CAT; // CAT: { goal, food }

before(async () => {
  ctx = await makeDb();
  db = ctx.db;
  const grp = async (name, type) => { const id = uid(); assert.ifError((await db.from('category_groups').insert({ id, name, type, sort_order: 1 })).error); return id; };
  const cat = async (name, type, group_id) => { const id = uid(); assert.ifError((await db.from('categories').insert({ id, name, type, group_id, user_id: null, is_system: true, is_active: true })).error); return id; };
  CAT = {
    goal: await cat('Цель', 'goal', await grp('Цель', 'goal')),
    food: await cat('Продукты', 'expense', await grp('Еда', 'expense')),
  };
});
after(async () => { await ctx?.close(); });

async function newUser() {
  const id = uid();
  assert.ifError((await db.from('users').insert({ id, external_id: id, channel: 'web', email: `${id}@t.ru` })).error);
  return id;
}
let seq = 0;
async function newGoal(user_id, name, extra = {}) {
  const id = uid();
  const { error } = await db.from('goals').insert({
    id, user_id, name, target_amount: 100000, future_value: 120000, initial_saved: 0, monthly_payment: 5000,
    target_date: '2027-12-01', status: 'active', created_at: new Date(Date.UTC(2026, 9, 1, 0, 0, seq++)).toISOString(), ...extra,
  });
  assert.ifError(error);
  return id;
}
async function addTx(user_id, extra = {}) {
  const id = uid();
  const { error } = await db.from('transactions').insert({ id, user_id, category_id: CAT.goal, type: 'goal', amount: 1000, transaction_date: '2026-10-23', ...extra });
  assert.ifError(error);
  return id;
}
const txRow = async (id) => (await db.from('transactions').select('*').eq('id', id).single()).data;

// ── Какая цель имелась в виду ────────────────────────────────────────────────

const GOALS = [{ id: 'a', name: 'Отпуск в Турции' }, { id: 'b', name: 'Новая машина' }];

test('matchGoalByText: название цели в сообщении (с падежами) определяет цель', () => {
  assert.equal(matchGoalByText(GOALS, 'на цель отпуск 6000')?.id, 'a');
  assert.equal(matchGoalByText(GOALS, 'на отпуск в турции 6000')?.id, 'a');
  assert.equal(matchGoalByText(GOALS, 'отложил на машину 6000')?.id, 'b');
  assert.equal(matchGoalByText(GOALS, 'на новую машину 10 000')?.id, 'b');
  assert.equal(matchGoalByText(GOALS, 'Новая машина')?.id, 'b');
});

test('matchGoalByText: неясно — не угадываем (null)', () => {
  assert.equal(matchGoalByText(GOALS, 'на цель 6000'), null);
  assert.equal(matchGoalByText(GOALS, 'отпуск или машина 6000'), null, 'названы обе цели');
  assert.equal(matchGoalByText(GOALS, ''), null);
  assert.equal(matchGoalByText(GOALS, undefined, null), null);
  assert.equal(matchGoalByText([{ id: 'x', name: 'Цель' }], 'на цель 500'), null, 'слово «цель» названием не считается');
});

test('matchGoalByText: учитывает и комментарий записи', () => {
  assert.equal(matchGoalByText(GOALS, 'на цель 6000', 'машина')?.id, 'b');
});

// ── Разбор записей из одного сообщения ───────────────────────────────────────

const goalItem = (extra = {}) => ({ type: 'goal', amount: 6000, category: 'Цель', comment: null, transaction_date: '2026-10-23', ...extra });
const foodItem = () => ({ type: 'expense', amount: 300, category: 'Продукты', comment: null, transaction_date: '2026-10-23' });

test('planGoalContributions: целей нет — взнос некуда записать, обычные траты сохраняются', () => {
  const r = planGoalContributions([], [goalItem(), foodItem()], 'на цель 6000, продукты 300');
  assert.equal(r.dropped, 1);
  assert.equal(r.pending.length, 0);
  assert.equal(r.toSave.length, 1);
  assert.equal(r.toSave[0].item.category, 'Продукты');
  assert.equal(r.toSave[0].goalId, null);
});

test('planGoalContributions: одна цель — взнос идёт в неё сам', () => {
  const r = planGoalContributions([GOALS[0]], [goalItem()], 'на цель 6000');
  assert.deepEqual(r.toSave.map((e) => e.goalId), ['a']);
  assert.equal(r.pending.length + r.dropped, 0);
});

test('planGoalContributions: две цели без названия — спрашиваем, а не пишем в обе', () => {
  const r = planGoalContributions(GOALS, [goalItem()], 'на цель 6000');
  assert.equal(r.toSave.length, 0);
  assert.equal(r.pending.length, 1);
});

test('planGoalContributions: две цели, название названо — берём её; обычные траты идут без цели', () => {
  const r = planGoalContributions(GOALS, [goalItem(), foodItem()], 'на машину 6000, продукты 300');
  assert.deepEqual(r.toSave.map((e) => e.goalId), ['b', null]);
  assert.equal(r.pending.length, 0);
});

test('normalizeGoalItem: category «Цель» с type=expense (и наоборот) приводятся к одному виду', () => {
  assert.deepEqual(
    [normalizeGoalItem({ type: 'expense', category: 'Цель' }).type, normalizeGoalItem({ type: 'goal', category: 'Остальное' }).category],
    ['goal', 'Цель'],
  );
  assert.equal(normalizeGoalItem({ type: 'expense', category: 'Продукты' }).type, 'expense');
});

// ── Подсчёт накопленного по базе ─────────────────────────────────────────────

test('две цели: взнос на одну не прибавляется к другой', async () => {
  const u = await newUser();
  const a = await newGoal(u, 'Отпуск', { initial_saved: 5000 });
  const b = await newGoal(u, 'Машина', { initial_saved: 1000 });
  await addTx(u, { amount: 6000, goal_id: a });
  await addTx(u, { amount: 2500, goal_id: a });
  await addTx(u, { amount: 700, goal_id: b });
  await addTx(u, { amount: 999 }); // старый взнос без цели не считается ни за одной
  const goals = await getActiveGoals(db, u);
  const c = await getContributions(db, u);
  const byId = Object.fromEntries(goals.map((g) => [g.id, g]));
  assert.equal(goalSaved(byId[a], c), 5000 + 6000 + 2500);
  assert.equal(goalSaved(byId[b], c), 1000 + 700);
  assert.deepEqual(goalProgress(byId[b], c), { saved: 1700, target: 120000, percent: 1, remaining: 118300 });
});

test('getContributions: чужие взносы не попадают', async () => {
  const u1 = await newUser(); const u2 = await newUser();
  const g1 = await newGoal(u1, 'Раз'); const g2 = await newGoal(u2, 'Два');
  await addTx(u1, { amount: 100, goal_id: g1 });
  await addTx(u2, { amount: 900, goal_id: g2 });
  assert.equal((await getContributions(db, u1)).get(g1), 100);
  assert.equal((await getContributions(db, u1)).get(g2), undefined);
});

test('после удаления цели её взносы остаются в истории, без привязки (без ошибки внешнего ключа)', async () => {
  const u = await newUser();
  const g = await newGoal(u, 'Временная');
  const tx = await addTx(u, { amount: 300, goal_id: g });
  const { error } = await db.from('goals').delete().eq('id', g);
  assert.ifError(error);
  const row = await txRow(tx);
  assert.equal(row.goal_id, null);
  assert.equal(Number(row.amount), 300);
});

// ── Миграция 010: старые взносы ──────────────────────────────────────────────

test('миграция 010: взносы переходят к единственной цели; при двух целях остаются без привязки', async () => {
  const solo = await newUser();
  const soloGoal = await newGoal(solo, 'Единственная');
  const t1 = await addTx(solo, { amount: 1000 });
  const t2 = await addTx(solo, { amount: 2000 });
  const meal = await addTx(solo, { amount: 50, category_id: CAT.food, type: 'expense' });

  const duo = await newUser();
  await newGoal(duo, 'Первая'); await newGoal(duo, 'Вторая');
  const t3 = await addTx(duo, { amount: 6000 });

  const archived = await newUser();
  await newGoal(archived, 'Старая', { status: 'archived' });
  const t4 = await addTx(archived, { amount: 10 });

  const sql = fs.readFileSync(new URL('../db/migrations/010_goal_contributions.sql', import.meta.url), 'utf8');
  // PGlite выполняет по одной команде за раз: режем файл по «;» в конце строки (комментарии убираем)
  const statements = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(/;\s*\n/).map((x) => x.trim()).filter(Boolean);
  assert.equal(statements.length, 4);
  for (let run = 0; run < 2; run++) { // повторный запуск безопасен
    for (const st of statements) await ctx.query(st);
  }

  assert.equal((await txRow(t1)).goal_id, soloGoal);
  assert.equal((await txRow(t2)).goal_id, soloGoal);
  assert.equal((await txRow(meal)).goal_id, null, 'обычные траты не трогаем');
  assert.equal((await txRow(t3)).goal_id, null, 'две цели — однозначно не определить');
  assert.equal((await txRow(t4)).goal_id, null, 'архивная цель не получает взносы');
});

// ── Правка записи ────────────────────────────────────────────────────────────

test('syncTxGoalLink: смена категории с «Цель» снимает привязку, на «Цель» — привязывает единственную цель', async () => {
  const u = await newUser();
  const g = await newGoal(u, 'Одна');
  const tx = await addTx(u, { goal_id: g });

  await db.from('transactions').update({ category_id: CAT.food }).eq('id', tx);
  assert.equal((await syncTxGoalLink(db, tx)).status, 'unlinked');
  let row = await txRow(tx);
  assert.equal(row.goal_id, null);
  assert.equal(row.type, 'expense');

  await db.from('transactions').update({ category_id: CAT.goal }).eq('id', tx);
  assert.equal((await syncTxGoalLink(db, tx)).status, 'linked');
  row = await txRow(tx);
  assert.equal(row.goal_id, g);
  assert.equal(row.type, 'goal');
});

test('syncTxGoalLink: при нескольких целях просит выбрать; без целей — сообщает', async () => {
  const u = await newUser();
  await newGoal(u, 'Первая'); await newGoal(u, 'Вторая');
  const tx = await addTx(u, { type: 'expense' });
  const r = await syncTxGoalLink(db, tx);
  assert.equal(r.status, 'needs_pick');
  assert.equal(r.goals.length, 2);
  assert.equal(r.userId, u);

  const lonely = await newUser();
  assert.equal((await syncTxGoalLink(db, await addTx(lonely))).status, 'no_goals');
});

// ── Тексты ───────────────────────────────────────────────────────────────────

test('подтверждение взноса называет цель и показывает «накоплено X из Y (N%)»', () => {
  const item = attachGoalInfo(goalItem(), { id: 'a', name: 'Отпуск', initial_saved: 5000, future_value: 120000 }, new Map([['a', 7000]]));
  const text = buildConfirmationText(item);
  assert.match(text, /6\s?000 ₽ — на цель «Отпуск»/);
  assert.match(text, /Накоплено 12\s?000 из 120\s?000 ₽ \(10%\)/);
  assert.match(goalProgressLine(item.goal), /^Накоплено 12\s?000 из 120\s?000 ₽ \(10%\)$/);
});

test('подтверждение нескольких записей: по строке прогресса на цель', () => {
  const a = attachGoalInfo(goalItem({ amount: 100 }), { id: 'a', name: 'Отпуск', initial_saved: 0, future_value: 1000 }, new Map([['a', 100]]));
  const text = buildMultiConfirmationText([a, foodItem()]);
  assert.match(text, /на цель «Отпуск»/);
  assert.match(text, /📊 «Отпуск»: 100 из 1\s?000 ₽ \(10%\)/);
});

test('без данных о цели текст прежний: «в копилку»', () => {
  assert.match(buildConfirmationText(goalItem()), /в копилку/);
});

test('кнопки выбора цели: по кнопке на цель + «Не записывать»; callback_data укладывается в 64 байта', () => {
  const kb = buildGoalPickKeyboard([{ id: uid(), name: 'Отпуск' }, { id: uid(), name: 'Машина' }]).reply_markup.inline_keyboard;
  assert.equal(kb.length, 3);
  assert.match(kb[0][0].callback_data, /^goal:contrib:[0-9a-f-]{36}$/);
  assert.equal(kb[2][0].callback_data, 'goal:contrib_cancel');
  for (const row of kb) assert.ok(Buffer.byteLength(row[0].callback_data) <= 64);
});

// ── Подключение в коде ───────────────────────────────────────────────────────

test('код: взнос сохраняется с goal_id, кнопки цели доходят до обработчика', () => {
  const msg = read('src/handlers/message.js');
  assert.ok(msg.includes("goal_id: parsed.type === 'goal' ? goalId : null"));
  assert.ok(msg.includes('planGoalContributions') && msg.includes('handleGoalPickText'));
  assert.ok(read('src/handlers/callbackDispatcher.js').includes("action.startsWith('goal:contrib')"));
  const d = read('src/handlers/callbackDispatcher.js');
  assert.ok(d.indexOf("goal:contrib") < d.indexOf("action.startsWith('goal:')"), 'выбор цели обрабатывается раньше общих кнопок цели');
});

test('код: бот, Дашборд, аналитика и /goals считают накопленное одним способом (по goal_id)', () => {
  const cab = read('src/cabinetRoutes.js');
  assert.ok(cab.includes('getContributions') && cab.includes('goalSaved'));
  assert.ok(!cab.includes('totalGoalTx'), 'Дашборд больше не прибавляет все взносы к каждой цели');
  assert.ok(cab.includes('saved: goalSaved(g, contributions)'), '/api/goals отдаёт saved');
  for (const f of ['src/handlers/goal.js', 'src/handlers/analytics.js']) {
    const s = read(f);
    assert.ok(s.includes('getContributions'), f);
    assert.ok(!s.includes(".eq('name', 'Цель')"), `${f}: больше не суммирует всю категорию «Цель»`);
  }
  assert.ok(read('public/cabinet/goals.html').includes('parseFloat(g.saved)'));
});

test('код: правка записи в боте синхронизирует привязку к цели', () => {
  const tx = read('src/handlers/transaction.js');
  assert.ok(tx.includes('syncTxGoalLink') && tx.includes('goal_id: null'));
});
