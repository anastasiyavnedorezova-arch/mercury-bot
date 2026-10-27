// Патч 49 (26.10.2026): справочник слов и магазинов, быстрый разбор коротких записей, категории в выписках.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HINTS, EXPENSE_CATEGORIES, INCOME_CATEGORIES, normalizePhrase, matchHint, matchBrandInText, splitAmountAndWords,
  hintsForPrompt, canonicalCategory, refineStatementItem, compareWithDb,
} from '../src/utils/categoryHints.js';
import { quickParse } from '../src/utils/quickParse.js';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:1/test';
process.env.OPENAI_API_KEY ||= 'test-key';
const { getStatementPrompt, buildSummaryText, applyStatementCorrections } = await import('../src/handlers/fileUpload.js');
const { getSystemPrompt } = await import('../src/prompts/system_prompt.js');

const TODAY = '2026-10-26';
const q = (text, cats = []) => quickParse(text, cats, TODAY);

test('справочник: каждая категория существует, слова не спорят друг с другом', () => {
  const all = new Set([...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES]);
  const seen = new Map();
  for (const h of HINTS) {
    assert.ok(all.has(h.category), `нет категории ${h.category}`);
    for (const w of [...h.words, ...h.brands.map(([, k]) => k)]) {
      const key = normalizePhrase(w);
      assert.ok(key.length >= 2, `слишком короткое слово «${w}»`);
      if (seen.has(key)) assert.equal(seen.get(key), h.category, `«${w}» в двух категориях`);
      seen.set(key, h.category);
    }
  }
});

test('случаи из проверки 26.10: развлечения, ФНС, Золотое яблоко', () => {
  assert.deepEqual(q('развлечения 400'), {
    type: 'expense', amount: 400, category: 'Отдых и развлечения', comment: null, transaction_date: TODAY, confidence: 'high',
  });
  assert.equal(q('400 развлечения').category, 'Отдых и развлечения');
  assert.equal(q('Развлечения 400').category, 'Отдых и развлечения');
  const fns = q('Федеральная Налоговая Служба 2920');
  assert.equal(fns.category, 'Налоги и штрафы');
  assert.equal(fns.amount, 2920);
  assert.equal(q('ФНС 2920').category, 'Налоги и штрафы');
  assert.equal(q('налоги 5000').category, 'Налоги и штрафы');
  for (const t of ['золотое яблоко 3400', 'Золотое Яблоко 3400', 'ЗЯ 1500', 'зя 1 500 р', 'золотое яблоко помада 1800', '1800 золотое яблоко']) {
    const r = q(t);
    assert.equal(r.category, 'Красота и уход за собой', t);
    assert.equal(r.comment, 'Золотое яблоко', t);
  }
});

test('суммы в разных записях', () => {
  assert.equal(q('кофе 1 500').amount, 1500);
  assert.equal(q('кофе 1500 руб.').amount, 1500);
  assert.equal(q('кофе 250,5').amount, 251);
  assert.equal(q('налоги 5к').amount, 5000);
  assert.equal(q('налоги 5 тыс').amount, 5000);
  assert.equal(q('зп 120000').type, 'income');
  assert.equal(q('зп 120000').category, 'Зарплата');
  assert.equal(q('кэшбэк 300').category, 'Кэшбек и бонусы');
});

test('ёмкие и неоднозначные записи идут к ИИ, а не в справочник', () => {
  assert.equal(q('макдак доставка 500'), null);            // доставка еды или кафе — решает ИИ
  assert.equal(q('кофемания 1800 и на чай 200'), null);     // две траты
  assert.equal(q('развлечения 400 кино 300'), null);        // две суммы
  assert.equal(q('кофе и булочка 400'), null);
  assert.equal(q('привет 400'), null);
  assert.equal(q('400'), null);
  assert.equal(q('развлечения'), null);                     // без суммы: отдельный сценарий бота
  assert.equal(q('вб 3500'), null);
  assert.equal(q('озон 450'), null);
  assert.equal(q('перевод 5000'), null);
  assert.equal(q('телефон 30000'), null);
  assert.equal(q('аренда 40000'), null);                    // может быть и расходом, и доходом
  assert.equal(q('золотое яблоко и кофе 700'), null);
  assert.equal(q('развлечения 0'), null);
  assert.equal(q('развлечения 999999999999'), null);
  assert.equal(q('x'.repeat(200) + ' 400'), null);
});

