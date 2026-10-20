// Дневной лимит запросов к ИИ: на человека, общий предохранитель, вес запросов, откат, сбой базы, подключение к обработчикам.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeDb } from './helpers/testDb.mjs';
import { reserveAi, aiLimitsConfig, aiLimitText, denyAi, AI_WEIGHTS } from '../src/utils/aiLimit.js';

let ctx; let db;
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const quiet = { warn() {}, error() {}, log() {} };
const opts = (env) => ({ env, logger: quiet });
before(async () => { ctx = await makeDb(); db = ctx.db; });
after(async () => { await ctx?.close(); });
const used = async (subject) => Number((await ctx.query(`SELECT coalesce(sum(requests),0) AS n FROM public.ai_usage WHERE subject = $1`, [subject])).rows[0].n);

test('настройки: 50 на человека и 3000 всего по умолчанию, из env можно поменять, мусор игнорируется', () => {
  assert.deepEqual(aiLimitsConfig({}), { off: false, perUser: 50, global: 3000 });
  assert.deepEqual(aiLimitsConfig({ AI_DAILY_LIMIT: '20', AI_GLOBAL_DAILY_LIMIT: '500', AI_LIMITS: 'off' }), { off: true, perUser: 20, global: 500 });
  assert.equal(aiLimitsConfig({ AI_DAILY_LIMIT: 'abc' }).perUser, 50);
  assert.equal(aiLimitsConfig({ AI_DAILY_LIMIT: '-3' }).perUser, 50);
});

test('человек: пропускает ровно до лимита, дальше отказ, счётчик не растёт сверх лимита', async () => {
  const env = { AI_DAILY_LIMIT: '5', AI_GLOBAL_DAILY_LIMIT: '1000' };
  for (let i = 1; i <= 5; i++) {
    const r = await reserveAi(db, 'u-limit', 'text', opts(env));
    assert.equal(r.ok, true); assert.equal(r.used, i);
  }
  const r = await reserveAi(db, 'u-limit', 'text', opts(env));
  assert.deepEqual([r.ok, r.reason, r.limit], [false, 'user', 5]);
  assert.equal(await used('u-limit'), 5);
});

test('другой человек считается отдельно', async () => {
  const env = { AI_DAILY_LIMIT: '2', AI_GLOBAL_DAILY_LIMIT: '1000' };
  await reserveAi(db, 'u-a', 'text', opts(env)); await reserveAi(db, 'u-a', 'text', opts(env));
  assert.equal((await reserveAi(db, 'u-a', 'text', opts(env))).ok, false);
  assert.equal((await reserveAi(db, 'u-b', 'text', opts(env))).ok, true);
});

test('вес: голосовое = 2, выписка по фото = 5; запрос тяжелее остатка не проходит и ничего не списывает', async () => {
  assert.deepEqual([AI_WEIGHTS.text, AI_WEIGHTS.faq, AI_WEIGHTS.correction, AI_WEIGHTS.voice, AI_WEIGHTS.statement], [1, 1, 1, 2, 5]);
  const env = { AI_DAILY_LIMIT: '6', AI_GLOBAL_DAILY_LIMIT: '1000' };
  assert.equal((await reserveAi(db, 'u-w', 'statement', opts(env))).used, 5);
  assert.equal((await reserveAi(db, 'u-w', 'voice', opts(env))).ok, false);   // 5 + 2 > 6
  assert.equal(await used('u-w'), 5);
  assert.equal((await reserveAi(db, 'u-w', 'text', opts(env))).used, 6);
  const tooHeavy = await reserveAi(db, 'u-heavy', 'statement', opts({ AI_DAILY_LIMIT: '3', AI_GLOBAL_DAILY_LIMIT: '1000' }));
  assert.equal(tooHeavy.ok, false);                                            // даже первый запрос тяжелее всего лимита
  assert.equal(await used('u-heavy'), 0);
});

