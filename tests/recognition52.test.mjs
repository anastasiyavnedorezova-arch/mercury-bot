// Патч 52 (27.10.2026): итоги прогона 50 фраз — словарь слов и два защитных правила.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { matchHint, EXPENSE_CATEGORIES, INCOME_CATEGORIES, HINTS } from '../src/utils/categoryHints.js';
import { quickParse } from '../src/utils/quickParse.js';
import { looksLikeMash, analyzePhrase } from '../src/utils/learnSignal.js';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:1/test';
process.env.OPENAI_API_KEY ||= 'test-key';
const { getSystemPrompt } = await import('../src/prompts/system_prompt.js');
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('слова из прогона 50 фраз попадают в нужные категории без ИИ', () => {
  const cases = [
    ['самокат', 'Продукты', 'expense'], ['яндекс лавка', 'Продукты', 'expense'], ['репетитор', 'Обучение', 'expense'],
    ['азс', 'Авто', 'expense'], ['шиномонтаж', 'Авто', 'expense'], ['осаго', 'Авто', 'expense'],
    ['днс', 'Техника и мебель', 'expense'], ['М.Видео', 'Техника и мебель', 'expense'], ['мвидео', 'Техника и мебель', 'expense'],
    ['иви', 'Подписки', 'expense'], ['кинопоиск', 'Подписки', 'expense'], ['окко', 'Подписки', 'expense'],
    ['вернули долг', 'Долг мне вернули', 'income'], ['Вернула долг', 'Долг мне вернули', 'income'], ['дал в долг', 'Долг я дал', 'expense'],
  ];
  for (const [text, category, type] of cases) {
    const h = matchHint(text);
    assert.ok(h, text);
    assert.deepEqual([h.category, h.type], [category, type], text);
  }
  const q = quickParse('вернули долг 10000', [], '2026-10-27');
  assert.deepEqual([q.category, q.type, q.amount], ['Долг мне вернули', 'income', 10000]);
  assert.equal(quickParse('самокат 890', [], 'd').category, 'Продукты');
  // не сломали прежнее
  assert.equal(matchHint('яндекс еда').category, 'Доставка еды');
  assert.equal(matchHint('дети').category, 'Дети');
  assert.equal(matchHint('вернули деньги'), null, 'неоднозначное по-прежнему решает ИИ');
});

test('все категории словаря существуют среди системных', () => {
  const all = new Set([...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES]);
  for (const h of HINTS) assert.ok(all.has(h.category), h.category);
});

test('случайный набор букв распознаётся, настоящие слова и сокращения нет', () => {
  for (const t of ['ывапр 100', 'ффффф 100', 'йцукен 100', '200 фывап']) assert.equal(looksLikeMash(t), true, t);
  for (const t of ['мфц 800', 'днс 15000', 'жкх 6500', 'пролом 500', 'наклейки 230', 'вкладыши 100', 'кофэ 200', 'аптека 650', 'ghbdtn 300', '1 500 р']) {
    assert.equal(looksLikeMash(t), false, t);
  }
  assert.equal(analyzePhrase('мфц 800', null).ok, false, 'для сигнала обучения сокращения без гласных по-прежнему не спрашиваем');
});

test('подключение в коде: «не распознал» для набора букв, «Остальное» при ошибочном вопросе про маркетплейс', () => {
  const msg = read('src/handlers/message.js');
  assert.ok(msg.includes('looksLikeMash(effectiveText)'));
  assert.ok(msg.includes('wb_category без названия маркетплейса → Остальное'));
  assert.ok(msg.indexOf("wb_category без названия маркетплейса → Остальное") < msg.indexOf("wb_category без названия маркетплейса → не распознано"));
  assert.ok(getSystemPrompt([]).includes('Маша вернула долг 5000'));
});
