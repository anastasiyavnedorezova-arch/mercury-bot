// Патч 50 (27.10.2026): «научи бота». Спрашиваем только про настоящие слова, которых бот не знает; ответы пишутся в базу и уходят администратору.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { makeDb } from './helpers/testDb.mjs';
import {
  analyzePhrase, phraseKey, rememberUnrecognized, clearUnrecognized, takeUnrecognized, REMEMBER_MS,
  LEARN_ASK_TEXT, LEARN_THANKS_TEXT, LEARN_DECLINED_TEXT, learnKeyboard,
} from '../src/utils/learnSignal.js';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:1/test';
process.env.OPENAI_API_KEY ||= 'test-key';
const { maybeAskToLearn, handleLearnCallback, learnSignalText } = await import('../src/handlers/learn.js');
const { getSystemPrompt } = await import('../src/prompts/system_prompt.js');

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let ctx; let db;
before(async () => { ctx = await makeDb(); db = ctx.db; });
after(async () => { await ctx.close(); });

async function newUser(tg = String(Math.floor(Math.random() * 1e9)), name = 'ivan') {
  const id = crypto.randomUUID();
  await ctx.query("INSERT INTO public.users (id, external_id, channel, tg_username) VALUES ($1, $2, 'telegram', $3)", [id, tg, name]);
  return { id, tg };
}
const fakeBot = () => {
  const sent = [];
  return { sent, isWeb: false, sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); }, answerCallbackQuery: async () => {} };
};
const manual = { type: 'expense', category: 'Здоровье', amount: 300 };
const rows = async () => (await ctx.query('SELECT * FROM public.recognition_signals ORDER BY created_at')).rows;

test('про что НЕ спрашиваем: бессмыслица, чужой язык, раскладка, одна сумма, опечатки по версии ИИ, вопросы', () => {
  const no = (t, why, reason) => { const r = analyzePhrase(t, reason); assert.equal(r.ok, false, t); assert.equal(r.why, why, t); };
  no('ффффф 300', 'gibberish');
  no('йцукен 500', 'gibberish');
  no('лдлдл 500', 'gibberish');
  no('ку 200', 'gibberish');
  no('ghbdtn 300', 'foreign');
  no('zara 4000', 'foreign');
  no('rjgbk 3000 фыв', 'layout');
  no('300', 'no_word');
  no('1 500 р', 'no_word');
  no('', 'empty');
  no('/start', 'command');
  no('что это значит 300?', 'question');
  no('rjафе 300', 'mixed_alphabet');
  no('слово '.repeat(10) + '300', 'too_long');
  no('x'.repeat(120), 'too_long');
  no('кафэ 300', 'ai_typo', 'typo');
  no('абракадабра 3400', 'ai_gibberish', 'gibberish');
  no('hello', 'foreign', 'foreign');
  no('бахилы 300', 'ai_other', 'other');
});

test('про что спрашиваем: настоящие слова и названия, в том числе без причины от ИИ', () => {
  for (const [t, reason] of [['бахилы 300', 'unknown_item'], ['бахилы 300', undefined], ['бахилы 300', null], ['маникюрша Оля 2000', ''],
    ['самокат электрический 15000', 'unknown_item'], ['300 Нью-Йорк', 'unknown_item'], ['uber такси 500', 'unknown_item']]) {
    assert.deepEqual(analyzePhrase(t, reason), { ok: true }, t);
  }
});

test('phraseKey: слова без сумм, регистр и ё не важны', () => {
  assert.equal(phraseKey('Бахилы 300 ₽'), 'бахилы');
  assert.equal(phraseKey('  ЁЛКА   1 500 '), 'елка');
  assert.equal(phraseKey('300'), '');
  assert.equal(phraseKey('бахилы 300 р'), 'бахилы');
  assert.equal(phraseKey('бахилы 5 тыс.'), 'бахилы');
});

