// Свои категории и тариф free: записи в них не пишутся, сами категории сохраняются (23.10.2026).
// Править и удалять записи можно на любом тарифе.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { makeDb } from './helpers/testDb.mjs';
import {
  resolveCategory, listPickableCategories, findPickableCategory, canUseCategory,
  applyCategoryScope, customCategoriesAllowed, CUSTOM_LOCKED_NOTE, CUSTOM_EDIT_LOCKED_MESSAGE, CUSTOM_CREATE_LOCKED_MESSAGE,
} from '../src/utils/categoryAccess.js';
import { updateTransaction } from '../src/cabinet/historyEdit.js';
import { createUserCategory } from '../src/cabinet/categories.js';
import { buildConfirmationText, buildMultiConfirmationText } from '../src/utils/botTexts.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const uid = () => crypto.randomUUID();

let ctx; let db; let group; let sysFood; let sysOther; let me; let other; let myHobby; let otherHobby; let myOld;
before(async () => {
  ctx = await makeDb();
  db = ctx.db;
  group = uid();
  assert.ifError((await db.from('category_groups').insert({ id: group, name: 'Еда', type: 'expense', sort_order: 1 })).error);
  const mk = async (name, user_id, extra = {}) => {
    const id = uid();
    assert.ifError((await db.from('categories').insert({ id, name, type: 'expense', group_id: group, user_id, is_system: user_id === null, is_active: true, ...extra })).error);
    return id;
  };
  me = uid(); other = uid();
  for (const id of [me, other]) assert.ifError((await db.from('users').insert({ id, external_id: id, channel: 'web', email: `${id}@t.ru` })).error);
  sysFood = await mk('Продукты', null);
  sysOther = await mk('Остальное', null);
  myHobby = await mk('Хобби', me);
  otherHobby = await mk('Хобби', other);
  myOld = await mk('Старая', me, { is_active: false });
});
after(async () => { await ctx?.close(); });

async function newTx(category_id, user_id = me) {
  const id = uid();
  assert.ifError((await db.from('transactions').insert({ id, user_id, type: 'expense', amount: 100, category_id, transaction_date: '2026-10-23' })).error);
  return id;
}
const txRow = async (id) => (await db.from('transactions').select('*').eq('id', id).single()).data;

test('правила: свои категории разрешены только на пробном периоде и в подписке', () => {
  assert.equal(customCategoriesAllowed('trial'), true);
  assert.equal(customCategoriesAllowed('active'), true);
  assert.equal(customCategoriesAllowed('free'), false);
  assert.equal(customCategoriesAllowed(undefined), false);
  assert.equal(canUseCategory({ user_id: null }, me, 'free'), true);
  assert.equal(canUseCategory({ user_id: me }, me, 'free'), false);
  assert.equal(canUseCategory({ user_id: me }, me, 'active'), true);
  assert.equal(canUseCategory({ user_id: other }, me, 'active'), false);
  assert.equal(canUseCategory(null, me, 'active'), false);
});

test('бот: запись в свою категорию — только с доступом; на free уходит в «Остальное» с пометкой', async () => {
  for (const access of ['trial', 'active']) {
    const r = await resolveCategory(db, me, 'Хобби', access);
    assert.deepEqual(r, { id: myHobby, name: 'Хобби', lockedFrom: null }, access);
  }
  const free = await resolveCategory(db, me, 'Хобби', 'free');
  assert.deepEqual(free, { id: sysOther, name: 'Остальное', lockedFrom: 'Хобби' });
  // системные категории работают на любом тарифе
  assert.equal((await resolveCategory(db, me, 'Продукты', 'free')).id, sysFood);
  // неизвестное название — «Остальное», без пометки про тариф
  assert.deepEqual(await resolveCategory(db, me, 'Неведомое', 'free'), { id: sysOther, name: 'Остальное', lockedFrom: null });
  // чужая категория с тем же названием не используется
  const o = await resolveCategory(db, other, 'Хобби', 'active');
  assert.equal(o.id, otherHobby);
  assert.equal((await resolveCategory(db, uid(), 'Хобби', 'active')).id, sysOther);
  // удалённая (неактивная) категория не используется
  assert.equal((await resolveCategory(db, me, 'Старая', 'active')).id, sysOther);
});