test('«Магнит Косметик» — красота, просто «Магнит» — продукты', () => {
  assert.equal(q('магнит косметик 800').category, 'Красота и уход за собой');
  assert.equal(q('магнит 800').category, 'Продукты');
});

test('свои категории человека главнее справочника', () => {
  const mine = [{ name: 'Развлечения детей', type: 'expense', synonyms: ['аттракционы'] }];
  assert.equal(q('развлечения 400', mine), null);
  assert.equal(q('аттракционы 400', mine), null);
  assert.equal(q('налоги 5000', mine).category, 'Налоги и штрафы');
  const dacha = [{ name: 'Дача', type: 'expense', synonyms: ['огород', 'ЗЯ'] }];
  assert.equal(q('зя 500', dacha), null);                   // «ЗЯ» — синоним своей категории
});

test('splitAmountAndWords: только «слова + одна сумма»', () => {
  assert.deepEqual(splitAmountAndWords('кофе 400'), { words: 'кофе', amountText: '400' });
  assert.deepEqual(splitAmountAndWords('400 кофе'), { words: 'кофе', amountText: '400' });
  assert.equal(splitAmountAndWords('кофе 400 булочка 200'), null);
  assert.equal(splitAmountAndWords('просто слова'), null);
  assert.equal(splitAmountAndWords(''), null);
});

test('matchHint и matchBrandInText', () => {
  assert.equal(matchHint('Федеральная налоговая служба').category, 'Налоги и штрафы');
  assert.equal(matchHint('что-то непонятное'), null);
  assert.equal(matchBrandInText('Оплата в ЗОЛОТОЕ ЯБЛОКО MOSCOW RU').category, 'Красота и уход за собой');
  assert.equal(matchBrandInText('Перевод между счетами'), null);
});

test('названия категорий приводятся к базе', () => {
  assert.equal(canonicalCategory('Налоги'), 'Налоги и штрафы');
  assert.equal(canonicalCategory('Красота'), 'Красота и уход за собой');
  assert.equal(canonicalCategory('Кафе, рестораны'), 'Кафе и рестораны');
  assert.equal(canonicalCategory('Дом и быт'), 'Товары в дом');
  assert.equal(canonicalCategory('Другое'), 'Остальное');
  assert.equal(canonicalCategory('Жильё'), 'Жильё');
  assert.equal(canonicalCategory('Продукты'), 'Продукты');
  assert.equal(canonicalCategory('Своя категория'), 'Своя категория');
});

test('выписка: ФНС и Золотое яблоко получают нужные категории', () => {
  const fns = refineStatementItem({ description: 'Федеральная Налоговая Служба', amount: 2920, type: 'expense', category: 'Налоги' });
  assert.equal(fns.category, 'Налоги и штрафы');
  const other = refineStatementItem({ description: 'Федеральная Налоговая Служба', amount: 2920, type: 'expense', category: 'Остальное' });
  assert.equal(other.category, 'Налоги и штрафы');
  const zya = refineStatementItem({ description: 'Оплата ЗОЛОТОЕ ЯБЛОКО', amount: 3400, type: 'expense', category: 'Продукты', comment: null });
  assert.equal(zya.category, 'Красота и уход за собой');
  assert.equal(zya.comment, 'Золотое яблоко');
  const keep = refineStatementItem({ description: 'Оплата ЗОЛОТОЕ ЯБЛОКО', amount: 3400, type: 'expense', category: 'Продукты', comment: 'Помада' });
  assert.equal(keep.comment, 'Помада');
  // возврат от магазина остаётся доходом и не меняется
  const refund = refineStatementItem({ description: 'Возврат ЗОЛОТОЕ ЯБЛОКО', amount: 500, type: 'income', category: 'Возврат денег' });
  assert.equal(refund.category, 'Возврат денег');
  // общие слова меняют только «Остальное»
  assert.equal(refineStatementItem({ description: 'Штраф', type: 'expense', category: 'Остальное' }).category, 'Налоги и штрафы');
  assert.equal(refineStatementItem({ description: 'Штраф', type: 'expense', category: 'Транспорт' }).category, 'Транспорт');
  // исходный объект не меняется
  const src = { description: 'ФНС', type: 'expense', category: 'Налоги' };
  refineStatementItem(src);
  assert.equal(src.category, 'Налоги');
});

