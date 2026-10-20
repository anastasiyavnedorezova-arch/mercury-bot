// Колонка «Сообщение» (текст без суммы вместо пустого комментария) и повторная попытка разбора при «не распознано».
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { displayMessage, stripAmount } from '../src/utils/messageText.js';
import { needsRetry, parseWithRetry, RETRY_HINT } from '../src/utils/llmRetry.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('stripAmount: убирает сумму в разных записях', () => {
  assert.equal(stripAmount('книги 899'), 'книги');
  assert.equal(stripAmount('899 книги'), 'книги');
  assert.equal(stripAmount('книги 1 250,50 ₽'), 'книги');
  assert.equal(stripAmount('такси 450 руб.'), 'такси');
  assert.equal(stripAmount('книги 499р'), 'книги');
  assert.equal(stripAmount('кофе 2к'), 'кофе');
  assert.equal(stripAmount('билеты на поезд 3 400'), 'билеты на поезд');
  assert.equal(stripAmount('499'), '');
  assert.equal(stripAmount('рубашка 3000'), 'рубашка', 'слова с «р» внутри не режутся');
  assert.equal(stripAmount('курсы 12 тыс'), 'курсы');
});

test('displayMessage: комментарий важнее; иначе исходный текст без суммы', () => {
  assert.equal(displayMessage({ comment: 'такси', raw_message: 'такси 500' }, 'Транспорт'), 'такси');
  assert.equal(displayMessage({ comment: null, raw_message: 'книги 899' }, 'Обучение'), 'книги');
  assert.equal(displayMessage({ comment: '  ', raw_message: 'книги 499' }, 'Обучение'), 'книги');
  assert.equal(displayMessage({ comment: null, raw_message: 'вчера кофе 200' }, 'Кофе на вынос'), 'вчера кофе');
});

test('displayMessage: пусто для ручных записей, повторов категории, команд и мусора', () => {
  assert.equal(displayMessage({ comment: null, raw_message: '499' }, 'Обучение'), null, 'ручная запись: в тексте только сумма');
  assert.equal(displayMessage({ comment: null, raw_message: '1 250,50' }, 'Обучение'), null);
  assert.equal(displayMessage({ comment: null, raw_message: 'продукты 130' }, 'Продукты'), null, 'повтор категории');
  assert.equal(displayMessage({ comment: null, raw_message: 'Кофе 349' }, 'Кофе на вынос'), null, 'начало названия категории');
  assert.equal(displayMessage({ comment: null, raw_message: '/start' }, 'Обучение'), null);
  assert.equal(displayMessage({ comment: null, raw_message: null }, 'Обучение'), null);
  assert.equal(displayMessage({ comment: null, raw_message: undefined }, 'Обучение'), null);
  assert.equal(displayMessage({ comment: null, raw_message: 'книги '.repeat(40) + '100' }, 'Обучение'), null, 'слишком длинный текст');
  assert.equal(displayMessage({}, ''), null);
  assert.equal(displayMessage(), null);
});

test('needsRetry: только «не распознано» и только при наличии цифр', () => {
  assert.equal(needsRetry({ error: 'unrecognized' }, 'книги 499'), true);
  assert.equal(needsRetry({ error: 'unrecognized' }, 'привет'), false, 'без суммы повтор не нужен');
  assert.equal(needsRetry({ error: 'no_amount' }, 'книги'), false);
  assert.equal(needsRetry({ error: 'clarification_needed' }, 'вб 3500'), false);
  assert.equal(needsRetry([{ amount: 1 }], 'книги 499'), false);
  assert.equal(needsRetry({ type: 'expense', amount: 499 }, 'книги 499'), false);
  assert.equal(needsRetry(null, 'книги 499'), false);
});

test('parseWithRetry: удачный первый ответ — один запрос; «не распознано» — вторая попытка с подсказкой', async () => {
  const calls = [];
  const ok = { type: 'expense', amount: 499, category: 'Обучение' };
  const logs = [];
  const log = (...a) => logs.push(a.join(' '));

  const r1 = await parseWithRetry(async (o) => { calls.push(o); return ok; }, 'книги 499', log);
  assert.deepEqual(r1, ok);
  assert.equal(calls.length, 1);

  calls.length = 0;
  const r2 = await parseWithRetry(async (o) => { calls.push(o); return o.retryHint ? ok : { error: 'unrecognized' }; }, 'книги 499', log);
  assert.deepEqual(r2, ok);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].retryHint, undefined);
  assert.equal(calls[1].retryHint, RETRY_HINT);
  assert.ok(logs.some((l) => l.includes('повторная попытка помогла')));

  calls.length = 0;
  const r3 = await parseWithRetry(async (o) => { calls.push(o); return { error: 'unrecognized' }; }, '3400 абракадабра', log);
  assert.deepEqual(r3, { error: 'unrecognized' });
  assert.equal(calls.length, 2, 'не больше одной повторной попытки');

  calls.length = 0;
  await parseWithRetry(async (o) => { calls.push(o); return { error: 'unrecognized' }; }, 'привет', log);
  assert.equal(calls.length, 1, 'без цифр повтора нет');
});

test('parseWithRetry: ошибка модели (сеть, квота) не глотается', async () => {
  const err = Object.assign(new Error('insufficient_quota'), { code: 'insufficient_quota' });
  await assert.rejects(parseWithRetry(async () => { throw err; }, 'книги 499', () => {}), (e) => e === err);
});

test('подключение: бот использует повторную попытку, подсказка и примеры есть в инструкции модели', () => {
  const msg = read('src/handlers/message.js');
  assert.match(msg, /parseWithRetry\(\(opts\) => callLLM\(effectiveText, userCategories, opts\), effectiveText\)/);
  assert.match(msg, /temperature: retryHint \? 0\.3 : 0/);
  const prompt = read('src/prompts/system_prompt.js');
  assert.match(prompt, /Пользователь: "книги 499"[\s\S]{0,120}"category":"Обучение"/);
  assert.match(prompt, /Пользователь: "сок 398"[\s\S]{0,120}"category":"Продукты"/);
  assert.match(prompt, /молоко, хлеб, яйца, сок/);
  const cab = read('src/cabinetRoutes.js');
  assert.equal((cab.match(/comment: displayMessage\(t, t\.categories\?\.name\)/g) || []).length, 2, 'история и дашборд');
  assert.equal((cab.match(/raw_message, /g) || []).length >= 2, true);
});
