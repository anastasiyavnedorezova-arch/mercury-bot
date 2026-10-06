// Слой доступа к PostgreSQL с тем же интерфейсом, что у supabase-js, в объёме,
// который реально используется в проекте. Код проекта (supabase.from('...').select()...) не меняется.
//
// Поддержано: select (в т.ч. вложенные связи «многие к одному», например categories(name)),
// insert, update, delete, upsert (+ .select() для возврата строк), eq/neq/gt/gte/lt/lte/like/ilike/is/in/not/or/match,
// order, limit, range, single, maybeSingle, count: 'exact' и head: true.
// Ошибки НЕ выбрасываются, а возвращаются как { data: null, error }, как в supabase-js.
import pg from 'pg';
import { PARSERS } from './typeParsers.js';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Внешние ключи (многие к одному): таблица -> { имя связанной таблицы: колонка в этой таблице }.
// Совпадение с реальной схемой проверяется тестом (tests/pgClient.test.mjs).
export const FOREIGN_KEYS = {
  budget: { users: 'user_id' },
  categories: { category_groups: 'group_id', users: 'user_id' },
  category_groups: {},
  feedback: { users: 'user_id' },
  goals: { users: 'user_id' },
  notifications: { users: 'user_id' },
  subscriptions: { users: 'user_id' },
  transactions: { categories: 'category_id', goals: 'goal_id', users: 'user_id' },
  users: { users: 'merged_into' },
};
const TABLES = new Set(Object.keys(FOREIGN_KEYS));

class DbUsageError extends Error {
  constructor(message, code = 'FINNIK_UNSUPPORTED') {
    super(message);
    this.code = code;
  }
}

function ident(name) {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw new DbUsageError(`invalid identifier "${String(name).slice(0, 40)}"`, 'FINNIK_BAD_IDENT');
  }
  return `"${name}"`;
}

function toError(e) {
  return {
    name: 'PostgrestError',
    message: e?.message || String(e),
    code: e?.code || 'FINNIK_DB',
    details: e?.detail ?? null,
    hint: e?.hint ?? null,
  };
}

// Делит строку по запятым, которые не внутри скобок
function splitTop(str) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts.map((s) => s.trim()).filter(Boolean);
}

function parseSelect(str, table) {
  const spec = { star: false, cols: [], embeds: [] };
  const s = (str ?? '*').trim() || '*';
  for (const item of splitTop(s)) {
    if (item === '*') {
      spec.star = true;
      continue;
    }
    const m = item.match(/^([A-Za-z_][A-Za-z0-9_]*)\(([\s\S]*)\)$/);
    if (m) {
      const rel = m[1];
      const fk = FOREIGN_KEYS[table]?.[rel];
      if (!fk) throw new DbUsageError(`unsupported embedded relation "${rel}" on "${table}"`);
      spec.embeds.push({ rel, fk, spec: parseSelect(m[2], rel) });
      continue;
    }
    if (IDENT_RE.test(item)) {
      spec.cols.push(item);
      continue;
    }
    throw new DbUsageError(`unsupported select item "${item.slice(0, 40)}"`);
  }
  if (!spec.star && spec.cols.length === 0 && spec.embeds.length === 0) spec.star = true;
  return spec;
}

function buildEmbed(e, parentAlias, ctx) {
  const a = `t${++ctx.n}`;
  const inner = e.spec;
  const pairs = [];
  for (const c of inner.cols) pairs.push(`'${c}', ${a}.${ident(c)}`);
  for (const ne of inner.embeds) pairs.push(`'${ne.rel}', ${buildEmbed(ne, a, ctx)}`);
  let obj;
  if (inner.star && pairs.length) obj = `to_jsonb(${a}) || jsonb_build_object(${pairs.join(', ')})`;
  else if (inner.star) obj = `to_jsonb(${a})`;
  else obj = `jsonb_build_object(${pairs.join(', ')})`;
  return `(SELECT ${obj} FROM ${ident(e.rel)} ${a} WHERE ${a}.id = ${parentAlias}.${ident(e.fk)})`;
}

