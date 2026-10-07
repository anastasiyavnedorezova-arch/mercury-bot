import test from 'node:test';
import assert from 'node:assert/strict';
import { createDbFromExecutor, FOREIGN_KEYS } from '../src/db/pgClient.js';
import { makeDb } from './helpers/testDb.mjs';

async function seed(db) {
  const { data: u } = await db.from('users').insert({ external_id: '100', channel: 'telegram', email: 'a@b.ru' }).select().single();
  const { data: g } = await db.from('category_groups').insert({ name: 'Еда', type: 'expense' }).select().single();
  const { data: c1 } = await db.from('categories').insert({ group_id: g.id, name: 'Продукты', type: 'expense', is_system: true, synonyms: ['еда', 'магазин'] }).select().single();
  const { data: c2 } = await db.from('categories').insert({ group_id: g.id, user_id: u.id, name: 'Кофе', type: 'expense' }).select().single();
  return { u, g, c1, c2 };
}

test('внешние ключи в FOREIGN_KEYS совпадают с реальной схемой', async (t) => {
  const { query, close } = await makeDb(); t.after(close);
  const r = await query(`
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, c.confrelid::regclass::text AS ref
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`);
  const real = {};
  for (const row of r.rows) {
    const t = row.tbl.replace('public.', '');
    const ref = row.ref.replace('public.', '');
    (real[t] ??= {})[ref] = row.col;
  }
  for (const t of Object.keys(FOREIGN_KEYS)) assert.deepEqual(FOREIGN_KEYS[t], real[t] ?? {}, `FK mismatch for ${t}`);
});

