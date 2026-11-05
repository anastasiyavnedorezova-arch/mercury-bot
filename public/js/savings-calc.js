/* Калькулятор накоплений для статьи «Сколько откладывать с зарплаты».
 * Два режима: А — «Сколько я могу накопить», Б — «Сколько нужно откладывать для цели».
 * Без доходности, инфляции, налогов и комиссий: доход и взнос постоянны весь срок.
 *  - Деньги считаем целым числом копеек, процент — целым числом сотых долей процента (10% = 1000).
 *    При лимитах ниже промежуточные значения остаются в безопасном диапазоне целых чисел JavaScript.
 *    Лимиты не расширять без пересмотра арифметики.
 *  - Ничего не сохраняем между сессиями. В Метрику уходит только имя цели calc_done, без сумм.
 * Логика лежит в чистых функциях (их проверяют тесты), работа со страницей — внизу файла. */
(function (root) {
  'use strict';

  var MAX_KOP = 100000000000;   // 1 000 000 000 ₽ в копейках
  var MAX_MONTHS = 1200;
  var MAX_BP = 10000;           // 100%
  var NBSP = ' ';

  // ── Разбор ввода ──
  // Пробелы и неразрывные пробелы — разделители тысяч; запятая или точка — десятичный разделитель.
  function normalizeNumber(raw) {
    var s = String(raw == null ? '' : raw).replace(/[\s  ]/g, '');
    return s;
  }

  // Возвращает { ok: true, int, frac } (frac — строка из 0–2 цифр) или { ok: false, error }
  function splitDecimal(raw, maxFrac) {
    var s = normalizeNumber(raw);
    if (s === '') return { ok: false, error: 'empty' };
    if (/^[-−–]/.test(s)) return { ok: false, error: 'negative' };
    if (!/^[0-9.,]+$/.test(s)) return { ok: false, error: 'format' };
    var seps = s.match(/[.,]/g) || [];
    if (seps.length > 1) return { ok: false, error: 'format' };
    if (seps.length === 0) return { ok: true, int: s, frac: '' };
    var i = s.search(/[.,]/);
    var int = s.slice(0, i);
    var frac = s.slice(i + 1);
    if (int === '' || frac === '') return { ok: false, error: 'format' };
    if (frac.length > maxFrac) return { ok: false, error: 'decimals' };
    return { ok: true, int: int, frac: frac };
  }

  function stripZeros(intPart) {
    var t = intPart.replace(/^0+(?=\d)/, '');
    return t;
  }

  // Сумма в рублях → копейки. Ошибки: empty, negative, format, decimals, max
  function parseMoney(raw) {
    var p = splitDecimal(raw, 2);
    if (!p.ok) return p;
    var intPart = stripZeros(p.int);
    if (intPart.length > 10) return { ok: false, error: 'max' };
    var kop = Number(intPart) * 100 + Number((p.frac + '00').slice(0, 2));
    if (kop > MAX_KOP) return { ok: false, error: 'max' };
    return { ok: true, kop: kop };
  }

  // Процент → сотые доли процента (bp). 0–100
  function parsePercent(raw) {
    var p = splitDecimal(raw, 2);
    if (!p.ok) return p;
    var intPart = stripZeros(p.int);
    if (intPart.length > 4) return { ok: false, error: 'max' };
    var bp = Number(intPart) * 100 + Number((p.frac + '00').slice(0, 2));
    if (bp > MAX_BP) return { ok: false, error: 'max' };
    return { ok: true, bp: bp };
  }

  // Срок — целое число месяцев 1–1200
  function parseMonths(raw) {
    var s = normalizeNumber(raw);
    if (s === '') return { ok: false, error: 'empty' };
    if (/^[-−–]/.test(s)) return { ok: false, error: 'negative' };
    if (/^[0-9]+[.,][0-9]*$/.test(s)) return { ok: false, error: 'fraction' };
    if (!/^[0-9]+$/.test(s)) return { ok: false, error: 'format' };
    var n = Number(stripZeros(s));
    if (s.length > 6 || n < 1) return { ok: false, error: n === 0 ? 'zero' : 'max' };
    if (n > MAX_MONTHS) return { ok: false, error: 'max' };
    return { ok: true, months: n };
  }

  // ── Расчёты (всё в копейках) ──
  function calcSave(input) {
    var I = input.incomeKop, bp = input.bp, N = input.months, S = input.startKop;
    var M = Math.floor((I * bp + 5000) / 10000);   // округление «от половины вверх»
    var C = M * N;
    var note = null;
    if (I === 0) note = 'zeroIncome';
    else if (bp === 0) note = 'zeroPercent';
    else if (M === 0) note = 'subKopeck';
    return { monthlyKop: M, contribKop: C, totalKop: S + C, startKop: S, months: N, note: note };
  }

  function calcGoal(input) {
    var G = input.goalKop, A = input.savedKop, N = input.months, I = input.incomeKop;
    var D = Math.max(G - A, 0);
    if (D === 0) return { reached: true, remainingKop: 0, monthlyKop: 0, status: 'reached' };
    var M = Math.floor((D + N - 1) / N);            // ceil(D / N)
    var k = Math.ceil(D / M);                       // сколько взносов реально нужно
    var last = D - M * (k - 1);                     // последний положительный взнос
    var res = { reached: false, remainingKop: D, monthlyKop: M, payments: k, lastKop: last, months: N, incomeKop: I };
    if (I === 0) {
      res.status = 'zeroIncome';
    } else {
      res.shareBp = Math.round(M * 10000 / I);      // доля дохода в сотых долях процента, только для показа; статус считаем по копейкам
      res.leftKop = I - M;
      res.status = M <= I ? 'ok' : 'over';
    }
    return res;
  }

  // ── Показ ──
  function group(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  }
  function formatKop(kop) {
    var r = Math.floor(kop / 100);
    var k = kop % 100;
    return group(r) + (k ? ',' + (k < 10 ? '0' : '') + k : '') + NBSP + '₽';
  }
  function formatBp(bp) {
    var whole = Math.floor(bp / 100);
    var frac = bp % 100;
    return group(whole) + (frac ? ',' + (frac < 10 ? '0' : '') + frac : '') + NBSP + '%';
  }
  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  var ERR = {
    empty: 'Заполните это поле.',
    negative: 'Число не может быть отрицательным.',
    format: 'Введите число цифрами, например 50 000 или 1 500,50.',
    decimals: 'После запятой допустимо не больше двух знаков.',
    max: 'Слишком большое значение. Максимум для суммы — 1 000 000 000 ₽, для срока — 1 200 месяцев.',
    zero: 'Срок должен быть не меньше 1 месяца.',
    fraction: 'Срок — целое число месяцев, например 12.',
    percent: 'Доля накоплений — от 0 до 100%.',
    goalZero: 'Сумма цели должна быть больше нуля.'
  };
  function errorText(code, kind) {
    if (code === 'max' && kind === 'percent') return ERR.percent;
    if (code === 'max' && kind === 'months') return 'Срок — от 1 до 1 200 месяцев.';
    if (code === 'max') return 'Слишком большое значение. Максимум — 1 000 000 000 ₽.';
    if (code === 'zero' || code === 'fraction') return ERR[code];
    if (code === 'format' && kind === 'months') return 'Срок — целое число месяцев, например 12.';
    return ERR[code] || ERR.format;
  }

  // Подписи результата: массив строк { label, value, strong } и пояснения
  function viewSave(r) {
    var rows = [
      { label: 'Начальные накопления', value: formatKop(r.startKop) },
      { label: 'Ежемесячный взнос', value: formatKop(r.monthlyKop) },
      { label: 'Новые взносы за ' + r.months + ' ' + plural(r.months, 'месяц', 'месяца', 'месяцев'), value: formatKop(r.contribKop) },
      { label: 'Итого накоплений', value: formatKop(r.totalKop), strong: true }
    ];
    var notes = [];
    if (r.note === 'zeroIncome') notes.push('При нулевом доходе процентный взнос равен нулю.');
    if (r.note === 'zeroPercent') notes.push('При доле накоплений 0% взнос равен нулю.');
    if (r.note === 'subKopeck') notes.push('Взнос получился меньше одной копейки, поэтому округлился до нуля.');
    return { rows: rows, notes: notes, tone: 'ok' };
  }

  function viewGoal(r) {
    if (r.reached) {
      return { rows: [{ label: 'Ежемесячный взнос', value: formatKop(0), strong: true }],
        notes: ['Цель уже достигнута: дополнительные взносы не требуются.'], tone: 'ok' };
    }
    var rows = [
      { label: 'Осталось собрать', value: formatKop(r.remainingKop) },
      { label: 'Ежемесячный взнос', value: formatKop(r.monthlyKop), strong: true }
    ];
    var notes = [];
    var N = r.months, k = r.payments;
    var sched;
    if (k === 1) {
      sched = 'Достаточно одного взноса ' + formatKop(r.lastKop) + '. В остальные месяцы взносы не нужны.';
    } else if (k === N && r.lastKop === r.monthlyKop) {
      sched = k + ' ' + plural(k, 'взнос', 'взноса', 'взносов') + ' по ' + formatKop(r.monthlyKop) + '.';
    } else {
      sched = (k - 1) + ' ' + plural(k - 1, 'взнос', 'взноса', 'взносов') + ' по ' + formatKop(r.monthlyKop) +
        ' и последний ' + formatKop(r.lastKop) + '.' + (k < N ? ' В остальные месяцы взносы не нужны.' : '');
    }
    rows.push({ label: 'Расписание', value: sched, wide: true });
    var tone = 'ok';
    if (r.status === 'zeroIncome') {
      notes.push('Долю дохода нельзя определить при нулевом доходе.');
    } else {
      rows.push({ label: 'Доля дохода', value: formatBp(r.shareBp) });
      if (r.status === 'ok') {
        notes.push('После взноса остается ' + formatKop(r.leftKop) + ' до оплаты ваших расходов. Сравните с обязательными платежами и повседневным бюджетом.');
      } else {
        tone = 'warn';
        notes.push('Взнос превышает указанный месячный доход. При этих вводных цель нельзя оплатить только из этого дохода в выбранный срок. Измените срок, сумму или источники средств.');
      }
    }
    return { rows: rows, notes: notes, tone: tone };
  }

  var api = {
    parseMoney: parseMoney, parsePercent: parsePercent, parseMonths: parseMonths,
    calcSave: calcSave, calcGoal: calcGoal, viewSave: viewSave, viewGoal: viewGoal,
    formatKop: formatKop, formatBp: formatBp, errorText: errorText, MAX_KOP: MAX_KOP, MAX_MONTHS: MAX_MONTHS
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof document === 'undefined' || !root || root.finnikSavingsCalc) return;
  root.finnikSavingsCalc = api;

  // ── Работа на странице ──
  function init() {
    var box = document.querySelector('[data-savings-calc]');
    if (!box) return;

    var tabs = Array.prototype.slice.call(box.querySelectorAll('[role="tab"]'));
    var panels = Array.prototype.slice.call(box.querySelectorAll('[role="tabpanel"]'));

    function select(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
      });
      panels.forEach(function (p) { p.hidden = p.id !== tab.getAttribute('aria-controls'); });
      if (focus) tab.focus();
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(t, false); });
      t.addEventListener('keydown', function (e) {
        var j = -1;
        if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = tabs.length - 1;
        if (j >= 0) { e.preventDefault(); select(tabs[j], true); }
      });
    });

    function setError(field, msg) {
      var input = field.querySelector('input');
      var err = field.querySelector('.calc__err');
      if (msg) {
        err.textContent = msg; err.hidden = false;
        input.setAttribute('aria-invalid', 'true');
      } else {
        err.textContent = ''; err.hidden = true;
        input.removeAttribute('aria-invalid');
      }
    }

    function render(out, view) {
      out.textContent = '';
      var dl = document.createElement('dl');
      dl.className = 'calc__rows';
      view.rows.forEach(function (r) {
        var row = document.createElement('div');
        row.className = 'calc__row' + (r.strong ? ' is-strong' : '') + (r.wide ? ' is-wide' : '');
        var dt = document.createElement('dt'); dt.textContent = r.label;
        var dd = document.createElement('dd'); dd.textContent = r.value;
        row.appendChild(dt); row.appendChild(dd);
        dl.appendChild(row);
      });
      out.appendChild(dl);
      view.notes.forEach(function (n) {
        var p = document.createElement('p');
        p.className = 'calc__note' + (view.tone === 'warn' ? ' is-warn' : '');
        p.textContent = n;
        out.appendChild(p);
      });
      out.classList.add('is-on');
    }

    Array.prototype.slice.call(box.querySelectorAll('form[data-mode]')).forEach(function (form) {
      var mode = form.getAttribute('data-mode');
      var out = form.querySelector('.calc__result');
      var fields = {};
      Array.prototype.slice.call(form.querySelectorAll('[data-field]')).forEach(function (f) { fields[f.getAttribute('data-field')] = f; });

      function hideResult() { out.classList.remove('is-on'); out.textContent = ''; }
      form.addEventListener('input', hideResult);
      form.addEventListener('reset', function () {
        hideResult();
        Object.keys(fields).forEach(function (k) { setError(fields[k], ''); });
      });

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var parsed = {};
        var firstBad = null;
        function take(name, parser, kind, post) {
          var f = fields[name];
          var res = parser(f.querySelector('input').value);
          if (!res.ok) {
            setError(f, errorText(res.error, kind));
            if (!firstBad) firstBad = f.querySelector('input');
            return;
          }
          if (post) {
            var msg = post(res);
            if (msg) { setError(f, msg); if (!firstBad) firstBad = f.querySelector('input'); return; }
          }
          setError(f, '');
          parsed[name] = res;
        }
        if (mode === 'save') {
          take('income', parseMoney, 'money');
          take('percent', parsePercent, 'percent');
          take('months', parseMonths, 'months');
          take('start', parseMoney, 'money');
        } else {
          take('goal', parseMoney, 'money', function (r) { return r.kop > 0 ? '' : ERR.goalZero; });
          take('saved', parseMoney, 'money');
          take('months', parseMonths, 'months');
          take('income', parseMoney, 'money');
        }
        if (firstBad) { hideResult(); firstBad.focus(); return; }

        var view;
        if (mode === 'save') {
          view = viewSave(calcSave({ incomeKop: parsed.income.kop, bp: parsed.percent.bp, months: parsed.months.months, startKop: parsed.start.kop }));
        } else {
          view = viewGoal(calcGoal({ goalKop: parsed.goal.kop, savedKop: parsed.saved.kop, months: parsed.months.months, incomeKop: parsed.income.kop }));
        }
        render(out, view);
        // В Метрику уходит только имя цели, без сумм (только если человек согласился на cookie)
        try { if (typeof root.finnikGoal === 'function') root.finnikGoal('calc_done'); } catch (err) { /* не мешаем странице */ }
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : undefined);
