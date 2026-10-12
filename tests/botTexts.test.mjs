import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMultiConfirmationText,
  buildMultiKeyboard,
  textForPendingAmount,
} from '../src/utils/botTexts.js';

test('ответ без цифр — описание к ожидающей сумме', () => {
  assert.equal(textForPendingAmount('одежда', 4700), 'одежда 4700');
});

test('ответ с цифрами — новая запись, сумма из ожидания не добавляется', () => {
  // именно так одна трата превращалась в две записи
  assert.equal(textForPendingAmount('4700 справка для Насти ❤️', 4700), '4700 справка для Насти ❤️');
  assert.equal(textForPendingAmount('3400 продукты', 4700), '3400 продукты');
});

test('текст с несколькими записями нумерует строки', () => {
  const items = [
    { type: 'expense', amount: 200, category: 'Кофе на вынос', comment: null, transaction_date: '2026-10-10' },
    { type: 'expense', amount: 500, category: 'Транспорт', comment: 'такси', transaction_date: '2026-10-10' },
  ];
  const text = buildMultiConfirmationText(items);
  assert.match(text, /Записал 2 записи/);
  assert.match(text, /1\. .*200/);
  assert.match(text, /2\. .*500.*такси/);
});

test('у каждой сохранённой записи свои кнопки «Исправить» и «Удалить»', () => {
  const kb = buildMultiKeyboard(['id-a', 'id-b']);
  const rows = kb.reply_markup.inline_keyboard;
  assert.equal(rows.length, 3); // две записи + главное меню
  assert.deepEqual(rows[0].map((b) => b.callback_data), ['tx:edit:id-a', 'tx:delete:id-a']);
  assert.deepEqual(rows[1].map((b) => b.callback_data), ['tx:edit:id-b', 'tx:delete:id-b']);
  assert.match(rows[1][0].text, /2/);
  assert.equal(rows[2][0].callback_data, 'menu:main');
});

test('для не сохранённой записи кнопок нет, нумерация остаётся', () => {
  const rows = buildMultiKeyboard(['id-a', null, 'id-c']).reply_markup.inline_keyboard;
  assert.equal(rows.length, 3); // записи 1 и 3 + главное меню
  assert.match(rows[1][0].text, /3/);
});

test('кнопок не больше десяти записей', () => {
  const ids = Array.from({ length: 15 }, (_, i) => `id-${i}`);
  const rows = buildMultiKeyboard(ids).reply_markup.inline_keyboard;
  assert.equal(rows.length, 11); // 10 записей + главное меню
});