test('бот: списки категорий для выбора и поиск по названию не показывают закрытые и чужие', async () => {
  const names = async (access, user = me) => (await listPickableCategories(db, user, access, group)).map((c) => c.name).sort();
  assert.deepEqual(await names('free'), ['Остальное', 'Продукты']);
  assert.deepEqual(await names('active'), ['Остальное', 'Продукты', 'Хобби']);
  assert.deepEqual(await names('trial', other), ['Остальное', 'Продукты', 'Хобби']);
  // применимо и к произвольным запросам (поиск по названию)
  const free = await applyCategoryScope(db.from('categories').select('id').eq('name', 'Хобби'), me, 'free');
  assert.equal(free.data.length, 0);
  const paid = await applyCategoryScope(db.from('categories').select('id').eq('name', 'Хобби'), me, 'active');
  assert.deepEqual(paid.data.map((r) => r.id), [myHobby]);
});

test('бот: выбранную категорию проверяем (чужая, закрытая тарифом, удалённая — нельзя)', async () => {
  assert.equal((await findPickableCategory(db, me, 'free', sysFood)).id, sysFood);
  assert.equal(await findPickableCategory(db, me, 'free', myHobby), null);
  assert.equal((await findPickableCategory(db, me, 'trial', myHobby)).id, myHobby);
  assert.equal(await findPickableCategory(db, me, 'active', otherHobby), null);
  assert.equal(await findPickableCategory(db, me, 'active', myOld), null);
  assert.equal(await findPickableCategory(db, me, 'active', uid()), null);
});

test('бот: в ответе об записи на free есть пометка про категорию, в остальных случаях нет', () => {
  const item = { type: 'expense', amount: 500, category: 'Хобби', category_saved: 'Остальное', transaction_date: '2026-10-23' };
  assert.ok(!buildConfirmationText(item).includes(CUSTOM_LOCKED_NOTE));
  assert.ok(buildConfirmationText({ ...item, category_locked: 'Хобби' }).includes('Свои категории доступны в подписке'));
  assert.ok(buildMultiConfirmationText([item, { ...item, category_locked: 'Хобби' }]).includes(CUSTOM_LOCKED_NOTE));
  assert.ok(!buildMultiConfirmationText([item, item]).includes(CUSTOM_LOCKED_NOTE));
});

test('кабинет «История»: на free нельзя перевести запись в свою категорию, но сумму и дату в записи со своей категорией править можно', async () => {
  const t1 = await newTx(sysFood);
  const denied = await updateTransaction(db, me, t1, { type: 'expense', amount: 200, transaction_date: '2026-10-22', category_id: myHobby }, 'free');
  assert.equal(denied.status, 403);
  assert.equal(denied.json.message, CUSTOM_EDIT_LOCKED_MESSAGE);
  const row = await txRow(t1);
  assert.equal(row.category_id, sysFood);
  assert.equal(Number(row.amount), 100, 'при отказе ничего не меняется');

  // по названию — то же самое
  const deniedByName = await updateTransaction(db, me, t1, { type: 'expense', amount: 200, transaction_date: '2026-10-22', category: 'Хобби' }, 'free');
  assert.equal(deniedByName.status, 403);

  // запись уже в своей категории (осталась с пробного периода): правка суммы и даты проходит, категория остаётся
  const t2 = await newTx(myHobby);
  const same = await updateTransaction(db, me, t2, { type: 'expense', amount: 350.5, transaction_date: '2026-10-20', category_id: myHobby }, 'free');
  assert.equal(same.status, 200);
  const r2 = await txRow(t2);
  assert.equal(Number(r2.amount), 350.5);
  assert.equal(r2.category_id, myHobby);

  // перевод из своей в системную на free разрешён
  const out = await updateTransaction(db, me, t2, { type: 'expense', amount: 350.5, transaction_date: '2026-10-20', category_id: sysFood }, 'free');
  assert.equal(out.status, 200);
  assert.equal((await txRow(t2)).category_id, sysFood);
  // и обратно уже нельзя
  const back = await updateTransaction(db, me, t2, { type: 'expense', amount: 350.5, transaction_date: '2026-10-20', category_id: myHobby }, 'free');
  assert.equal(back.status, 403);

  // с пробным периодом или подпиской можно
  for (const access of ['trial', 'active']) {
    const ok = await updateTransaction(db, me, t2, { type: 'expense', amount: 10, transaction_date: '2026-10-20', category_id: myHobby }, access);
    assert.equal(ok.status, 200, access);
    assert.equal((await txRow(t2)).category_id, myHobby);
    await updateTransaction(db, me, t2, { type: 'expense', amount: 10, transaction_date: '2026-10-20', category_id: sysFood }, access);
  }
});

