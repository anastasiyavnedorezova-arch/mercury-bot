// Патч 51 (27.10.2026): личная память фраз, запись неизвестных слов в «Остальное», вопрос после исправления категории.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { makeDb } from './helpers/testDb.mjs';
import { memoryKey, memoryNote, rememberPhrase, recallPhrase } from '../src/utils/phraseMemory.js';
import { buildConfirmationText, UNCERTAIN_NOTE } from '../src/utils/botTexts.js';
import { linkTelegram, createLinkToken } from '../src/accounts/linkTelegram.js';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:1/test';
process.env.OPENAI_API_KEY ||= 'test-key';
const { learnFromCorrection } = await import('../src/handlers/transaction.js');
const { maybeAskToLearn } = await import('../src/handlers/learn.js');
const { getSystemPrompt } = await import('../src/prompts/system_prompt.js');
const { RETRY_HINT } = await import('../src/utils/llmRetry.js');

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const uid = () => crypto.randomUUID();
let ctx; let db; let seq = 0;
before(async () => { ctx = await makeDb(); db = ctx.db; });
after(async () => { await ctx.close(); });

async function tgUser(extra = {}) {
  seq += 1;
  const id = uid();
  const { error } = await db.from('users').insert({ id, external_id: String(700000 + seq), channel: 'telegram', tg_username: 'u' + seq, ...extra });
  assert.ifError(error);
  return id;
}
const fakeBot = () => {
  const sent = [];
  return { sent, isWeb: false, sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); }, answerCallbackQuery: async () => {} };
};
const rows = async (userId) => (await db.from('user_phrases').select('*').eq('user_id', userId)).data;

test('ключ фразы: только слова, без суммы; фразы без одной суммы не запоминаются', () => {
  assert.equal(memoryKey('вкладыши 100'), 'вкладыши');
  assert.equal(memoryKey('100 Вкладыши'), 'вкладыши');
  assert.equal(memoryKey('Вкладыши 1 500 ₽'), memoryKey('вкладыши 1500'));
  assert.equal(memoryKey('кофе 200 хлеб 100'), null);
  assert.equal(memoryKey('500'), null);
  assert.equal(memoryKey('просто слова'), null);
});

test('запомнили → в следующий раз та же фраза с другой суммой узнаётся', async () => {
  const u = await tgUser();
  assert.equal(await rememberPhrase(db, u, 'вкладыши 100', { type: 'expense', category: 'Остальное' }), 'вкладыши');
  const r = await recallPhrase(db, u, 'Вкладыши 2500', '2026-10-27');
  assert.equal(r.type, 'expense'); assert.equal(r.amount, 2500); assert.equal(r.category, 'Остальное');
  assert.equal(r.transaction_date, '2026-10-27'); assert.equal(r.confidence, 'high');
  assert.deepEqual(r.remembered, { words: 'Вкладыши', category: 'Остальное' });
  assert.equal(await recallPhrase(db, u, 'вкладыши', '2026-10-27'), null, 'без суммы не записываем');
  assert.equal(await recallPhrase(db, u, 'наклейки 100', '2026-10-27'), null, 'другая фраза не узнаётся');
});

test('память одного человека не видна другому, одна и та же фраза хранится у каждого со своей категорией', async () => {
  const a = await tgUser(); const b = await tgUser(); const c = await tgUser();
  await rememberPhrase(db, a, 'наклейки 230', { type: 'expense', category: 'Дети' });
  await rememberPhrase(db, b, 'наклейки 50', { type: 'expense', category: 'Подарки другим' });
  assert.equal((await recallPhrase(db, a, 'наклейки 1', 'd')).category, 'Дети');
  assert.equal((await recallPhrase(db, b, 'наклейки 1', 'd')).category, 'Подарки другим');
  assert.equal(await recallPhrase(db, c, 'наклейки 1', 'd'), null, 'у третьего человека памяти нет');
  assert.equal(await recallPhrase(db, null, 'наклейки 1', 'd'), null);
  assert.equal((await rows(a)).length, 1); assert.equal((await rows(b)).length, 1);
});

test('новый выбор перезаписывает старый, строка остаётся одна', async () => {
  const u = await tgUser();
  await rememberPhrase(db, u, 'щётка 100', { type: 'expense', category: 'Остальное' });
  await rememberPhrase(db, u, 'щётка 300', { type: 'expense', category: 'Красота и уход за собой' });
  const r = await rows(u);
  assert.equal(r.length, 1); assert.equal(r[0].category, 'Красота и уход за собой');
  assert.equal((await recallPhrase(db, u, 'щётка 5', 'd')).category, 'Красота и уход за собой');
});

