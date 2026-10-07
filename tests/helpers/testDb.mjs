// Общая подготовка тестовой базы: схема + все миграции из db/migrations (кроме Supabase-специфичных 001b).
// Два режима:
//  1) по умолчанию — встроенный PostgreSQL (PGlite), ничего ставить не нужно;
//  2) TEST_DATABASE_URL=postgresql://.../имя_test — настоящий PostgreSQL через боевой код createPgDb.
//     Имя базы ОБЯЗАТЕЛЬНО должно заканчиваться на _test: перед каждым тестом схема public пересоздаётся.
import fs from 'node:fs';
import pg from 'pg';
import { createDbFromExecutor, createPgDb } from '../../src/db/pgClient.js';
import { PARSERS } from '../../src/db/typeParsers.js';

const root = new URL('../../', import.meta.url);
const migrationsDir = new URL('db/migrations/', root);

export const schemaSql = [
  fs.readFileSync(new URL('db/schema.sql', root), 'utf8'),
  ...fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .map((f) => fs.readFileSync(new URL(f, migrationsDir), 'utf8')),
].join('\n');

const TEST_URL = process.env.TEST_DATABASE_URL || '';

export async function makeDb() {
  if (TEST_URL) {
    const dbName = new URL(TEST_URL).pathname.replace(/^\//, '');
    if (!/_test$/.test(dbName)) throw new Error(`TEST_DATABASE_URL must point to a database whose name ends with _test (got "${dbName}")`);
    const admin = new pg.Client({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await admin.query(schemaSql);
    const db = createPgDb(TEST_URL, { max: 2 });
    return { db, query: (t, p) => admin.query(t, p), close: async () => { await db.end(); await admin.end(); } };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const pgl = new PGlite({ parsers: PARSERS });
  await pgl.exec(schemaSql);
  const db = createDbFromExecutor({ query: (t, p) => pgl.query(t, p) });
  return { db, query: (t, p) => pgl.query(t, p), close: async () => {} };
}
