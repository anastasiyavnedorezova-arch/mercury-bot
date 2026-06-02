import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

export const pool = new Pool({
  host:     process.env.TIMEWEB_DB_HOST,
  port:     parseInt(process.env.TIMEWEB_DB_PORT ?? '5432', 10),
  database: process.env.TIMEWEB_DB_NAME,
  user:     process.env.TIMEWEB_DB_USER,
  password: process.env.TIMEWEB_DB_PASSWORD,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

// ── Хелперы ───────────────────────────────────────────────────────────────────

/** SELECT → несколько строк. Возвращает { data: rows[], error } */
export async function queryAll(sql, params = []) {
  try {
    const { rows } = await pool.query(sql, params);
    return { data: rows, error: null };
  } catch (err) {
    console.error('[db] queryAll error:', err.message, '\nSQL:', sql);
    return { data: null, error: err };
  }
}

/** SELECT → одна строка или null. Возвращает { data: row|null, error } */
export async function queryOne(sql, params = []) {
  try {
    const { rows } = await pool.query(sql, params);
    return { data: rows[0] ?? null, error: null };
  } catch (err) {
    console.error('[db] queryOne error:', err.message, '\nSQL:', sql);
    return { data: null, error: err };
  }
}

/** INSERT / UPDATE / DELETE без RETURNING — просто выполнить */
export async function run(sql, params = []) {
  try {
    await pool.query(sql, params);
    return { error: null };
  } catch (err) {
    console.error('[db] run error:', err.message, '\nSQL:', sql);
    return { error: err };
  }
}

/** SELECT COUNT(*) → { count: n, error } */
export async function queryCount(sql, params = []) {
  try {
    const { rows } = await pool.query(sql, params);
    return { count: parseInt(rows[0]?.count ?? '0', 10), error: null };
  } catch (err) {
    console.error('[db] queryCount error:', err.message, '\nSQL:', sql);
    return { count: 0, error: err };
  }
}
