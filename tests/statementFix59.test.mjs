// Патч 59 (30.10.2026): выписка по фото. Правки текстом («не записывай 3»), переводы между своими счетами,
// текст перед разбором, кнопка «Оплатить подписку» в шапке кабинета.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:1/test';
process.env.OPENAI_API_KEY ||= 'test-key';
const {
  applyStatementCorrectionsDetailed, buildSummaryText, buildUpdatedSummary, statementWaitMessage, getStatementPrompt,
} = await import('../src/handlers/fileUpload.js');

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// Выписка из жалобы: 6 строк, 3 — перевод между своими счетами, 5 — реальный доход
const pending = () => ([
  { transaction_date: '2026-10-12', amount: 99, type: 'expense', category: 'Комиссии', comment: null, confidence: 'high' },
  { transaction_date: '2026-10-12', amount: 3869, type: 'expense', category: 'Остальное', comment: 'OZON', confidence: 'high' },
  { transaction_date: '2026-10-12', amount: 2000, type: 'income', category: 'Долг мне вернули', comment: null, confidence: 'low', ownTransfer: true },
  { transaction_date: '2026-10-12', amount: 7580, type: 'expense', category: 'Техника и мебель', comment: 'Лемана ПРО', confidence: 'low' },
  { transaction_date: '2026-10-12', amount: 8000, type: 'income', category: 'Долг мне вернули', comment: 'Николай З.', confidence: 'low' },
  { transaction_date: '2026-10-11', amount: 2591, type: 'expense', category: 'Дети', comment: 'Детский мир', confidence: 'high' },
]);

test('«3 и 5 не делай» убирает строки, остальные не трогает', () => {
  const r = applyStatementCorrectionsDetailed(pending(), { updates: [], remove: [3, 5] });
  assert.deepEqual(r.removed, [3, 5]);
  assert.deepEqual(r.updated.map((t) => t.amount), [99, 3869, 7580, 2591]);
  assert.deepEqual(r.updated.map((t) => t.category), ['Комиссии', 'Остальное', 'Техника и мебель', 'Дети']);
});

test('«удалить запись» в поле категории ничего не ломает: неизвестная категория отклоняется', () => {
  const r = applyStatementCorrectionsDetailed(pending(), { updates: [{ index: 3, category: 'Удалить запись' }, { index: 2, category: 'Товары в дом' }] });
  assert.equal(r.updated[2].category, 'Долг мне вернули');
  assert.equal(r.updated[2].type, 'income');
  assert.deepEqual(r.unknown.map((u) => u.n), [3]);
  assert.match(buildUpdatedSummary(r.updated, r), /не знаю категорию «Удалить запись» \(строка 3\)/);
});

test('«всё остальное в категорию» меняет только «Остальное» и не переворачивает доходы в расходы', () => {
  const r = applyStatementCorrectionsDetailed(pending(), { updates: [], applyToAll: { category: 'Товары в дом', type: 'expense' } });
  assert.equal(r.updated[1].category, 'Товары в дом');
  assert.equal(r.updated[3].category, 'Техника и мебель'); // низкая уверенность больше не повод менять
  assert.equal(r.updated[4].type, 'income');
  assert.equal(r.updated[4].category, 'Долг мне вернули');
  assert.deepEqual(r.changed.map((c) => c.n), [2]);
});

test('смена категории без указания типа берёт тип категории; явный тип человека важнее', () => {
  const r = applyStatementCorrectionsDetailed(pending(), { updates: [{ index: 5, category: 'Зарплата' }, { index: 1, category: 'Налоги и штрафы' }] });
  assert.equal(r.updated[4].type, 'income');
  assert.equal(r.updated[0].type, 'expense');
  const r2 = applyStatementCorrectionsDetailed(pending(), { updates: [{ index: 1, category: 'Спорт', type: 'income' }] });
  assert.equal(r2.updated[0].type, 'income');
});

