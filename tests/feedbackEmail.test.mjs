// Обратная связь в боте и виджете: куда отвечать (23.10.2026).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { makeDb } from './helpers/testDb.mjs';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:1/test'; // db.js подключается лениво; боевой базы в тестах нет
const { showFeedback, handleFeedbackMessage, feedbackSentText, FEEDBACK_ASK_EMAIL_TEXT } = await import('../src/handlers/feedback.js');
const { userStates } = await import('../src/state.js');

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const uid = () => crypto.randomUUID();

let ctx; let db;
before(async () => { ctx = await makeDb(); db = ctx.db; });
after(async () => { await ctx?.close(); });

function fakeBot() {
  const sent = [];
  return { sent, sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); } };
}
const makeMsg = (tgId, text) => ({ from: { id: tgId, username: 'nastya' }, chat: { id: tgId }, text });

async function newUser(email) {
  const ext = String(Math.floor(Math.random() * 1e9) + 1e9);
  const id = uid();
  assert.ifError((await db.from('users').insert({ id, external_id: ext, channel: 'telegram', email })).error);
  return { id, ext: Number(ext) };
}

test('есть e-mail в профиле: сообщение уходит сразу, в ответе этот e-mail и «24 рабочих часов»', async () => {
  const u = await newUser('Ivan@Mail.ru');
  const bot = fakeBot(); const notes = [];
  const notify = async (n) => { notes.push(n); };
  await showFeedback(bot, u.ext, u.ext);
  assert.equal(userStates.get(u.ext).awaitingFeedback, true);
  assert.equal(await handleFeedbackMessage(bot, makeMsg(u.ext, 'Не работает кнопка'), db, notify), true);

  const last = bot.sent.at(-1).text;
  assert.equal(last, feedbackSentText('ivan@mail.ru'));
  assert.match(last, /Сообщение отправлено/);
  assert.match(last, /ivan@mail\.ru в течение 24 рабочих часов/);
  assert.equal(userStates.get(u.ext), undefined);

  const { data } = await db.from('feedback').select('*').eq('user_id', u.id);
  assert.equal(data.length, 1);
  assert.equal(data[0].message, 'От: ivan@mail.ru\n\nНе работает кнопка');
  assert.equal(notes.length, 1);
  assert.match(notes[0].from, /e-mail для ответа: ivan@mail\.ru/);
  assert.equal(notes[0].text, 'Не работает кнопка');
});

test('нет e-mail: сначала просим адрес, после корректного адреса обращение сохраняется, в профиль адрес не пишется', async () => {
  const u = await newUser(null);
  const bot = fakeBot(); const notes = [];
  const notify = async (n) => { notes.push(n); };
  await showFeedback(bot, u.ext, u.ext);
  await handleFeedbackMessage(bot, makeMsg(u.ext, 'Хочу экспорт в Excel'), db, notify);
  assert.equal(bot.sent.at(-1).text, FEEDBACK_ASK_EMAIL_TEXT);
  assert.equal((await db.from('feedback').select('id').eq('user_id', u.id)).data.length, 0, 'пока адреса нет — ничего не сохранено');
  assert.equal(notes.length, 0);

  // неверный адрес — спрашиваем снова, сообщение не теряется
  await handleFeedbackMessage(bot, makeMsg(u.ext, 'не почта'), db, notify);
  assert.match(bot.sent.at(-1).text, /Не похоже на e-mail/);
  assert.equal(userStates.get(u.ext).awaitingFeedbackEmail, true);

  await handleFeedbackMessage(bot, makeMsg(u.ext, '  Olga@Gmail.com '), db, notify);
  assert.equal(bot.sent.at(-1).text, feedbackSentText('olga@gmail.com'));
  assert.equal(userStates.get(u.ext), undefined);

  const { data } = await db.from('feedback').select('*').eq('user_id', u.id);
  assert.equal(data.length, 1);
  assert.equal(data[0].message, 'От: olga@gmail.com\n\nХочу экспорт в Excel');
  assert.equal(notes.length, 1);
  assert.match(notes[0].from, /olga@gmail\.com/);

  const user = (await db.from('users').select('email').eq('id', u.id).single()).data;
  assert.equal(user.email, null, 'адрес остался только в обращении');
});

test('пустое значение e-mail и мусор в профиле считаются отсутствием: адрес спрашиваем', async () => {
  const u = await newUser('');
  const bot = fakeBot();
  await showFeedback(bot, u.ext, u.ext);
  await handleFeedbackMessage(bot, makeMsg(u.ext, 'Привет'), db, async () => {});
  assert.equal(bot.sent.at(-1).text, FEEDBACK_ASK_EMAIL_TEXT);
  userStates.delete(u.ext);
});

test('без ожидающего обращения обработчик ничего не трогает; не текст — просит текст', async () => {
  const u = await newUser('a@b.ru');
  const bot = fakeBot();
  assert.equal(await handleFeedbackMessage(bot, makeMsg(u.ext, 'просто текст'), db, async () => {}), false);
  await showFeedback(bot, u.ext, u.ext);
  assert.equal(await handleFeedbackMessage(bot, makeMsg(u.ext, undefined), db, async () => {}), true);
  assert.match(bot.sent.at(-1).text, /Отправь текстовое сообщение/);
  userStates.delete(u.ext);
});

test('«Главное меню» сбрасывает обращение (иначе следующее сообщение примут за адрес)', () => {
  const d = read('src/handlers/callbackDispatcher.js');
  assert.match(d, /st\?\.awaitingFeedback \|\| st\?\.awaitingFeedbackEmail\) userStates\.delete/);
  const f = read('src/handlers/feedback.js');
  assert.ok(f.includes("callback_data: 'menu:main'"));
  assert.ok(!/ваш|вашу|ваше|напишите|отправьте/i.test(f), 'тексты на «ты»');
});
