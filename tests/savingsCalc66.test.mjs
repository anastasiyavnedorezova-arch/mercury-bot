// Патч 66: калькулятор накоплений — приёмочные примеры из ТЗ, ввод, ошибки, пределы.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SCRIPT = fs.readFileSync(new URL('../public/js/savings-calc.js', import.meta.url), 'utf8');
const c = (() => { const ctx = { module: { exports: {} } }; vm.runInNewContext(SCRIPT, ctx); return ctx.module.exports; })();

const money = (s) => { const r = c.parseMoney(s); assert.ok(r.ok, `не разобралось: ${s}`); return r.kop; };
const A = (I, p, N, S) => c.calcSave({ incomeKop: money(I), bp: c.parsePercent(p).bp, months: N, startKop: money(S) });
const B = (G, Av, N, I) => c.calcGoal({ goalKop: money(G), savedKop: money(Av), months: N, incomeKop: money(I) });
const rub = (kop) => c.formatKop(kop).replace(/ /g, ' ');
const txt = (v) => [...v.rows.map((r) => `${r.label}: ${r.value}`), ...v.notes].join(' | ').replace(/ /g, ' ');

test('режим А: приёмочные примеры', () => {
  let r = A('50 000', '10', 12, '20 000');
  assert.deepEqual([r.monthlyKop, r.contribKop, r.totalKop], [500000, 6000000, 8000000]);
  r = A('30 000', '5', 12, '0');
  assert.deepEqual([r.monthlyKop, r.contribKop, r.totalKop], [150000, 1800000, 1800000]);
  r = A('0', '20', 12, '10 000');
  assert.deepEqual([r.monthlyKop, r.contribKop, r.totalKop, r.note], [0, 0, 1000000, 'zeroIncome']);
  assert.match(txt(c.viewSave(r)), /При нулевом доходе процентный взнос равен нулю/);
  r = A('50 000', '0', 12, '1 000');
  assert.deepEqual([r.monthlyKop, r.totalKop, r.note], [0, 100000, 'zeroPercent']);
  r = A('1,01', '50', 2, '0');
  assert.deepEqual([r.monthlyKop, r.totalKop], [51, 102]);
  assert.equal(rub(r.monthlyKop), '0,51 ₽');
  assert.equal(rub(r.totalKop), '1,02 ₽');
  r = A('0,01', '1', 12, '0');
  assert.equal(r.monthlyKop, 0);
  assert.equal(r.note, 'subKopeck');
});

test('режим Б: приёмочные примеры', () => {
  let r = B('120 000', '30 000', 12, '50 000');
  assert.deepEqual([r.monthlyKop, r.shareBp, r.leftKop, r.status], [750000, 1500, 4250000, 'ok']);
  assert.equal(r.payments, 12);
  assert.match(txt(c.viewGoal(r)), /12 взносов по 7 500 ₽/);
  assert.match(txt(c.viewGoal(r)), /Доля дохода: 15 %/);
  assert.match(txt(c.viewGoal(r)), /После взноса остается 42 500 ₽ до оплаты ваших расходов/);

  r = B('100 000', '0', 12, '50 000');
  assert.equal(rub(r.monthlyKop), '8 333,34 ₽');
  assert.equal(c.formatBp(r.shareBp).replace(/ /g, ' '), '16,67 %');
  assert.equal(r.monthlyKop * 11 + r.lastKop, 10000000, 'сумма всех взносов равна остатку цели');
  assert.match(txt(c.viewGoal(r)), /11 взносов по 8 333,34 ₽ и последний 8 333,26 ₽/);

  r = B('120 000', '130 000', 12, '0');
  assert.equal(r.reached, true);
  assert.equal(r.monthlyKop, 0);
  assert.match(txt(c.viewGoal(r)), /Цель уже достигнута/);
  assert.ok(!/NaN|Infinity/.test(txt(c.viewGoal(r))));

  r = B('120 000', '0', 12, '0');
  assert.equal(r.monthlyKop, 1000000);
  assert.equal(r.status, 'zeroIncome');
  assert.equal(r.shareBp, undefined);
  const t0 = txt(c.viewGoal(r));
  assert.match(t0, /Долю дохода нельзя определить при нулевом доходе/);
  assert.ok(!/NaN|Infinity/.test(t0));

  r = B('120 000', '0', 12, '5 000');
  assert.equal(r.monthlyKop, 1000000);
  assert.equal(r.shareBp, 20000);
  assert.equal(r.status, 'over');
  assert.match(txt(c.viewGoal(r)), /Взнос превышает указанный месячный доход/);
  assert.equal(c.viewGoal(r).tone, 'warn');

  r = B('0,01', '0', 12, '1');
  assert.equal(r.monthlyKop, 1);
  assert.equal(r.payments, 1);
  assert.equal(r.lastKop, 1);
  const t1 = txt(c.viewGoal(r));
  assert.match(t1, /Достаточно одного взноса 0,01 ₽/);
  assert.ok(!/-\d/.test(t1), 'отрицательных платежей нет');
});