test('память о нераспознанной фразе: хранится 15 минут, забирается один раз, сбрасывается', () => {
  rememberUnrecognized(1, { text: 'бахилы 300', reason: 'unknown_item' }, 1000);
  assert.deepEqual(takeUnrecognized(1, 1000 + 5000), { text: 'бахилы 300', reason: 'unknown_item', at: 1000 });
  assert.equal(takeUnrecognized(1, 1000 + 6000), null);
  rememberUnrecognized(2, { text: 'бахилы 300' }, 1000);
  assert.equal(takeUnrecognized(2, 1000 + REMEMBER_MS + 1), null);
  rememberUnrecognized(3, { text: 'бахилы 300' }, 1000);
  clearUnrecognized(3);
  assert.equal(takeUnrecognized(3, 1001), null);
  rememberUnrecognized('4', { text: 'a' }, 1000);
  assert.ok(takeUnrecognized(4, 1001));
});

test('вопрос после ручной записи: строка в базе, текст и две кнопки', async () => {
  const u = await newUser();
  const bot = fakeBot();
  const res = await maybeAskToLearn(bot, 77, { userId: u.id, learn: { text: 'бахилы 300', reason: 'unknown_item' }, parsed: manual }, db);
  assert.equal(res, 'asked');
  assert.equal(bot.sent.length, 1);
  assert.equal(bot.sent[0].chatId, 77);
  assert.equal(bot.sent[0].text, LEARN_ASK_TEXT('бахилы 300'));
  assert.ok(!/5 дней|бонус|доступ/i.test(bot.sent[0].text), 'про бонус пока не пишем');
  const [row] = (await rows()).filter((r) => r.user_id === u.id);
  assert.equal(row.answer, 'asked');
  assert.equal(row.status, 'new');
  assert.equal(row.phrase_norm, 'бахилы');
  assert.equal(row.category, 'Здоровье');
  assert.equal(Number(row.amount), 300);
  assert.equal(row.ai_reason, 'unknown_item');
  const buttons = bot.sent[0].opts.reply_markup.inline_keyboard[0];
  assert.deepEqual(buttons.map((b) => b.text), ['Да, передать', 'Нет, не надо']);
  assert.deepEqual(buttons.map((b) => b.callback_data), [`learn:yes:${row.id}`, `learn:no:${row.id}`]);
  assert.ok(buttons.every((b) => b.callback_data.length <= 64));
});

test('мусор не спрашиваем и в базу не пишем', async () => {
  const u = await newUser();
  const bot = fakeBot();
  const before = (await rows()).length;
  for (const text of ['ффффф 300', 'ghbdtn 300', '300', 'кафэ 300']) {
    const res = await maybeAskToLearn(bot, 1, { userId: u.id, learn: { text, reason: text === 'кафэ 300' ? 'typo' : null }, parsed: manual }, db);
    assert.match(res, /^skip:/, text);
  }
  assert.equal(bot.sent.length, 0);
  assert.equal((await rows()).length, before);
  assert.equal(await maybeAskToLearn(bot, 1, { userId: u.id, learn: null, parsed: manual }, db), 'skip:no_context');
  assert.equal(await maybeAskToLearn(bot, 1, { userId: null, learn: { text: 'бахилы 300' }, parsed: manual }, db), 'skip:no_context');
});

test('веб-чат на сайте: вопрос задаётся так же, а администратор видит почту вместо Telegram id', async () => {
  const id = crypto.randomUUID();
  await ctx.query("INSERT INTO public.users (id, external_id, channel, email) VALUES ($1, 'web-chat-1', 'web', 'masha@example.com')", [id]);
  const bot = { ...fakeBot(), isWeb: true };
  assert.equal(await maybeAskToLearn(bot, 'web-chat-1', { userId: id, learn: { text: 'бахилы для сайта 300', reason: 'unknown_item' }, parsed: manual }, db), 'asked');
  assert.equal(bot.sent.length, 1);
  const rowId = (await rows()).find((r) => r.user_id === id).id;
  const notified = [];
  await handleLearnCallback(bot, { id: 'q', data: `learn:yes:${rowId}`, from: { id: 'web-chat-1' }, message: { chat: { id: 'web-chat-1' } } }, db, async (s) => notified.push(s));
  assert.equal(notified.length, 1);
  assert.equal(notified[0].from, 'сайт, masha@example.com');
  assert.equal(bot.sent.at(-1).text, LEARN_THANKS_TEXT);
});

