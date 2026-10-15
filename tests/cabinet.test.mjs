// Блокеры из тестирования 15.10.2026: правка транзакции, создание/правка категории, «сколько накоплено» в цели.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { makeDb } from './helpers/testDb.mjs';
import {
  createUserCategory, updateUserCategory, hintToSynonyms, synonymsToHint, mapCategoryRow,
} from '../src/cabinet/categories.js';
import { updateTransaction } from '../src/cabinet/historyEdit.js';
import { applyGoalSaved, isGoalStateExpired, GOAL_STATE_TTL_MS } from '../src/utils/goalEdit.js';
import { parseAmount, parseAmountStrict } from '../src/utils/parseAmount.js';

let ctx;
let db;
let G; // группы: { expOther, expFood, incWork }
let SYS; // системные категории: { food, other, salary }
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const uid = () => crypto.randomUUID();

before(async () => {
  ctx = await makeDb();
  db = ctx.db;
  const mk = async (name, type, sort_order) => {
    const id = uid();
    const { error } = await db.from('category_groups').insert({ id, name, type, sort_order });
    assert.ifError(error);
    return id;
  };
  G = {
    expFood: await mk('Еда', 'expense', 1),
    expOther: await mk('Другое', 'expense', 9),
    incWork: await mk('Доход за работу', 'income', 1),
  };
  const sys = async (name, type, group_id) => {
    const id = uid();
    const { error } = await db.from('categories').insert({ id, name, type, group_id, user_id: null, is_system: true, is_active: true });
    assert.ifError(error);
    return id;
  };
  SYS = {
    food: await sys('Продукты', 'expense', G.expFood),
    other: await sys('Остальное', 'expense', G.expOther),
    salary: await sys('Зарплата', 'income', G.incWork),
  };
});
after(async () => { await ctx?.close(); });

async function newUser() {
  const id = uid();
  const { error } = await db.from('users').insert({ id, external_id: id, channel: 'web', email: `${id}@t.ru` });
  assert.ifError(error);
  return id;
}
async function newTx(user_id, category_id, extra = {}) {
  const id = uid();
  const { error } = await db.from('transactions').insert({
    id, user_id, category_id, type: 'expense', amount: 4700, transaction_date: '2026-10-10', ...extra,
  });
  assert.ifError(error);
  return id;
}
const txRow = async (id) => (await db.from('transactions').select('*').eq('id', id).single()).data;
const catRow = async (id) => (await db.from('categories').select('*').eq('id', id).single()).data;

// ── Подсказка для бота ↔ synonyms ──────────────────────────────────────────

test('hintToSynonyms: разделители, пробелы, повторы', () => {
  assert.deepEqual(hintToSynonyms('дача, огород;  теплица\nДача'), ['дача', 'огород', 'теплица']);
  assert.deepEqual(hintToSynonyms(''), []);
  assert.deepEqual(hintToSynonyms(undefined), []);
  assert.equal(synonymsToHint(['дача', 'огород']), 'дача, огород');
  assert.equal(synonymsToHint(null), '');
});

// ── Создание категории ─────────────────────────────────────────────────────

