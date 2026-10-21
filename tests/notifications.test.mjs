// Напоминания в Telegram: выбор активных пользователей. Плюс сторож: запросы `.from('таблица').select('колонки')` в коде
// не должны просить колонок, которых нет в схеме (так напоминания молча не работали после переезда с Supabase).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeDb } from './helpers/testDb.mjs';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:1/test'; // db.js подключается лениво; боевой базы в тестах нет
const { getActiveUsers } = await import('../src/notifications/index.js');

let ctx;
before(async () => { ctx = await makeDb(); });
after(async () => { await ctx?.close(); });

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

async function addUser(o) {
  const id = crypto.randomUUID();
  const { error } = await ctx.db.from('users').insert({
    id, external_id: o.external_id ?? `tg-${id}`, channel: o.channel ?? 'telegram', status: 'active',
    terms_accepted_at: 'terms' in o ? o.terms : daysAgo(5), last_active_at: o.last ?? daysAgo(1),
  });
  assert.ifError(error);
  return id;
}

test('getActiveUsers: Telegram-пользователи с согласием и активностью за 30 дней, остальные не попадают', async () => {
  const ok = await addUser({});
  const okOld = await addUser({ last: daysAgo(10) });
  const tooOld = await addUser({ last: daysAgo(60) });
  const noTerms = await addUser({ terms: null });
  const web = await addUser({ channel: 'web' });
  const ids = (await getActiveUsers(ctx.db)).map((u) => u.id);
  assert.ok(ids.includes(ok) && ids.includes(okOld));
  for (const id of [tooOld, noTerms, web]) assert.ok(!ids.includes(id));
  const one = (await getActiveUsers(ctx.db)).find((u) => u.id === ok);
  assert.ok(one.external_id && 'last_active_at' in one);
});

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? jsFiles(p) : p.endsWith('.js') ? [p] : [];
  });
}

test('сторож: простые select в коде просят только существующие колонки', async () => {
  const { rows } = await ctx.query("select table_name, column_name from information_schema.columns where table_schema = 'public'");
  const cols = new Map();
  for (const r of rows) { if (!cols.has(r.table_name)) cols.set(r.table_name, new Set()); cols.get(r.table_name).add(r.column_name); }
  const root = new URL('../src', import.meta.url).pathname;
  const re = /\.from\('(\w+)'\)\s*\.select\(\s*'([^']*)'/g;
  const bad = [];
  let checked = 0;
  for (const f of jsFiles(root)) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(re)) {
      const table = m[1];
      if (!cols.has(table)) continue; // не таблица схемы (например, представление)
      let flat = m[2];
      for (let prev = ''; prev !== flat;) { prev = flat; flat = flat.replace(/\w+(?:!\w+)?\([^()]*\)/g, ' '); } // вложенные связи categories(name, groups(name))
      const list = flat.split(',').map((s) => s.trim()).filter((s) => s && s !== '*');
      for (const c of list) {
        checked++;
        const name = c.split(':').pop().trim();
        if (!cols.get(table).has(name)) bad.push(`${path.relative(root, f)}: ${table}.${name}`);
      }
    }
  }
  assert.ok(checked > 50, `проверено колонок: ${checked}`);
  assert.deepEqual(bad, [], `запросы к несуществующим колонкам:\n${bad.join('\n')}`);
});

test('код напоминаний не просит колонку username', () => {
  const src = fs.readFileSync(new URL('../src/notifications/index.js', import.meta.url), 'utf8');
  assert.ok(!/select\('[^']*\busername\b/.test(src));
});