test('перевод между своими счетами: в списке с пометкой, не записывается; «запиши 3 как доход» возвращает его', () => {
  const text = buildSummaryText(pending().map((t) => ({ ...t, isDuplicate: false })));
  assert.match(text, /^3\. ↔️ 2026-10-12 — перевод между своими счетами: 2000 ₽ — не записываю/m);
  assert.match(text, /Записать 5 новых транзакций/); // 6 строк минус перевод
  assert.match(text, /не записывай 3/);
  const r = applyStatementCorrectionsDetailed(pending(), { updates: [{ index: 3, type: 'income' }], restore: [3] });
  assert.equal(r.updated[2].ownTransfer, false);
  assert.equal(r.updated[2].type, 'income');
  const only = buildSummaryText([{ ...pending()[2], isDuplicate: false }]);
  assert.match(only, /Записывать нечего/);
});

test('номера вне списка и мусор в remove/restore не ломают', () => {
  const r = applyStatementCorrectionsDetailed(pending(), { remove: [0, 9, 'x', 2, 2], restore: [1, 99], updates: null, applyToAll: null });
  assert.deepEqual(r.removed, [2]);
  assert.equal(r.updated.length, 5);
  assert.doesNotThrow(() => applyStatementCorrectionsDetailed(pending(), null));
  const nothing = applyStatementCorrectionsDetailed(pending(), {});
  assert.deepEqual([nothing.changed, nothing.removed, nothing.restored, nothing.unknown], [[], [], [], []]);
});

test('обновлённый список: что изменил, номера пересчитаны, без лишней галочки у доходов', () => {
  const r = applyStatementCorrectionsDetailed(pending(), { updates: [{ index: 2, category: 'Товары в дом' }], remove: [3, 5] });
  const text = buildUpdatedSummary(r.updated, r);
  assert.match(text, /• 2 — Товары в дом \(расход\)/);
  assert.match(text, /• не записываю: 3, 5/);
  assert.match(text, /^2\. 2026-10-12 — Товары в дом — 3869 ₽ \(OZON\) \(расход\)/m);
  assert.match(text, /^4\. 2026-10-11 — Дети — 2591 ₽/m);
  assert.ok(!text.includes('✅'));
});

test('текст перед разбором: фото — курсивом про тестовый режим и кнопка обратной связи, файл — коротко', () => {
  const photo = statementWaitMessage('photo');
  assert.equal(photo.options.parse_mode, 'HTML');
  assert.match(photo.text, /^📄 Анализирую выписку\.\.\.\n<i>Анализ выписки по фото находится в тестовом режиме, я только учусь правильно разбирать изображения 🤓 Если я сделаю ошибку, отправь, пожалуйста, обращение разработчикам, чтобы меня научили лучше 💛<\/i>$/);
  assert.equal(photo.options.reply_markup.inline_keyboard[0][0].callback_data, 'menu:feedback');
  const doc = statementWaitMessage('document');
  assert.equal(doc.text, '📄 Анализирую выписку, подожди немного...');
  assert.equal(doc.options, undefined);
  assert.ok(!/(^|[^а-яё])(вы|вам|ваш)([^а-яё]|$)/i.test(photo.text));
});

test('промпт выписки знает про переводы между своими счетами и отличает их от переводов людям', () => {
  const p = getStatementPrompt();
  assert.match(p, /own_transfer/);
  assert.match(p, /между своими счетами/);
});

test('шапка кабинета: «Открыть в Telegram» заменена на «Оплатить подписку» на всех страницах', () => {
  const pages = ['profile', 'dashboard', 'goals', 'categories', 'analytics', 'budget', 'history', 'accounting', 'family', 'faq', 'feedback', 'how-to'];
  for (const name of pages) {
    const html = read(`public/cabinet/${name}.html`);
    assert.ok(!html.includes('Открыть в Telegram'), `${name}: осталась старая кнопка`);
    assert.equal((html.match(/data-pay-btn>Оплатить подписку</g) || []).length, 2, `${name}: кнопка в шапке и в меню`);
    assert.match(html, /href="\/cabinet\/profile\?plans=1" class="btn-hdr btn-hdr--sec" data-pay-btn/);
  }
  const profile = read('public/cabinet/profile.html');
  assert.match(profile, /querySelectorAll\('\[data-pay-btn\]'\)/);
  assert.match(profile, /openModal\(window\.__plansModalName \|\| 'modalSubscribe'\)/);
});
