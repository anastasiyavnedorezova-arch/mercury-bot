// История транзакций: колонка «Сообщение» (на десктопе между категорией и суммой, на мобильном под категорией),
// обычное начертание у категории; шапка кабинета всегда показывает строку тарифа под именем.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const hist = fs.readFileSync(new URL('../public/cabinet/history.html', import.meta.url), 'utf8');
const layout = fs.readFileSync(new URL('../public/cabinet/layout.js', import.meta.url), 'utf8');

test('таблица: колонка «Сообщение» стоит между «Категория» и «Сумма»', () => {
  const head = hist.slice(hist.indexOf('<thead'), hist.indexOf('</thead>'));
  const names = [...head.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(names, ['Дата', 'Тип', 'Категория', 'Сообщение', 'Сумма', 'Действия']);
});

test('таблица: пустые и загрузочные строки занимают все 6 колонок', () => {
  assert.ok(!hist.includes('colspan="5"'));
  assert.ok(hist.includes('colspan="6"'));
});

test('строка таблицы: сообщение в своей ячейке, категория не жирная', () => {
  assert.ok(hist.includes('hist-td--msg'));
  assert.ok(!hist.includes("font-weight:700;font-size:14px;color:#2D3748;\">'+escH(r.category"));
});

test('мобильная карточка: категория обычным шрифтом, сообщение под ней', () => {
  assert.match(hist, /\.hist-card__name\s*\{[^}]*font-weight:\s*400/);
  assert.match(hist, /\.hist-card__comment\s*\{[^}]*font-weight:\s*400/);
});

test('шапка: строка тарифа есть всегда, в том числе без подписки', () => {
  assert.ok(layout.includes('Подписка не активна'));
  assert.ok(!layout.includes("let subHtml = ''"));
  assert.match(layout, /\.lk-header__user \{ flex-direction: column/);
});