test('бессмыслицу, чужой язык, команды и неверный тип не запоминаем; ошибки не бросаются', async () => {
  const u = await tgUser();
  for (const t of ['ыыыыы 100', 'йцукен 100', 'zqef 100', 'ghbdtn 500', '/start 100', 'сколько потратил 100?']) {
    assert.equal(await rememberPhrase(db, u, t, { type: 'expense', category: 'Остальное' }), null, t);
  }
  assert.equal(await rememberPhrase(db, u, 'вкладыши 100', { type: 'goal', category: 'Цель' }), null);
  assert.equal(await rememberPhrase(db, u, 'вкладыши 100', { type: 'expense', category: '' }), null);
  assert.equal((await rows(u)).length, 0);
  const broken = { from() { throw new Error('boom'); } };
  const origErr = console.error; console.error = () => {};
  try {
    assert.equal(await rememberPhrase(broken, u, 'вкладыши 100', { type: 'expense', category: 'Остальное' }), null);
    assert.equal(await recallPhrase(broken, u, 'вкладыши 100', 'd'), null);
  } finally { console.error = origErr; }
});

test('память стирается вместе с аккаунтом', async () => {
  const u = await tgUser();
  await rememberPhrase(db, u, 'вкладыши 100', { type: 'expense', category: 'Остальное' });
  await ctx.query('DELETE FROM public.users WHERE id = $1', [u]);
  assert.equal((await rows(u)).length, 0);
});

test('объединение аккаунтов: память и сигналы переходят к аккаунту с сайта, при совпадении фразы остаётся запись сайта', async () => {
  seq += 1;
  const x = uid();
  await db.from('users').insert({ id: x, external_id: x, channel: 'web', email: `m${seq}@t.ru`, password_hash: 'x', terms_accepted_at: new Date().toISOString() });
  const tg = 800000 + seq;
  const y = uid();
  await db.from('users').insert({ id: y, external_id: String(tg), channel: 'telegram', tg_username: 'u' + tg, terms_accepted_at: new Date().toISOString() });
  await rememberPhrase(db, x, 'наклейки 1', { type: 'expense', category: 'Дети' });
  await rememberPhrase(db, y, 'наклейки 2', { type: 'expense', category: 'Подарки другим' });
  await rememberPhrase(db, y, 'вкладыши 3', { type: 'expense', category: 'Остальное' });
  await db.from('recognition_signals').insert({ user_id: y, phrase: 'вкладыши 3', phrase_norm: 'вкладыши', type: 'expense', category: 'Остальное', amount: 3 });

  const { token } = await createLinkToken(db, x);
  const r = await linkTelegram(db, { token, telegramId: tg, tgUsername: 'ann' });
  assert.equal(r.ok, true);
  assert.equal(r.merged, true);

  const mem = Object.fromEntries((await rows(x)).map((p) => [p.phrase_norm, p.category]));
  assert.deepEqual(mem, { наклейки: 'Дети', вкладыши: 'Остальное' });
  assert.equal((await rows(y)).length, 0);
  const sig = (await db.from('recognition_signals').select('user_id').eq('phrase_norm', 'вкладыши')).data;
  assert.ok(sig.length >= 1 && sig.every((s) => s.user_id === x));
});

test('тексты: «не знаю, куда отнести» и «записал по твоей памяти» показываются только когда нужно', () => {
  const base = { type: 'expense', amount: 230, category: 'Остальное', transaction_date: '2026-10-27' };
  assert.ok(!buildConfirmationText(base).includes('Не знаю, куда'));
  assert.ok(buildConfirmationText({ ...base, uncertain: true }).includes(UNCERTAIN_NOTE));
  assert.ok(UNCERTAIN_NOTE.includes('Исправить'));
  const t = buildConfirmationText({ ...base, remembered: { words: 'Вкладыши', category: 'Остальное' } });
  assert.ok(t.includes('💡 Записал по твоей памяти: «Вкладыши» → «Остальное»'));
  assert.ok(!t.includes('Не знаю, куда'));
  assert.equal(memoryNote('вкладыши 100', 'Остальное'), 'Запомнил: «вкладыши» → «Остальное», в следующий раз запишу так же 😉');
  for (const s of [UNCERTAIN_NOTE, memoryNote('вкладыши 100', 'Остальное')]) assert.ok(!/\bвы\b|ите\b|ете\b/i.test(s), s);
});