function buildSelectList(spec, alias, ctx) {
  const items = [];
  if (spec.star) items.push(`${alias}.*`);
  for (const c of spec.cols) items.push(`${alias}.${ident(c)}`);
  for (const e of spec.embeds) items.push(`${buildEmbed(e, alias, ctx)} AS ${ident(e.rel)}`);
  return items.join(', ');
}

function returningSql(cols) {
  const spec = parseSelect(cols, '__none__');
  if (spec.embeds.length) throw new DbUsageError('embedded relations are not supported in returning()');
  const items = [];
  if (spec.star) items.push('*');
  for (const c of spec.cols) items.push(ident(c));
  return ` RETURNING ${items.join(', ')}`;
}

const SIMPLE_OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'ILIKE' };

function filterSql(f, params, alias) {
  if (f.op === 'not') return `NOT (${filterSql(f.inner, params, alias)})`;
  if (f.op === 'or') {
    if (!f.items.length) throw new DbUsageError('empty or()');
    return `(${f.items.map((i) => filterSql(i, params, alias)).join(' OR ')})`;
  }
  const col = alias ? `${alias}.${ident(f.col)}` : ident(f.col);
  const add = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.op === 'is') {
    if (f.val === null) return `${col} IS NULL`;
    if (f.val === true) return `${col} IS TRUE`;
    if (f.val === false) return `${col} IS FALSE`;
    throw new DbUsageError(`is() supports only null/true/false (column ${f.col})`);
  }
  if (f.val === undefined) {
    throw new DbUsageError(`undefined value in filter for column "${f.col}"`, 'FINNIK_UNDEFINED_VALUE');
  }
  if (f.op === 'in') {
    if (!Array.isArray(f.val)) throw new DbUsageError(`in() expects an array (column ${f.col})`);
    return `${col} = ANY(${add(f.val)})`;
  }
  const sqlOp = SIMPLE_OPS[f.op];
  if (!sqlOp) throw new DbUsageError(`unsupported filter operator "${f.op}"`);
  return `${col} ${sqlOp} ${add(f.val)}`;
}

function buildWhere(filters, params, alias) {
  if (!filters.length) return '';
  return ` WHERE ${filters.map((f) => filterSql(f, params, alias)).join(' AND ')}`;
}

// Разбор строки из .or('user_id.is.null,user_id.eq.123')
function parseOr(str) {
  const items = splitTop(String(str)).map((part) => {
    const m = part.match(/^([A-Za-z_][A-Za-z0-9_]*)\.(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike|is|in)\.([\s\S]*)$/);
    if (!m) throw new DbUsageError(`unsupported or() item "${part.slice(0, 60)}"`);
    const [, col, neg, op, raw] = m;
    let val;
    if (op === 'is') {
      if (raw === 'null') val = null;
      else if (raw === 'true') val = true;
      else if (raw === 'false') val = false;
      else throw new DbUsageError(`or(): is.${raw} is not supported`);
    } else if (op === 'in') {
      const m2 = raw.match(/^\(([\s\S]*)\)$/);
      if (!m2) throw new DbUsageError('or(): in must look like in.(a,b)');
      val = m2[1].split(',').map((s) => s.trim().replace(/^"(.*)"$/, '$1'));
    } else {
      val = raw;
    }
    const f = { col, op, val };
    return neg ? { op: 'not', inner: f } : f;
  });
  return { op: 'or', items };
}

function toInt(n, name) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 0) throw new DbUsageError(`${name} must be a non-negative integer`);
  return v;
}

class QueryBuilder {
  constructor(executor, table) {
    this._ex = executor;
    this._table = table;
    this._op = null; // 'select' | 'insert' | 'update' | 'delete' | 'upsert'
    this._cols = '*';
    this._returning = null;
    this._count = null;
    this._head = false;
    this._values = undefined;
    this._upsertOpts = {};
    this._filters = [];
    this._orders = [];
    this._limit = null;
    this._offset = null;
    this._single = null; // 'single' | 'maybe'
    this._promise = null;
  }

  select(cols, opts = {}) {
    if (!this._op) {
      this._op = 'select';
      this._cols = cols ?? '*';
      this._count = opts?.count ?? null;
      this._head = !!opts?.head;
    } else {
      this._returning = cols ?? '*';
    }
    return this;
  }
  insert(values) { this._op = 'insert'; this._values = values; return this; }
  update(values) { this._op = 'update'; this._values = values; return this; }
  upsert(values, opts = {}) { this._op = 'upsert'; this._values = values; this._upsertOpts = opts || {}; return this; }
  delete() { this._op = 'delete'; return this; }