test('график взносов всегда даёт ровно остаток цели и без отрицательных платежей', () => {
  for (const [G, Av, N] of [['100 000', '0', 12], ['0,05', '0', 7], ['1', '0,99', 3], ['999 999,99', '1', 1200], ['10', '0', 1], ['3', '0', 2]]) {
    const r = B(G, Av, N, '100 000');
    if (r.reached) continue;
    assert.ok(r.lastKop > 0 && r.lastKop <= r.monthlyKop, `${G}/${N}: последний взнос ${r.lastKop}`);
    assert.equal(r.monthlyKop * (r.payments - 1) + r.lastKop, r.remainingKop, `${G}/${N}`);
    assert.ok(r.payments <= N);
  }
});

test('ввод: пробелы, запятая и точка, лишние знаки, отрицательные, буквы, экспонента', () => {
  assert.equal(money('50 000'), 5000000);
  assert.equal(money('50 000'), 5000000);
  assert.equal(money('50 000'), 5000000);
  assert.equal(money('1 500,50'), 150050);
  assert.equal(money('1500.5'), 150050);
  assert.equal(money('0'), 0);
  assert.equal(money('007'), 700);
  const bad = { '': 'empty', '   ': 'empty', '-5': 'negative', '−5': 'negative', 'abc': 'format', '1e5': 'format', 'Infinity': 'format', 'NaN': 'format',
    '1.000.000': 'format', '1,000.50': 'format', '1.5,5': 'format', '5.': 'format', ',5': 'format', '1,234': 'decimals', '0.001': 'decimals', '1 000 000 001': 'max', '99999999999': 'max' };
  for (const [s, code] of Object.entries(bad)) assert.equal(c.parseMoney(s).error, code, `«${s}»`);
  assert.equal(c.parseMoney('1 000 000 000').kop, c.MAX_KOP);
  assert.equal(c.parsePercent('10').bp, 1000);
  assert.equal(c.parsePercent('12,5').bp, 1250);
  assert.equal(c.parsePercent('100').bp, 10000);
  assert.equal(c.parsePercent('100,01').error, 'max');
  assert.equal(c.parsePercent('-1').error, 'negative');
  assert.equal(c.parsePercent('1,555').error, 'decimals');
  assert.equal(c.parsePercent('').error, 'empty');
});

test('срок: целое от 1 до 1 200; 0, дробь, минус, текст — ошибки', () => {
  assert.equal(c.parseMonths('12').months, 12);
  assert.equal(c.parseMonths('1').months, 1);
  assert.equal(c.parseMonths('1 200').months, 1200);
  for (const [s, code] of Object.entries({ '0': 'zero', '1,5': 'fraction', '1.5': 'fraction', '-3': 'negative', '1201': 'max', 'abc': 'format', '': 'empty', '12m': 'format', '1e2': 'format' })) {
    assert.equal(c.parseMonths(s).error, code, `«${s}»`);
  }
});

test('на пределах арифметика точная: нет потери точности и нет NaN', () => {
  const big = '1 000 000 000';
  const r = A(big, '100', 1200, big);
  assert.equal(r.monthlyKop, c.MAX_KOP);
  assert.equal(r.totalKop, c.MAX_KOP + c.MAX_KOP * 1200);
  assert.ok(Number.isSafeInteger(r.totalKop));
  const g = B(big, '0', 1, '0,01');
  assert.equal(g.monthlyKop, c.MAX_KOP);
  assert.ok(Number.isSafeInteger(g.shareBp) && g.status === 'over');
  assert.ok(!/NaN|Infinity/.test(txt(c.viewGoal(g))));
});

test('текст ошибок понятен и без служебных слов', () => {
  for (const [code, kind] of [['empty'], ['negative'], ['format'], ['decimals'], ['max', 'money'], ['max', 'percent'], ['max', 'months'], ['zero'], ['fraction']]) {
    const t = c.errorText(code, kind);
    assert.ok(t.length > 10 && /[А-Яа-я]/.test(t), `${code}/${kind}: ${t}`);
    assert.ok(!/undefined|\[object/.test(t));
  }
});

test('отображение: группы разрядов неразрывным пробелом, копейки только если есть', () => {
  assert.equal(c.formatKop(8000000), '80 000 ₽');
  assert.equal(c.formatKop(833334), '8 333,34 ₽');
  assert.equal(c.formatKop(5), '0,05 ₽');
  assert.equal(c.formatBp(1500), '15 %');
  assert.equal(c.formatBp(1667), '16,67 %');
  assert.equal(c.formatBp(20000), '200 %');
});