test('общий предохранитель: при исчерпании блокирует всех, а счётчик человека откатывается', async () => {
  const before = await used('*');
  const env = { AI_DAILY_LIMIT: '50', AI_GLOBAL_DAILY_LIMIT: String(before + 2) };
  assert.equal((await reserveAi(db, 'g-1', 'text', opts(env))).ok, true);
  assert.equal((await reserveAi(db, 'g-2', 'text', opts(env))).ok, true);
  const r = await reserveAi(db, 'g-3', 'text', opts(env));
  assert.deepEqual([r.ok, r.reason], [false, 'global']);
  assert.equal(await used('g-3'), 0, 'счётчик человека откатился');
  assert.equal(await used('*'), before + 2);
});

test('сутки по Москве: вчерашний счётчик не мешает', async () => {
  await ctx.query(`INSERT INTO public.ai_usage (subject, day, requests) VALUES ('u-old', (now() AT TIME ZONE 'Europe/Moscow')::date - 1, 50)`);
  assert.equal((await reserveAi(db, 'u-old', 'text', opts({ AI_DAILY_LIMIT: '50', AI_GLOBAL_DAILY_LIMIT: '100000' }))).ok, true);
});

test('сбой базы: человека не блокируем, ошибка пишется в лог', async () => {
  const errors = [];
  const broken = { transaction: async () => { throw new Error('db down'); } };
  const r = await reserveAi(broken, 'u-x', 'text', { env: {}, logger: { warn() {}, error: (...a) => errors.push(a.join(' ')) } });
  assert.equal(r.ok, true); assert.equal(r.failOpen, true);
  assert.match(errors[0], /db down/);
});

test('AI_LIMITS=off полностью отключает проверку', async () => {
  const r = await reserveAi(db, 'u-off', 'text', opts({ AI_LIMITS: 'off', AI_DAILY_LIMIT: '1' }));
  assert.equal(r.ok, true); assert.equal(r.skipped, true);
  assert.equal(await used('u-off'), 0);
});

test('текст отказа: без слов про лимиты и сутки, одинаковый для человека и для общего предела, с кнопкой ручной записи', async () => {
  const user = aiLimitText({ reason: 'user', limit: 50 });
  assert.equal(user, aiLimitText({ reason: 'global', limit: 3000 }));
  assert.equal(user, 'Ой, мне надо немного отдохнуть 😔 Пока я перезагружаюсь, добавь запись вручную, пожалуйста 🙏');
  assert.doesNotMatch(user, /лимит|сутк|\d|полноч/i);
  const sent = [];
  await denyAi({ sendMessage: async (...a) => sent.push(a) }, 7, { reason: 'user', limit: 50 });
  assert.equal(sent[0][0], 7);
  assert.equal(sent[0][1], user);
  assert.equal(sent[0][2].reply_markup.inline_keyboard[0][0].callback_data, 'manual:start');
  assert.match(sent[0][2].reply_markup.inline_keyboard[0][0].text, /вручную/);
});

test('подключено: текст, FAQ, голос, выписка и правки выписки проходят через лимит; у ответов ИИ есть потолок длины', () => {
  const msg = read('src/handlers/message.js');
  assert.match(msg, /reserveAi\(supabase, telegramId, 'text'\)/);
  assert.match(msg, /reserveAi\(supabase, telegramId, 'faq'\)/);
  assert.match(msg, /msg\.fromVoice/);
  assert.equal((msg.match(/max_tokens:/g) || []).length, 2);
  assert.match(read('src/handlers/voice.js'), /reserveAi\(supabase, msg\.from\.id, 'voice'\)/);
  assert.match(read('src/handlers/voice.js'), /fromVoice: true/);
  const file = read('src/handlers/fileUpload.js');
  assert.match(file, /reserveAi\(supabase, telegramId, 'statement'\)/);
  assert.match(file, /reserveAi\(supabase, telegramId, 'correction'\)/);
});

test('миграция 008 создаёт таблицу счётчиков', () => {
  assert.match(read('db/migrations/008_ai_usage.sql'), /CREATE TABLE IF NOT EXISTS public\.ai_usage/);
});