test('создание категории без группы: берём «Другое» нужного типа, сохраняем иконку и подсказку', async () => {
  const u = await newUser();
  const r = await createUserCategory(db, u, { name: '  Дача ', type: 'expense', icon: '🏡', hint: 'огород, теплица' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const row = await catRow(r.json.data.id);
  assert.equal(row.name, 'Дача');
  assert.equal(row.group_id, G.expOther);
  assert.equal(row.icon, '🏡');
  assert.deepEqual(row.synonyms, ['огород', 'теплица']);
  assert.equal(row.user_id, u);
  assert.equal(row.is_system, false);
  assert.equal(row.is_active, true);
});

test('создание категории с выбранной группой; группа другого типа отклоняется', async () => {
  const u = await newUser();
  const ok = await createUserCategory(db, u, { name: 'Сладкое', type: 'expense', group_id: G.expFood });
  assert.equal(ok.status, 201);
  assert.equal((await catRow(ok.json.data.id)).group_id, G.expFood);
  assert.equal((await catRow(ok.json.data.id)).icon, null);

  const bad = await createUserCategory(db, u, { name: 'Премия', type: 'income', group_id: G.expFood });
  assert.equal(bad.status, 400);
  const nogroup = await createUserCategory(db, u, { name: 'Премия', type: 'income', group_id: uid() });
  assert.equal(nogroup.status, 400);
});

test('создание категории: пустое имя, длинное имя, плохой тип, длинная иконка, дубликаты', async () => {
  const u = await newUser();
  assert.equal((await createUserCategory(db, u, { name: '  ', type: 'expense' })).status, 400);
  assert.equal((await createUserCategory(db, u, { name: 'я'.repeat(41), type: 'expense' })).status, 400);
  assert.equal((await createUserCategory(db, u, { name: 'Х', type: 'goal' })).status, 400);
  assert.equal((await createUserCategory(db, u, { name: 'Х', type: 'expense', icon: '😀'.repeat(9) })).status, 400);

  assert.equal((await createUserCategory(db, u, { name: 'Хобби', type: 'expense' })).status, 201);
  assert.equal((await createUserCategory(db, u, { name: 'хобби', type: 'expense' })).status, 409);
  // название системной категории тоже занято
  assert.equal((await createUserCategory(db, u, { name: 'продукты', type: 'expense' })).status, 409);
  // у другого пользователя такое же название допустимо
  const u2 = await newUser();
  assert.equal((await createUserCategory(db, u2, { name: 'Хобби', type: 'expense' })).status, 201);
});

// ── Правка категории ───────────────────────────────────────────────────────

test('правка категории: имя, эмодзи и подсказка сохраняются (раньше эмодзи и подсказка пропадали)', async () => {
  const u = await newUser();
  const id = (await createUserCategory(db, u, { name: 'Сад', type: 'expense', icon: '🌱' })).json.data.id;
  const r = await updateUserCategory(db, u, id, { name: 'Сад и огород', type: 'expense', icon: '🥕', hint: 'грядки, семена' });
  assert.equal(r.status, 200);
  const row = await catRow(id);
  assert.equal(row.name, 'Сад и огород');
  assert.equal(row.icon, '🥕');
  assert.deepEqual(row.synonyms, ['грядки', 'семена']);

  // пустая иконка и пустая подсказка очищаются
  await updateUserCategory(db, u, id, { name: 'Сад и огород', icon: '', hint: '' });
  const row2 = await catRow(id);
  assert.equal(row2.icon, null);
  assert.deepEqual(row2.synonyms, []);
});

test('правка категории: чужую и системную менять нельзя, дубликат имени и смена типа', async () => {
  const u = await newUser();
  const other = await newUser();
  const mine = (await createUserCategory(db, u, { name: 'Книги', type: 'expense' })).json.data.id;
  const theirs = (await createUserCategory(db, other, { name: 'Чужая', type: 'expense' })).json.data.id;

  assert.equal((await updateUserCategory(db, u, theirs, { name: 'Взломал' })).status, 404);
  assert.equal((await catRow(theirs)).name, 'Чужая');
  assert.equal((await updateUserCategory(db, u, SYS.food, { name: 'Взломал' })).status, 404);
  assert.equal((await updateUserCategory(db, u, 'не-uuid', { name: 'Х' })).status, 404);

  await createUserCategory(db, u, { name: 'Кино', type: 'expense' });
  assert.equal((await updateUserCategory(db, u, mine, { name: 'кино' })).status, 409);
  // то же имя, что и у неё самой, — не дубликат
  assert.equal((await updateUserCategory(db, u, mine, { name: 'Книги', icon: '📚' })).status, 200);

  // смена типа переносит в подходящую группу
  assert.equal((await updateUserCategory(db, u, mine, { type: 'income' })).status, 200);
  const row = await catRow(mine);
  assert.equal(row.type, 'income');
  assert.equal(row.group_id, G.incWork);
});

test('список для кабинета отдаёт иконку, подсказку и группу', async () => {
  const u = await newUser();
  const id = (await createUserCategory(db, u, { name: 'Рыбалка', type: 'expense', icon: '🎣', hint: 'удочка, наживка' })).json.data.id;
  const { data } = await db.from('categories').select('id, name, type, user_id, group_id, icon, synonyms, is_active, category_groups(name)').eq('id', id).single();
  const m = mapCategoryRow(data);
  assert.equal(m.icon, '🎣');
  assert.equal(m.hint, 'удочка, наживка');
  assert.equal(m.group_id, G.expOther);
  assert.equal(m.group_name, 'Другое');
});

// ── Правка транзакции ──────────────────────────────────────────────────────

test('правка транзакции по id категории: сумма, дата и категория сохраняются', async () => {
  const u = await newUser();
  const tx = await newTx(u, SYS.other);
  const r = await updateTransaction(db, u, tx, { type: 'expense', category_id: SYS.food, category: 'Продукты', amount: 5100.5, transaction_date: '2026-10-12' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const row = await txRow(tx);
  assert.equal(row.category_id, SYS.food);
  assert.equal(row.amount, 5100.5);
  assert.equal(row.transaction_date, '2026-10-12');
});

test('правка транзакции: категория, которой нет в списке, не ломает сохранение — остаётся прежняя (баг «Остальное»→«Налоги»)', async () => {
  const u = await newUser();
  const tx = await newTx(u, SYS.other);
  const r = await updateTransaction(db, u, tx, { type: 'expense', category: 'Налоги', amount: 4800, transaction_date: '2026-10-10' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const row = await txRow(tx);
  assert.equal(row.category_id, SYS.other, 'категория не должна стать пустой');
  assert.equal(row.amount, 4800);
});

test('правка транзакции по названию: своя категория и системная', async () => {
  const u = await newUser();
  const mine = (await createUserCategory(db, u, { name: 'Дача', type: 'expense' })).json.data.id;
  const tx = await newTx(u, SYS.other);
  assert.equal((await updateTransaction(db, u, tx, { type: 'expense', category: 'Дача', amount: 100, transaction_date: '2026-10-10' })).status, 200);
  assert.equal((await txRow(tx)).category_id, mine);
  assert.equal((await updateTransaction(db, u, tx, { type: 'expense', category: 'Продукты', amount: 100, transaction_date: '2026-10-10' })).status, 200);
  assert.equal((await txRow(tx)).category_id, SYS.food);
});

test('правка транзакции: чужая запись, чужая категория, неверный тип, сумма и дата', async () => {
  const u = await newUser();
  const other = await newUser();
  const tx = await newTx(u, SYS.other);
  const foreignCat = (await createUserCategory(db, other, { name: 'ЧужаяКат', type: 'expense' })).json.data.id;
  const base = { type: 'expense', category_id: SYS.food, amount: 100, transaction_date: '2026-10-10' };

  assert.equal((await updateTransaction(db, other, tx, base)).status, 404); // чужая запись
  // чужая категория не находится по id — категория остаётся прежней
  assert.equal((await updateTransaction(db, u, tx, { ...base, category_id: foreignCat, category: undefined })).status, 200);
  assert.equal((await txRow(tx)).category_id, SYS.other);
  const before = await txRow(tx);
  // категория дохода к расходу не подходит
  assert.equal((await updateTransaction(db, u, tx, { ...base, category_id: SYS.salary })).status, 400);

  assert.equal((await updateTransaction(db, u, tx, { ...base, type: 'goal' })).status, 400);
  assert.equal((await updateTransaction(db, u, tx, { ...base, amount: 0 })).status, 400);
  assert.equal((await updateTransaction(db, u, tx, { ...base, amount: -5 })).status, 400);
  assert.equal((await updateTransaction(db, u, tx, { ...base, amount: 'abc' })).status, 400);
  assert.equal((await updateTransaction(db, u, tx, { ...base, transaction_date: '10.10.2026' })).status, 400);
  assert.equal((await updateTransaction(db, u, 'не-uuid', base)).status, 404);
  assert.deepEqual(await txRow(tx), before, 'ошибочные запросы ничего не меняют');
});

// ── Цель: «Сколько накоплено» ──────────────────────────────────────────────

async function newGoal(userId, extra = {}) {
  const id = uid();
  const { error } = await db.from('goals').insert({
    id, user_id: userId, name: 'купить квартиру', target_amount: 1400000, future_value: 4235839,
    initial_saved: 28000, monthly_payment: 4609, target_date: '2045-10-01', yield_rate: 0.12, ...extra,
  });
  assert.ifError(error);
  return id;
}
const goalRow = async (id) => (await db.from('goals').select('*').eq('id', id).single()).data;

test('«Сколько накоплено»: сумма сохраняется, взнос пересчитывается (цель с доходностью 12%)', async () => {
  const u = await newUser();
  const g = await newGoal(u);
  const r = await applyGoalSaved(db, g, 282000);
  assert.equal(r.status, 'ok');
  const row = await goalRow(g);
  assert.equal(row.initial_saved, 282000);
  assert.ok(row.monthly_payment > 0 && row.monthly_payment < 4609, `взнос стал меньше: ${row.monthly_payment}`);
  assert.equal(row.monthly_payment, r.calc.monthlyPayment);
});

test('«Сколько накоплено»: если накопленного уже хватает, сумма всё равно сохраняется (взнос 0)', async () => {
  const u = await newUser();
  const g = await newGoal(u);
  const r = await applyGoalSaved(db, g, 4000000);
  assert.equal(r.status, 'enough');
  const row = await goalRow(g);
  assert.equal(row.initial_saved, 4000000);
  assert.equal(row.monthly_payment, 0);
  assert.ok(row.future_value > 0);
});

test('«Сколько накоплено»: цели нет — понятный статус без исключения', async () => {
  assert.equal((await applyGoalSaved(db, uid(), 1000)).status, 'notfound');
});

// ── Разбор суммы ───────────────────────────────────────────────────────────

test('parseAmountStrict принимает только сумму; «500 на цель» и «такси 450» — нет', () => {
  const log = console.log; console.log = () => {};
  try {
    for (const [t, n] of [['282000', 282000], ['282 тыс', 282000], ['282 тыс.', 282000], ['282к', 282000], ['1.5 млн', 1500000], ['1,5 млн', 1500000],
      ['3 000 000 ₽', 3000000], ['5 миллионов', 5000000], ['282000 рублей', 282000], ['0', 0], ['1.500.000', 1500000]]) {
      assert.equal(parseAmountStrict(t), n, t);
    }
    for (const t of ['500 на цель', 'такси 450', 'кафе 1200', 'привет', '', '   ', null, undefined]) {
      assert.equal(parseAmountStrict(t), null, String(t));
    }
    // раньше «1.5 млн» превращалось в 15 млн (точка вырезалась)
    assert.equal(parseAmount('1.5 млн'), 1500000);
    assert.equal(parseAmount('2,5 тыс'), 2500);
  } finally { console.log = log; }
});

test('диалог про цель устаревает через 30 минут', () => {
  const now = 1_000_000_000_000;
  assert.equal(isGoalStateExpired({ createdAt: now - 5 * 60_000 }, now), false);
  assert.equal(isGoalStateExpired({ createdAt: now - GOAL_STATE_TTL_MS - 1 }, now), true);
  assert.equal(isGoalStateExpired({}, now), false); // у старых состояний даты нет — не трогаем
  assert.equal(isGoalStateExpired(undefined, now), false);
});

// ── Страницы и обработчик цели используют новый код ────────────────────────

test('страницы и бот подключены к новой логике', () => {
  const h = read('public/cabinet/history.html');
  assert.ok(h.includes('loadCategoryLists'), 'история: категории из базы');
  assert.ok(h.includes('payload.category_id'), 'история: отправляем id категории');
  const c = read('public/cabinet/categories.html');
  assert.ok(c.includes('id="formCatGroup"') && c.includes('group_id'), 'категории: выбор группы');
  const goal = read('src/handlers/goal.js');
  assert.ok(goal.includes('applyGoalSaved') && goal.includes('parseAmountStrict') && goal.includes('isGoalStateExpired'));
  assert.match(read('src/handlers/callbackDispatcher.js'), /awaitingGoal \|\| st\?\.awaitingGoalEdit/, '«Главное меню» закрывает диалог про цель');
  const routes = read('src/cabinetRoutes.js');
  assert.ok(routes.includes("'/api/category-groups'") && routes.includes('updateTransaction(') && routes.includes('createUserCategory('));
  assert.ok(fs.existsSync(new URL('../db/migrations/005_category_icon.sql', import.meta.url)));
});
