// Сеанс удалённого или объединённого аккаунта: 401 (кабинет уходит на вход), а не пустые данные и не «Не нашёл твой аккаунт» в чате.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { makeDb } from './helpers/testDb.mjs';
import { requireActiveAccount } from '../src/authMiddleware.js';

let ctx; let db;
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
before(async () => { ctx = await makeDb(); db = ctx.db; });
after(async () => { await ctx?.close(); });

async function run(userId, useDb = db) {
  const req = { userId };
  const out = { status: 200, body: null, nexted: false };
  const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
  await requireActiveAccount(useDb)(req, res, () => { out.nexted = true; });
  return out;
}
async function account(extra = {}) {
  const id = crypto.randomUUID();
  const { error } = await db.from('users').insert({ id, external_id: id, channel: 'web', email: `a-${id.slice(0, 8)}@t.ru`, password_hash: 'x', ...extra });
  assert.ifError(error);
  return id;
}

test('действующий аккаунт проходит (статус пустой или active)', async () => {
  assert.equal((await run(await account())).nexted, true);
  assert.equal((await run(await account({ status: 'active' }))).nexted, true);
});

test('объединённый и удалённый аккаунты получают 401 account_inactive', async () => {
  for (const status of ['merged', 'deleted']) {
    const r = await run(await account({ status }));
    assert.equal(r.nexted, false, status);
    assert.equal(r.status, 401, status);
    assert.equal(r.body.code, 'account_inactive');
  }
});

test('аккаунта нет в базе: 401', async () => {
  const r = await run(crypto.randomUUID());
  assert.equal(r.status, 401);
  assert.equal(r.nexted, false);
});

test('сбой базы: 500, а не пропуск', async () => {
  const broken = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) };
  const r = await run('x', broken);
  assert.equal(r.status, 500);
  assert.equal(r.nexted, false);
});

test('все маршруты кабинета (в том числе веб-чат) и оплата проверяют действующий аккаунт', () => {
  assert.match(read('src/cabinetRoutes.js'), /const requireAuth = \[requireJwt, requireActiveAccount\(supabase\)\]/);
  assert.match(read('src/payments/routes.js'), /const requireAuth = \[requireJwt, requireActiveAccount\(db\)\]/);
});