test('кабинет «История»: чужую запись не правим ни на каком тарифе, чужую категорию не подставить', async () => {
  const foreign = await newTx(sysFood, other);
  const r = await updateTransaction(db, me, foreign, { type: 'expense', amount: 1, transaction_date: '2026-10-22', category_id: sysFood }, 'free');
  assert.equal(r.status, 404);
  const mine = await newTx(sysFood);
  const withForeignCat = await updateTransaction(db, me, mine, { type: 'expense', amount: 5, transaction_date: '2026-10-22', category_id: otherHobby }, 'active');
  assert.equal((await txRow(mine)).category_id, sysFood, 'чужая категория не подставляется');
  assert.equal(withForeignCat.status, 200, 'остальные поля сохраняются, категория остаётся прежней');
});

test('кабинет «Категории»: создать свою категорию на free нельзя, с пробным периодом и подпиской можно', async () => {
  const denied = await createUserCategory(db, me, { name: 'Новая1', type: 'expense' }, 'free');
  assert.equal(denied.status, 403);
  assert.equal(denied.json.message, CUSTOM_CREATE_LOCKED_MESSAGE);
  assert.equal((await db.from('categories').select('id').eq('user_id', me).eq('name', 'Новая1')).data.length, 0);
  for (const [i, access] of ['trial', 'active'].entries()) {
    const ok = await createUserCategory(db, me, { name: `Новая${i + 2}`, type: 'expense' }, access);
    assert.equal(ok.status, 201, access);
  }
});

test('маршруты и бот: тариф передаётся в проверки, платной стены на правке и удалении записей нет', () => {
  const routes = read('src/cabinetRoutes.js');
  assert.match(routes, /updateTransaction\(supabase, req\.userId, req\.params\.id, req\.body, await getUserAccess\(req\.userId\)\)/);
  assert.match(routes, /createUserCategory\(supabase, req\.userId, req\.body, await getUserAccess\(req\.userId\)\)/);
  // удаление записи — без проверки тарифа
  const del = routes.slice(routes.indexOf("router.delete('/api/history/:id'"), routes.indexOf("router.get('/api/accounting'"));
  assert.ok(!del.includes('getUserAccess'));

  const tx = read('src/handlers/transaction.js');
  assert.ok(!tx.includes('checkAccess') && !tx.includes('PAYWALL_TEXT'));
  assert.match(tx, /listPickableCategories\(supabase, userId, await getUserAccess\(userId\), groupId\)/);
  assert.match(tx, /findPickableCategory\(supabase, userId, await getUserAccess\(userId\), categoryId\)/);

  const msg = read('src/handlers/message.js');
  assert.match(msg, /resolveCategory\(supabase, userId, parsed\.category, access\)/);
  assert.match(msg, /customCategoriesAllowed\(await getUserAccess\(userId\)\)/, 'модели свои категории не показываем на free');

  const cats = read('src/handlers/categories.js');
  assert.equal((cats.match(/customCategoriesAllowed\(await getUserAccess\(/g) || []).length, 3, 'создание (кнопка и ввод названия) и подсказка в «Моих категориях»');
});

test('тексты тарифа в боте и на сайте: редактирование и удаление записей — для всех, платные свои категории', () => {
  const sub = read('src/handlers/subscription.js');
  assert.match(sub, /'✔️ редактирование и удаление записей\\n'/);
  assert.ok(!sub.includes('❌ редактирование и удаление записей'));
  assert.match(sub, /'❌ свои категории\\n\\n'/);
  assert.match(sub, /'✅ свои категории\\n\\n'/);
  assert.ok(!read('src/emails/letters.js').includes('✅ редактирование и удаление записей'));
  assert.match(read('public/index.html'), /Редактировать и удалять записи можно на любом тарифе, в личном кабинете и в чате с ботом\./);
});