test('лимита «раз в день» нет: разные настоящие фразы спрашиваем каждый раз', async () => {
  const u = await newUser();
  const bot = fakeBot();
  for (const text of ['бахилы 300', 'маникюрша Оля 2000', 'ёлочные игрушки 1500', 'абонемент на каток 900']) {
    assert.equal(await maybeAskToLearn(bot, 1, { userId: u.id, learn: { text, reason: 'unknown_item' }, parsed: manual }, db), 'asked', text);
  }
  assert.equal(bot.sent.length, 4);
});

test('«Да»: сигнал уходит администратору один раз, человек получает спасибо', async () => {
  const u = await newUser('555001', 'masha');
  const bot = fakeBot();
  await maybeAskToLearn(bot, 9, { userId: u.id, learn: { text: 'Бахилы 450 ₽', reason: 'unknown_item' }, parsed: { type: 'expense', category: 'Здоровье', amount: 450 } }, db);
  const id = (await rows()).find((r) => r.user_id === u.id).id;
  const notified = [];
  const notify = async (s) => { notified.push(s); return true; };
  const query = { id: 'q1', data: `learn:yes:${id}`, from: { id: Number(u.tg) }, message: { chat: { id: 9 } } };
  await handleLearnCallback(bot, query, db, notify);
  assert.equal(notified.length, 1);
  assert.deepEqual({ ...notified[0], from: undefined }, { phrase: 'Бахилы 450 ₽', amount: 450, type: 'expense', category: 'Здоровье', reason: 'unknown_item', from: undefined });
  assert.match(notified[0].from, /masha/);
  assert.match(notified[0].from, /555001/);
  assert.equal(bot.sent.at(-1).text, LEARN_THANKS_TEXT);
  const row = (await rows()).find((r) => r.id === id);
  assert.equal(row.answer, 'sent');
  assert.ok(row.answered_at);
  assert.equal(row.status, 'new');
  // повторное нажатие ничего не делает
  const count = bot.sent.length;
  await handleLearnCallback(bot, query, db, notify);
  assert.equal(notified.length, 1);
  assert.equal(bot.sent.length, count);
});

test('«Нет»: администратору ничего не уходит', async () => {
  const u = await newUser();
  const bot = fakeBot();
  await maybeAskToLearn(bot, 9, { userId: u.id, learn: { text: 'бахилы синие 300', reason: null }, parsed: manual }, db);
  const id = (await rows()).find((r) => r.user_id === u.id).id;
  const notified = [];
  await handleLearnCallback(bot, { id: 'q', data: `learn:no:${id}`, from: { id: Number(u.tg) }, message: { chat: { id: 9 } } }, db, async (s) => notified.push(s));
  assert.equal(notified.length, 0);
  assert.equal(bot.sent.at(-1).text, LEARN_DECLINED_TEXT);
  assert.equal((await rows()).find((r) => r.id === id).answer, 'declined');
});