test('исправление категории: запоминаем, а если запись была в «Остальном» — спрашиваем про передачу', async () => {
  const u = await tgUser(); const bot = fakeBot();
  const before = { raw_message: 'вкладыши 100', type: 'expense', amount: 100, categories: { name: 'Остальное' } };
  await learnFromCorrection(bot, 5, u, before, { name: 'Дети', type: 'expense' }, db);
  assert.equal(bot.sent.length, 2);
  assert.match(bot.sent[0].text, /^Запомнил: «вкладыши» → «Дети»/);
  assert.match(bot.sent[1].text, /разработчик/i);
  assert.equal((await recallPhrase(db, u, 'вкладыши 7', 'd')).category, 'Дети');
  const sig = (await db.from('recognition_signals').select('category, answer').eq('user_id', u)).data;
  assert.deepEqual(sig, [{ category: 'Дети', answer: 'asked' }]);
});

test('исправление категории: из другой категории — только запоминаем; та же категория, чужой тип, несколько сумм — ничего', async () => {
  const u = await tgUser(); const bot = fakeBot();
  await learnFromCorrection(bot, 5, u, { raw_message: 'бахилы 300', type: 'expense', amount: 300, categories: { name: 'Продукты' } }, { name: 'Здоровье', type: 'expense' }, db);
  assert.equal(bot.sent.length, 1);
  assert.equal((await db.from('recognition_signals').select('id').eq('user_id', u)).data.length, 0);

  const b2 = fakeBot();
  await learnFromCorrection(b2, 5, u, { raw_message: 'бахилы 300', type: 'expense', amount: 300, categories: { name: 'Остальное' } }, { name: 'Остальное', type: 'expense' }, db);
  await learnFromCorrection(b2, 5, u, { raw_message: 'бахилы 300', type: 'expense', amount: 300, categories: { name: 'Остальное' } }, { name: 'Зарплата', type: 'income' }, db);
  await learnFromCorrection(b2, 5, u, { raw_message: 'кофе 200 хлеб 100', type: 'expense', amount: 200, categories: { name: 'Остальное' } }, { name: 'Продукты', type: 'expense' }, db);
  await learnFromCorrection(b2, 5, u, { raw_message: null, type: 'expense', amount: 200, categories: { name: 'Остальное' } }, { name: 'Продукты', type: 'expense' }, db);
  assert.equal(b2.sent.length, 0);
});

test('если не спрашиваем из-за уже отправленной фразы — это пишется в лог с причиной', async () => {
  const a = await tgUser(); const b = await tgUser();
  await db.from('recognition_signals').insert({ user_id: a, phrase: 'вкладыши 100', phrase_norm: 'вкладыши', type: 'expense', category: 'Дети', amount: 100, answer: 'sent' });
  const lines = []; const orig = console.log; console.log = (...x) => lines.push(x.join(' '));
  let res;
  try { res = await maybeAskToLearn(fakeBot(), 1, { userId: b, learn: { text: 'вкладыши 100', reason: null }, parsed: { type: 'expense', category: 'Дети', amount: 100 } }, db); } finally { console.log = orig; }
  assert.equal(res, 'skip:already_sent');
  assert.ok(lines.some((l) => l.includes('[learn] не спрашиваем: already_sent')), lines.join('|'));
});

test('промпт: настоящее слово без категории — «Остальное» с низкой уверенностью, error только для бессмыслицы', () => {
  const p = getSystemPrompt([]);
  assert.ok(p.includes('Не возвращай error для настоящих слов'));
  assert.ok(p.includes('"confidence":"low"'));
  assert.ok(!p.includes('unknown_item'));
  assert.ok(p.includes('Пользователь: "наклейки 230"'));
  assert.ok(RETRY_HINT.includes('Остальное'));
});

test('подключение в коде: память читается раньше справочника, запоминание после ручного ввода, очистка и перенос', () => {
  const msg = read('src/handlers/message.js');
  assert.ok(msg.indexOf('recallPhrase(supabase') < msg.indexOf('quickParse(effectiveText'));
  assert.ok(msg.includes('rememberPhrase(supabase, userId, state.learn.text, parsed)'));
  assert.ok(msg.includes("parsed.category === 'Остальное' && parsed.confidence === 'low'"));
  assert.ok(read('src/handlers/transaction.js').includes('await learnFromCorrection(bot, chatId, userId, before, picked)'));
  const sch = read('src/notifications/scheduler.js');
  assert.ok(sch.includes("from('user_phrases').delete()") && sch.includes("from('recognition_signals').delete()"));
  const link = read('src/accounts/linkTelegram.js');
  assert.ok(link.includes('UPDATE public.user_phrases SET user_id = $2') && link.includes('UPDATE public.recognition_signals SET user_id = $2'));
  assert.ok(read('db/migrations/012_user_phrases.sql').includes('PRIMARY KEY (user_id, phrase_norm)'));
});
