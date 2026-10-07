import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createDbFromExecutor, createPgDb } from '../../src/db/pgClient.js';
import { PARSERS } from '../../src/db/typeParsers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../');

const schema = fs.readFileSync(path.join(ROOT, 'db/schema.sql'), 'utf8');

// Load all migrations from db/migrations/ except *b_* (Supabase-specific),
// sorted by filename.
function loadMigrations() {
  const dir = path.join(ROOT, 'db/migrations');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.sql') && !/\db_/.test(f))
    .sort()
    .map(f => fs.readFileSync(path.join(dir, f), 'utf8'));
}

/**
 * makeDb() — returns { db, query, close }
 *
 * In default mode uses PGlite (in-memory Postgres, no server needed).
 * If TEST_DATABASE_URL is set, uses a real PostgreSQL connection.
 * DB name must end with _test to prevent accidental data loss.
 */
export async function makeDb() {
  const TEST_URL = process.env.TEST_DATABASE_URL || '';
  const migrations = loadMigrations();

  if (TEST_URL) {
    const dbName = new URL(TEST_URL).pathname.replace(/^\//, '');
    if (!/_test$/.test(dbName)) {
      throw new Error(
        `TEST_DATABASE_URL must point to a database whose name ends with _test (got "${dbName}")`
      );
    }
    const admin = new pg.Client({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await admin.query(schema);
    for (const sql of migrations) await admin.query(sql);
    const db = createPgDb(TEST_URL, { max: 2 });
    return {
      db,
      query: (t, p) => admin.query(t, p),
      close: async () => { await db.end(); await admin.end(); },
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const pgl = new PGlite({ parsers: PARSERS });
  await pgl.exec(schema);
  for (const sql of migrations) await pgl.exec(sql);
  const db = createDbFromExecutor({ query: (t, p) => pgl.query(t, p) });
  return {
    db,
    query: (t, p) => pgl.query(t, p),
    close: async () => {},
  };
}