test('типы: numeric/count — числа, date — строка, timestamptz — ISO, text[] — массив', async (t) => {
  const { db, close } = await makeDb(); t.after(close);
  const { u, c1 } = await seed(db);
  await db.from('transactions').insert([
    { user_id: u.id, category_id: c1.id, type: 'expense', amount: 1.5, transaction_date: '2026-10-06' },
    { user_id: u.id, category_id: c1.id, type: 'expense', amount: 1.5, transaction_date: '2026-10-07' },
  ]);
  const { data, count, error } = await db.from('transactions').select('amount, transaction_date, created_at', { count: 'exact' }).eq('user_id', u.id);
  assert.equal(error, null);
  assert.equal(count, 2);
  assert.equal(typeof count, 'number');
  assert.equal(data.reduce((s, t) => s + t.amount, 0), 3);        // сложение, а не склейка строк
  assert.equal(typeof data[0].amount, 'number');
  assert.equal(data[0].transaction_date, '2026-10-06');
  assert.match(data[0].created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const { data: cat } = await db.from('categories').select('synonyms').eq('id', c1.id).single();
  assert.deepEqual(cat.synonyms, ['еда', 'магазин']);
});

test('фильтры: eq/neq/gt/gte/lt/lte/in/is/not/or/ilike/order/limit/range', async (t) => {
  const { db, close } = await makeDb(); t.after(close);
  const { u, c1, c2 } = await seed(db);
  for (const [d, a] of [['2026-10-01', 10], ['2026-10-02', 20], ['2026-10-03', 30], ['2026-10-04', 40]]) {
    await db.from('transactions').insert({ user_id: u.id, category_id: c1.id, type: 'expense', amount: a, transaction_date: d });
  }
  const q = () => db.from('transactions').select('amount').eq('user_id', u.id);
  assert.deepEqual((await q().gt('amount', 20).order('amount')).data.map((r) => r.amount), [30, 40]);
  assert.deepEqual((await q().gte('amount', 20).lt('amount', 40).order('amount')).data.map((r) => r.amount), [20, 30]);
  assert.deepEqual((await q().lte('transaction_date', '2026-10-02').order('transaction_date', { ascending: false })).data.map((r) => r.amount), [20, 10]);
  assert.deepEqual((await q().neq('amount', 10).in('amount', [10, 20, 30]).order('amount')).data.map((r) => r.amount), [20, 30]);
  assert.deepEqual((await q().in('amount', [])).data, []);
  assert.deepEqual((await q().order('amount').range(1, 2)).data.map((r) => r.amount), [20, 30]);
  assert.equal((await q().order('amount').limit(1)).data.length, 1);
  // is / not / or
  assert.equal((await db.from('categories').select('id').is('user_id', null)).data.length, 1);
  assert.equal((await db.from('users').select('id').not('email', 'is', null)).data.length, 1);
  assert.equal((await db.from('users').select('id').is('email', null)).data.length, 0);
  const or = await db.from('categories').select('name').or(`user_id.is.null,user_id.eq.${u.id}`).order('name');
  assert.deepEqual(or.data.map((r) => r.name), ['Кофе', 'Продукты']);
  const or2 = await db.from('categories').select('name').or(`user_id.eq.${u.id},user_id.is.null`).eq('type', 'expense');
  assert.equal(or2.data.length, 2);
  // ilike без учёта регистра
  assert.equal((await db.from('categories').select('id').ilike('name', 'кофе')).data.length, 1);
  assert.equal((await db.from('categories').select('id').ilike('name', 'КОФЕ')).data.length, 1);
  // nullsFirst
  const o = await db.from('categories').select('name, user_id').order('user_id', { nullsFirst: true });
  assert.equal(o.data[0].user_id, null);
});

test('count: exact, head: true', async (t) => {
  const { db, close } = await makeDb(); t.after(close);
  const { u, c1 } = await seed(db);
  for (let i = 0; i < 5; i++) await db.from('transactions').insert({ user_id: u.id, category_id: c1.id, type: 'expense', amount: 1, transaction_date: '2026-10-01' });
  const h = await db.from('transactions').select('id', { count: 'exact', head: true }).eq('user_id', u.id);
  assert.equal(h.count, 5);
  assert.equal(h.data, null);
  assert.equal(h.error, null);
  const p = await db.from('transactions').select('id', { count: 'exact' }).eq('user_id', u.id).range(0, 1);
  assert.equal(p.data.length, 2);
  assert.equal(p.count, 5);
});

test('вложенные связи: один и два уровня, null, звёздочка', async (t) => {
  const { db, close } = await makeDb(); t.after(close);
  const { u, c1, c2 } = await seed(db);
  await db.from('transactions').insert({ user_id: u.id, category_id: c1.id, type: 'expense', amount: 5.25, transaction_date: '2026-10-01', comment: 'x' });
  const one = await db.from('transactions').select('amount, type, categories(name, is_system)').eq('user_id', u.id);
  assert.deepEqual(one.data[0], { amount: 5.25, type: 'expense', categories: { name: 'Продукты', is_system: true } });
  const two = await db.from('transactions').select('id, type, amount, comment, transaction_date, categories(name, category_groups(name))', { count: 'exact' }).eq('user_id', u.id).order('transaction_date', { ascending: false }).range(0, 19);
  assert.equal(two.error, null);
  assert.equal(two.count, 1);
  assert.equal(two.data[0].categories.category_groups.name, 'Еда');
  assert.equal(two.data[0].transaction_date, '2026-10-01');
  const grp = await db.from('categories').select('id, name, type, user_id, is_active, category_groups(name)').is('user_id', null);
  assert.equal(grp.data[0].category_groups.name, 'Еда');
  const star = await db.from('transactions').select('*, categories(*)').eq('user_id', u.id).single();
  assert.equal(star.data.categories.name, 'Продукты');
  assert.equal(star.data.amount, 5.25);
  // goal_id пустой -> null
  const goalEmb = await db.from('transactions').select('id, goals(name)').eq('user_id', u.id).single();
  assert.equal(goalEmb.data.goals, null);
  // неизвестная связь -> понятная ошибка, а не падение
  const bad = await db.from('transactions').select('id, nope(name)');
  assert.ok(bad.error); assert.equal(bad.data, null);
});

test('insert/update/delete/upsert и возврат строк', async (t) => {
  const { db, close } = await makeDb(); t.after(close);
  const { u, g } = await seed(db);
  // insert без select -> data null
  const i1 = await db.from('feedback').insert({ user_id: u.id, message: 'привет', status: 'new' });
  assert.equal(i1.error, null); assert.equal(i1.data, null);
  const f = await db.from('feedback').select('*').eq('user_id', u.id).single();
  assert.equal(f.data.message, 'привет');
  // update + returning
  const up = await db.from('feedback').update({ status: 'read' }).eq('id', f.data.id).select('status').single();
  assert.deepEqual(up.data, { status: 'read' });
  // update без фильтра запрещён
  const unsafe = await db.from('feedback').update({ status: 'x' });
  assert.equal(unsafe.error.code, 'FINNIK_UNSAFE');
  const unsafeDel = await db.from('feedback').delete();
  assert.equal(unsafeDel.error.code, 'FINNIK_UNSAFE');
  // delete + returning
  const del = await db.from('feedback').delete().eq('id', f.data.id).select('id');
  assert.equal(del.data.length, 1);
  assert.equal((await db.from('feedback').select('id')).data.length, 0);
  // upsert по уникальной паре
  await db.from('users').upsert({ external_id: '555', channel: 'telegram', email: 'one@x.ru' }, { onConflict: 'external_id,channel' });
  await db.from('users').upsert({ external_id: '555', channel: 'telegram', email: 'two@x.ru' }, { onConflict: 'external_id,channel' });
  const us = await db.from('users').select('email').eq('external_id', '555');
  assert.deepEqual(us.data, [{ email: 'two@x.ru' }]);
  const ign = await db.from('users').upsert({ external_id: '555', channel: 'telegram', email: 'three@x.ru' }, { onConflict: 'external_id,channel', ignoreDuplicates: true });
  assert.equal(ign.error, null);
  assert.equal((await db.from('users').select('email').eq('external_id', '555').single()).data.email, 'two@x.ru');
  // upsert по колонке без уникального ограничения -> ошибка в результате, а не исключение (как в Supabase)
  const bad = await db.from('subscriptions').upsert({ user_id: u.id, status: 'active' }, { onConflict: 'user_id' });
  assert.ok(bad.error);
  // массовая вставка
  const many = await db.from('category_groups').insert([{ name: 'A', type: 'income' }, { name: 'B', type: 'income' }]).select('name');
  assert.equal(many.data.length, 2);
  // значения по умолчанию
  const d = await db.from('users').insert({ external_id: '777' }).select('channel, status').single();
  assert.deepEqual(d.data, { channel: 'telegram', status: 'active' });
});

test('single / maybeSingle', async (t) => {
  const { db, close } = await makeDb(); t.after(close);
  await seed(db);
  const none = await db.from('users').select('id').eq('external_id', 'нет').single();
  assert.equal(none.error.code, 'PGRST116'); assert.equal(none.data, null);
  const maybe = await db.from('users').select('id').eq('external_id', 'нет').maybeSingle();
  assert.equal(maybe.error, null); assert.equal(maybe.data, null);
  const many = await db.from('categories').select('id').maybeSingle();
  assert.equal(many.error.code, 'PGRST116');
  const ok = await db.from('users').select('id').eq('external_id', '100').single();
  assert.ok(ok.data.id);
});

test('ошибки возвращаются, а не выбрасываются; уникальный ключ = код 23505', async (t) => {
  const { db, close } = await makeDb(); t.after(close);
  await db.from('users').insert({ external_id: '1', channel: 'web' });
  const dup = await db.from('users').insert({ external_id: '1', channel: 'web' });
  assert.equal(dup.error.code, '23505');
  assert.equal(typeof dup.error.message, 'string');
  const noTable = await db.from('nope').select('*');
  assert.ok(noTable.error);
  const noCol = await db.from('users').select('zzz');
  assert.ok(noCol.error); assert.equal(noCol.data, null);
  const undef = await db.from('users').select('id').eq('id', undefined);
  assert.equal(undef.error.code, 'FINNIK_UNDEFINED_VALUE');
  const badUuid = await db.from('users').select('id').eq('id', 'не-uuid');
  assert.ok(badUuid.error);
});

test('защита от инъекций: имена колонок проверяются, значения — параметры', async (t) => {
  const { db, close } = await makeDb(); t.after(close);
  await seed(db);
  const col = await db.from('users').select('id').eq('id; drop table users; --', 'x');
  assert.equal(col.error.code, 'FINNIK_BAD_IDENT');
  const sel = await db.from('users').select('id; drop table users');
  assert.ok(sel.error);
  const ord = await db.from('users').select('id').order('id; drop table users');
  assert.equal(ord.error.code, 'FINNIK_BAD_IDENT');
  const evil = `'; drop table users; --`;
  const ins = await db.from('feedback').insert({ message: evil }).select('message').single();
  assert.equal(ins.data.message, evil);
  assert.equal((await db.from('users').select('id')).error, null);   // таблица на месте
  const orEvil = await db.from('categories').select('id').or(`user_id.eq.${evil},name.eq.x`);
  assert.ok(orEvil.error || orEvil.data.length === 0);
  assert.equal((await db.from('users').select('id')).error, null);
});

test('запрос выполняется один раз, даже если await вызван дважды', async () => {
  let calls = 0;
  const db = createDbFromExecutor({ query: async () => { calls++; return { rows: [{ c: 1 }] }; } });
  const q = db.from('users').select('id', { count: 'exact', head: true });
  await q; await q;
  assert.equal(calls, 1);
});