test('чужую кнопку нажать нельзя, мусорные данные кнопки ничего не ломают', async () => {
  const owner = await newUser();
  const stranger = await newUser();
  const bot = fakeBot();
  await maybeAskToLearn(bot, 9, { userId: owner.id, learn: { text: 'бахилы зелёные 300', reason: null }, parsed: manual }, db);
  const id = (await rows()).find((r) => r.user_id === owner.id).id;
  const notified = [];
  const notify = async (s) => notified.push(s);
  await handleLearnCallback(bot, { id: 'q', data: `learn:yes:${id}`, from: { id: Number(stranger.tg) }, message: { chat: { id: 9 } } }, db, notify);
  assert.equal(notified.length, 0);
  assert.equal((await rows()).find((r) => r.id === id).answer, 'asked');
  for (const data of ['learn:yes', 'learn:maybe:' + id, 'learn:yes:not-a-uuid']) {
    await assert.doesNotReject(handleLearnCallback(bot, { id: 'q', data, from: { id: Number(owner.tg) }, message: { chat: { id: 9 } } }, db, notify));
  }
  assert.equal(notified.length, 0);
});

test('одну и ту же фразу не спрашиваем снова: уже передана или человек на неё отвечал', async () => {
  const a = await newUser();
  const b = await newUser();
  const bot = fakeBot();
  const ask = (u, text) => maybeAskToLearn(bot, 1, { userId: u.id, learn: { text, reason: 'unknown_item' }, parsed: manual }, db);
  assert.equal(await ask(a, 'Бахилы одноразовые 300'), 'asked');
  assert.equal(await ask(a, 'бахилы одноразовые 500'), 'skip:already_asked'); // тот же человек, вопрос уже был
  const id = (await rows()).find((r) => r.user_id === a.id && r.phrase_norm === 'бахилы одноразовые').id;
  await handleLearnCallback(bot, { id: 'q', data: `learn:yes:${id}`, from: { id: Number(a.tg) }, message: { chat: { id: 1 } } }, db, async () => true);
  assert.equal(await ask(b, 'бахилы одноразовые 100'), 'skip:already_sent');   // уже передана другим
  assert.equal(await ask(b, 'бахилы цветные 100'), 'asked');                    // другая фраза
});

test('сбой базы не ломает запись: функция возвращает error', async () => {
  const brokenDb = { from: () => { throw new Error('db down'); } };
  assert.equal(await maybeAskToLearn(fakeBot(), 1, { userId: 'x', learn: { text: 'бахилы 300' }, parsed: manual }, brokenDb), 'error');
});

test('текст для администратора', () => {
  const t = learnSignalText({ phrase: 'бахилы 300', amount: 300, type: 'expense', category: 'Здоровье', reason: 'unknown_item', from: 'masha, Telegram id 1' });
  assert.equal(t, '✍️ Обучить бота\nФраза: «бахилы 300»\nСумма: 300 ₽\nКатегорию выбрал человек: Здоровье (расход)\nЧто сказал ИИ: unknown_item\nПользователь: masha, Telegram id 1');
  assert.match(learnSignalText({ phrase: 'x', amount: 1, type: 'income', category: 'Зарплата', reason: null, from: 'a' }), /Зарплата \(доход\)\nЧто сказал ИИ: —/);
});

test('кнопки и тексты', () => {
  assert.equal(learnKeyboard('abc').reply_markup.inline_keyboard[0].length, 2);
  for (const t of [LEARN_ASK_TEXT('x'), LEARN_THANKS_TEXT, LEARN_DECLINED_TEXT]) assert.ok(!/\bвы\b/i.test(t));
});

test('инструкция для ИИ просит указывать причину; в коде всё подключено', () => {
  const p = getSystemPrompt([]);
  for (const r of ['typo', 'gibberish', 'foreign']) assert.ok(p.includes(`"${r}"`), r);
  assert.ok(p.includes('"reason":"gibberish"'));
  const message = read('src/handlers/message.js');
  assert.match(message, /takeUnrecognized\(telegramId\)/);
  assert.match(message, /rememberUnrecognized\(telegramId, \{ text: effectiveText, reason: parsed\.reason \}\)/);
  assert.match(message, /maybeAskToLearn\(bot, chatId, \{ userId, learn: state\.learn, parsed \}\)/);
  assert.match(read('src/handlers/callbackDispatcher.js'), /action\.startsWith\('learn:'\)[\s\S]*handleLearnCallback/);
});
