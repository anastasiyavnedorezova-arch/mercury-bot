import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoryText, formatRuDate, TELEGRAM_TEXT_LIMIT } from '../src/utils/historyText.js';
import { maskEmailForLink } from '../src/accounts/linkTelegram.js';

const mk = (i, over = {}) => ({
  transaction_date: `2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')}`,
  type: 'expense',
  amount: 100 + i,
  comment: 'комментарий к операции номер ' + i,
  categories: { name: 'Продукты' },
  ...over,
});

test('formatRuDate: день и месяц словами', () => {
  assert.equal(formatRuDate('2026-10-19'), '19 октября');
  assert.equal(formatRuDate('2026-01-05'), '5 января');
});

test('«Всего» берётся из общего числа, а не из длины списка', () => {
  const txs = Array.from({ length: 50 }, (_, i) => mk(i));
  const text = buildHistoryText(txs, { sumIncome: 1000, sumExpense: 5000 }, '2026-01-01', '2026-10-19', null, { total: 128 });
  assert.match(text, /Всего: 128 операций/);
  assert.match(text, /Показаны последние 50/);
  assert.match(text, /finnikbot\.ru\/cabinet\/history/);
});

test('если показано всё, подсказки про кабинет нет', () => {
  const txs = [mk(1), mk(2)];
  const text = buildHistoryText(txs, { sumIncome: 0, sumExpense: 300 }, '2026-01-01', '2026-10-19', null, { total: 2 });
  assert.match(text, /Всего: 2 операций/);
  assert.doesNotMatch(text, /Показаны последние/);
});

test('без total берётся длина списка', () => {
  const text = buildHistoryText([mk(1)], { sumIncome: 0, sumExpense: 101 }, '2026-01-01', '2026-01-31', null);
  assert.match(text, /Всего: 1 операций/);
});

test('итоги внизу на месте: доходы, расходы, баланс', () => {
  const txs = [mk(1, { type: 'income', amount: 7000 }), mk(2)];
  const text = buildHistoryText(txs, { sumIncome: 7000, sumExpense: 102 }, '2026-01-01', '2026-10-19', null, { total: 2 });
  assert.match(text, /Доходы: \+7\s?000 ₽/);
  assert.match(text, /Расходы: -102 ₽/);
  assert.match(text, /Баланс: \+6\s?898 ₽/);
});

test('длинный список сокращается, итоги остаются и лимит Telegram не превышен', () => {
  const txs = Array.from({ length: 200 }, (_, i) => mk(i, { comment: 'очень длинный комментарий '.repeat(3) }));
  const text = buildHistoryText(txs, { sumIncome: 1, sumExpense: 2 }, '2026-01-01', '2026-10-19', 'период ограничен', { total: 300 });
  assert.ok(text.length <= TELEGRAM_TEXT_LIMIT, `длина ${text.length}`);
  assert.match(text, /Баланс:/);
  assert.match(text, /Доходы:/);
  assert.match(text, /Расходы:/);
  assert.match(text, /список сокращён/);
  assert.match(text, /Всего: 300 операций/);
  assert.match(text, /период ограничен/);
});

test('почта в подтверждении подключения: метка после «+» видна', () => {
  assert.equal(maskEmailForLink('anastasiya.v.nedorezova@gmail.com'), 'a***@gmail.com');
  assert.equal(maskEmailForLink('anastasiya.v.nedorezova+t6@gmail.com'), 'a***+t6@gmail.com');
  assert.notEqual(maskEmailForLink('a@x.ru'), maskEmailForLink('a+1@x.ru'));
});