  _f(col, op, val) { this._filters.push({ col, op, val }); return this; }
  eq(c, v) { return this._f(c, 'eq', v); }
  neq(c, v) { return this._f(c, 'neq', v); }
  gt(c, v) { return this._f(c, 'gt', v); }
  gte(c, v) { return this._f(c, 'gte', v); }
  lt(c, v) { return this._f(c, 'lt', v); }
  lte(c, v) { return this._f(c, 'lte', v); }
  like(c, v) { return this._f(c, 'like', v); }
  ilike(c, v) { return this._f(c, 'ilike', v); }
  is(c, v) { return this._f(c, 'is', v); }
  in(c, v) { return this._f(c, 'in', v); }
  match(obj) { for (const [k, v] of Object.entries(obj || {})) this._f(k, 'eq', v); return this; }
  not(c, op, v) { this._filters.push({ op: 'not', inner: { col: c, op, val: v } }); return this; }
  or(str) {
    try {
      this._filters.push(parseOr(str));
    } catch (e) {
      this._deferred = e;
    }
    return this;
  }

  order(col, opts = {}) {
    const asc = opts?.ascending !== false;
    let nulls = '';
    if (opts?.nullsFirst === true) nulls = ' NULLS FIRST';
    else if (opts?.nullsFirst === false) nulls = ' NULLS LAST';
    this._orders.push({ col, dir: asc ? 'ASC' : 'DESC', nulls });
    return this;
  }
  limit(n) { this._limit = n; return this; }
  range(from, to) { this._offset = from; this._limit = Number(to) - Number(from) + 1; return this; }
  single() { this._single = 'single'; return this; }
  maybeSingle() { this._single = 'maybe'; return this; }

  then(onFulfilled, onRejected) {
    if (!this._promise) this._promise = this._run();
    return this._promise.then(onFulfilled, onRejected);
  }
  catch(onRejected) { return this.then(undefined, onRejected); }
  finally(fn) { return this.then((v) => { fn?.(); return v; }, (e) => { fn?.(); throw e; }); }

  async _run() {
    try {
      if (this._deferred) throw this._deferred;
      if (!TABLES.has(this._table)) throw new DbUsageError(`unknown table "${this._table}"`, '42P01');
      const op = this._op || 'select';
      let rows = [];
      let count = null;

      if (op === 'select') {
        const spec = parseSelect(this._cols, this._table);
        const params = [];
        const ctx = { n: 0 };
        const list = buildSelectList(spec, 't0', ctx);
        const where = buildWhere(this._filters, params, 't0');
        if (this._count) {
          const cp = [];
          const cw = buildWhere(this._filters, cp, 't0');
          const cr = await this._ex.query(`SELECT count(*) AS c FROM ${ident(this._table)} t0${cw}`, cp);
          count = Number(cr.rows[0].c);
        }
        if (!this._head) {
          const order = this._orders.length
            ? ' ORDER BY ' + this._orders.map((o) => `t0.${ident(o.col)} ${o.dir}${o.nulls}`).join(', ')
            : '';
          let tail = '';
          if (this._limit !== null) tail += ` LIMIT ${toInt(this._limit, 'limit')}`;
          if (this._offset !== null) tail += ` OFFSET ${toInt(this._offset, 'offset')}`;
          const res = await this._ex.query(`SELECT ${list} FROM ${ident(this._table)} t0${where}${order}${tail}`, params);
          rows = res.rows;
        } else {
          return { data: null, error: null, count, status: 200, statusText: 'OK' };
        }
      } else {
        const ret = this._returning ? returningSql(this._returning) : '';
        const { text, params } = this._mutationSql(op, ret);
        if (text === null) {
          rows = [];
        } else {
          const res = await this._ex.query(text, params);
          rows = res.rows;
        }
        if (!this._returning) {
          return { data: null, error: null, count: null, status: op === 'delete' || op === 'update' ? 204 : 201, statusText: 'OK' };
        }
      }

      if (this._single === 'single') {
        if (rows.length !== 1) return this._notSingle(rows.length);
        return { data: rows[0], error: null, count, status: 200, statusText: 'OK' };
      }
      if (this._single === 'maybe') {
        if (rows.length > 1) return this._notSingle(rows.length);
        return { data: rows[0] ?? null, error: null, count, status: 200, statusText: 'OK' };
      }
      return { data: rows, error: null, count, status: 200, statusText: 'OK' };
    } catch (e) {
      if (!(e instanceof DbUsageError)) console.error('[db] query error:', e?.code || '', e?.message);
      return { data: null, error: toError(e), count: null, status: 400, statusText: 'Bad Request' };
    }
  }