test('инструкция для выписок называет категории так же, как база', () => {
  const p = getStatementPrompt();
  for (const c of [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES]) assert.ok(p.includes(c), `нет «${c}»`);
  for (const bad of ['Дом и быт', 'Кафе, рестораны', 'Налоги, Комиссии', 'Здоровье, Красота,', 'Дети, Животные, Другое']) {
    assert.ok(!p.includes(bad), `лишнее «${bad}»`);
  }
  assert.ok(p.includes('золотое яблоко'));
  assert.ok(p.includes('фнс'));
});

test('инструкция для текстов содержит справочник и примеры из проверки', () => {
  const p = getSystemPrompt([]);
  assert.ok(p.includes(hintsForPrompt()));
  assert.ok(p.includes('"развлечения 400"'));
  assert.ok(p.includes('Федеральная Налоговая Служба 2920'));
  assert.ok(p.includes('золотое яблоко 3400'));
  assert.ok(p.includes('error: unrecognized для таких сообщений НЕЛЬЗЯ'));
  for (const c of [...EXPENSE_CATEGORIES.filter((c) => c !== 'Цель'), ...INCOME_CATEGORIES]) assert.ok(p.includes(c), `нет «${c}»`);
});

test('выписка: список пронумерован по тем, что будут записаны, и есть подсказка про правки', () => {
  const base = { type: 'expense', category: 'Продукты', amount: 100, comment: null, transaction_date: '2026-10-25' };
  const text = buildSummaryText([
    { ...base, isDuplicate: false },
    { ...base, isDuplicate: true },
    { ...base, amount: 200, isDuplicate: false },
  ]);
  assert.match(text, /^1\. 📉 2026-10-25 — Продукты: 100 ₽/m);
  assert.match(text, /^📉 2026-10-25 — Продукты: 100 ₽ ⚠️дубль/m);
  assert.match(text, /^2\. 📉 2026-10-25 — Продукты: 200 ₽/m);
  assert.match(text, /Чтобы поправить категорию/);
  assert.ok(!/Чтобы поправить категорию/.test(buildSummaryText([{ ...base, isDuplicate: true }])));
});

test('выписка: «№2» правит вторую запись, а не третью', () => {
  const pending = [
    { amount: 1, category: 'Остальное', type: 'expense', confidence: 'high' },
    { amount: 2, category: 'Остальное', type: 'expense', confidence: 'high' },
    { amount: 3, category: 'Остальное', type: 'expense', confidence: 'high' },
  ];
  const out = applyStatementCorrections(pending, { updates: [{ index: 2, category: 'Налоги' }], applyToAll: null });
  assert.deepEqual(out.map((t) => t.category), ['Остальное', 'Налоги и штрафы', 'Остальное']);
  assert.equal(pending[1].category, 'Остальное'); // исходный список не тронут
  const first = applyStatementCorrections(pending, { updates: [{ index: 1, category: 'Спорт', type: 'income', comment: 'зал' }] });
  assert.equal(first[0].category, 'Спорт');
  assert.equal(first[0].type, 'income');
  assert.equal(first[0].comment, 'зал');
  assert.equal(first[1].category, 'Остальное');
  // номер вне списка и мусор не ломают
  assert.deepEqual(applyStatementCorrections(pending, { updates: [{ index: 9, category: 'Спорт' }, { index: 0, category: 'Спорт' }, { category: 'Спорт' }] }).map((t) => t.category), ['Остальное', 'Остальное', 'Остальное']);
  assert.doesNotThrow(() => applyStatementCorrections(pending, null));
});

test('выписка: «всё остальное в категорию» не трогает записи с личными правками', () => {
  const pending = [
    { amount: 1, category: 'Остальное', type: 'expense', confidence: 'high' },
    { amount: 2, category: 'Остальное', type: 'expense', confidence: 'high' },
    { amount: 3, category: 'Транспорт', type: 'expense', confidence: 'high' },
  ];
  const out = applyStatementCorrections(pending, { updates: [{ index: 1, category: 'Спорт' }], applyToAll: { category: 'Дом и быт' } });
  assert.deepEqual(out.map((t) => t.category), ['Спорт', 'Товары в дом', 'Транспорт']);
});

test('сверка с базой', () => {
  const all = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES];
  assert.deepEqual(compareWithDb(all), { missingInDb: [], notInCode: [] });
  assert.deepEqual(compareWithDb([...all.slice(1), 'Новая']), { missingInDb: [all[0]], notInCode: ['Новая'] });
});
