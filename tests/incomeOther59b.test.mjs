// Патч 59б (30.10.2026): системная категория доходов «Другие доходы». Раньше непонятное пополнение
// уходило в расходную «Остальное» (доход с расходной категорией).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { makeDb } from './helpers/testDb.mjs';
import { INCOME_CATEGORIES, EXPENSE_CATEGORIES, INCOME_FALLBACK_CATEGORY, incomeCategoryFor, refineStatementItem } from '../src/utils/categoryHints.js';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:1/test';
process.env.OPENAI_API_KEY ||= 'test-key';
const { getStatementPrompt, applyStatementCorrectionsDetailed } = await import('../src/handlers/fileUpload.js');
const { getSystemPrompt } = await import('../src/prompts/system_prompt.js');

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const uid = () => crypto.randomUUID();
const MIGRATION_STATEMENTS = read('db/data/014_income_other.sql')
  .split('\n').filter((l) => !l.startsWith('--')).join('\n')
  .split(';').map((x) => x.trim()).filter((x) => x && x !== 'BEGIN' && x !== 'COMMIT');
const runMigration = async () => { for (const st of MIGRATION_STATEMENTS) await ctx.query(st); };

let ctx;
before(async () => { ctx = await makeDb(); });
after(async () => { await ctx?.close(); });

const count = async (sql) => Number((await ctx.query(sql)).rows[0].n);

test('данные 014: создаёт группу и системную категорию доходов, повторный запуск ничего не дублирует', async () => {
  const catSql = "SELECT count(*) AS n FROM public.categories WHERE user_id IS NULL AND name = 'Другие доходы' AND type = 'income' AND is_system AND is_active";
  const grpSql = "SELECT count(*) AS n FROM public.category_groups WHERE type = 'income' AND name = 'Другое'";
  assert.equal(await count(catSql), 0); // тестовая база пустая: файл лежит в db/data, а не в db/migrations
  await runMigration();
  assert.equal(await count(catSql), 1);
  assert.equal(await count(grpSql), 1);
  await runMigration();
  await runMigration();
  assert.equal(await count(catSql), 1);
  assert.equal(await count(grpSql), 1);
});

test('данные 014: доходы в расходной «Остальное» переезжают, расходы и чужие категории не трогаются', async () => {
  const gExp = uid(); const oth = uid(); const user = uid();
  await ctx.query("INSERT INTO public.category_groups (id, name, type, sort_order) VALUES ($1, 'Другое', 'expense', 9)", [gExp]);
  await ctx.query("INSERT INTO public.categories (id, group_id, name, type, is_system) VALUES ($1, $2, 'Остальное', 'expense', true)", [oth, gExp]);
  await ctx.query("INSERT INTO public.users (id, external_id, channel, email) VALUES ($1::uuid, $1::text, 'web', $2)", [user, `${user}@t.ru`]);
  const incTx = uid(); const expTx = uid();
  await ctx.query("INSERT INTO public.transactions (id, user_id, category_id, type, amount, transaction_date) VALUES ($1, $2, $3, 'income', 8000, '2026-10-12')", [incTx, user, oth]);
  await ctx.query("INSERT INTO public.transactions (id, user_id, category_id, type, amount, transaction_date) VALUES ($1, $2, $3, 'expense', 99, '2026-10-12')", [expTx, user, oth]);
  await runMigration();
  const inc = (await ctx.query("SELECT c.name FROM public.transactions t JOIN public.categories c ON c.id = t.category_id WHERE t.id = $1", [incTx])).rows[0];
  const exp = (await ctx.query("SELECT c.name FROM public.transactions t JOIN public.categories c ON c.id = t.category_id WHERE t.id = $1", [expTx])).rows[0];
  assert.equal(inc.name, 'Другие доходы');
  assert.equal(exp.name, 'Остальное');
});

test('доход без подходящей категории получает «Другие доходы», расход остаётся в «Остальное»', () => {
  assert.equal(INCOME_FALLBACK_CATEGORY, 'Другие доходы');
  assert.ok(INCOME_CATEGORIES.includes('Другие доходы'));
  assert.ok(!EXPENSE_CATEGORIES.includes('Другие доходы'));
  assert.equal(incomeCategoryFor('income', 'Остальное'), 'Другие доходы');
  assert.equal(incomeCategoryFor('income', 'Другое'), 'Другие доходы');
  assert.equal(incomeCategoryFor('income', 'Зарплата'), 'Зарплата');
  assert.equal(incomeCategoryFor('expense', 'Остальное'), 'Остальное');
  const tx = { amount: 500, type: 'income', category: 'Остальное', description: 'Пополнение' };
  assert.equal(refineStatementItem(tx).category, 'Другие доходы');
  assert.equal(refineStatementItem({ ...tx, category: 'Зарплата' }).category, 'Зарплата');
  assert.equal(refineStatementItem({ ...tx, type: 'expense' }).category, 'Остальное');
  assert.match(read('src/handlers/message.js'), /parsed\.category = incomeCategoryFor\(parsed\.type, parsed\.category\)/);
});

test('подсказки модели: непонятный доход — «Другие доходы», а не «Остальное»', () => {
  const sp = getStatementPrompt();
  assert.match(sp, /Другие доходы/);
  assert.match(sp, /Для ДОХОДА[^.]*«Другие доходы», никогда не «Остальное»/);
  const sys = getSystemPrompt();
  assert.match(sys, /- Другие доходы \(/);
  assert.match(sys, /для дохода НИКОГДА не используй «Остальное»/);
});

test('«всё остальное в категорию» берёт и строки «Другие доходы»', () => {
  const pending = [
    { amount: 1, type: 'income', category: 'Другие доходы' },
    { amount: 2, type: 'income', category: 'Зарплата' },
  ];
  const r = applyStatementCorrectionsDetailed(pending, { applyToAll: { category: 'Подарки мне' } });
  assert.deepEqual(r.updated.map((t) => t.category), ['Подарки мне', 'Зарплата']);
});

test('категория есть во всех списках бота и кабинета', () => {
  assert.match(read('src/handlers/message.js'), /'Другое': \['Другие доходы'\]/);
  assert.match(read('src/handlers/categories.js'), /<b>Другое:<\/b> Другие доходы/);
  assert.match(read('public/cabinet/history.html'), /'Другие доходы':'➕'/);
  assert.match(read('public/cabinet/history.html'), /ALL_INCOME_CATS = \[[^\]]*'Другие доходы'\]/);
  assert.match(read('public/cabinet/dashboard.html'), /'Другие доходы':\s+'➕'/);
});