  _notSingle(n) {
    return {
      data: null,
      error: {
        name: 'PostgrestError',
        message: 'JSON object requested, multiple (or no) rows returned',
        code: 'PGRST116',
        details: `The result contains ${n} rows`,
        hint: null,
      },
      count: null,
      status: 406,
      statusText: 'Not Acceptable',
    };
  }

  _mutationSql(op, returning) {
    const t = ident(this._table);
    const params = [];

    if (op === 'insert' || op === 'upsert') {
      const isArr = Array.isArray(this._values);
      const rows = isArr ? this._values : [this._values];
      if (rows.length === 0) return { text: null, params };
      if (rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) throw new DbUsageError('insert expects an object or an array of objects');
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => r[k] !== undefined)))];
      let text;
      if (cols.length === 0) {
        if (rows.length !== 1) throw new DbUsageError('insert of several empty rows is not supported');
        text = `INSERT INTO ${t} DEFAULT VALUES`;
      } else {
        const tuples = rows.map((r) => {
          const ph = cols.map((c) => {
            params.push(r[c] === undefined ? null : r[c]);
            return `$${params.length}`;
          });
          return `(${ph.join(', ')})`;
        });
        text = `INSERT INTO ${t} (${cols.map(ident).join(', ')}) VALUES ${tuples.join(', ')}`;
      }
      if (op === 'upsert') {
        const conflict = String(this._upsertOpts.onConflict || 'id').split(',').map((s) => s.trim()).filter(Boolean);
        const setCols = cols.filter((c) => !conflict.includes(c));
        text += ` ON CONFLICT (${conflict.map(ident).join(', ')}) `;
        if (this._upsertOpts.ignoreDuplicates || setCols.length === 0) text += 'DO NOTHING';
        else text += `DO UPDATE SET ${setCols.map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(', ')}`;
      }
      return { text: text + returning, params };
    }

    if (op === 'update') {
      const v = this._values;
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new DbUsageError('update expects an object');
      const cols = Object.keys(v).filter((k) => v[k] !== undefined);
      if (!cols.length) throw new DbUsageError('update with no columns');
      if (!this._filters.length) throw new DbUsageError('UPDATE requires a WHERE clause', 'FINNIK_UNSAFE');
      const sets = cols.map((c) => {
        params.push(v[c]);
        return `${ident(c)} = $${params.length}`;
      });
      const where = buildWhere(this._filters, params, '');
      return { text: `UPDATE ${t} SET ${sets.join(', ')}${where}${returning}`, params };
    }

    if (op === 'delete') {
      if (!this._filters.length) throw new DbUsageError('DELETE requires a WHERE clause', 'FINNIK_UNSAFE');
      const where = buildWhere(this._filters, params, '');
      return { text: `DELETE FROM ${t}${where}${returning}`, params };
    }

    throw new DbUsageError(`unsupported operation "${op}"`);
  }
}

// executor: { query(text, params) => Promise<{ rows }> }
export function createDbFromExecutor(executor) {
  return {
    from(table) {
      return new QueryBuilder(executor, table);
    },
  };
}

export function createPgDb(connectionString, opts = {}) {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 20000,
    types: { getTypeParser: (oid, format) => PARSERS[oid] ?? pg.types.getTypeParser(oid, format) },
  });
  pool.on('error', (e) => console.error('[db] pool error:', e.message));
  const db = createDbFromExecutor({ query: (text, params) => pool.query(text, params) });
  db.ping = async () => {
    await pool.query('select 1');
    return true;
  };
  db.end = () => pool.end();
  return db;
}
