// Кабинет в обращении «ты» (патч 4b-2). Юридические документы остаются на «вы».
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const dir = new URL('../public/cabinet/', import.meta.url);
const files = fs.readdirSync(dir).filter((f) => /\.(html|js)$/.test(f));

const L = '[А-Яа-яЁё]';
const formal = new RegExp(`(?<!${L})(вы|вас|вам|вами|ваш${L}*|${L}{3,}(?:ите|йте|ьте|итесь|йтесь)|${L}{3,}(?:ете|ётесь|етесь))(?!${L})`, 'gi');
const NOT_VERBS = new Set(['кабинете', 'виджете', 'сайте']);
// «вы сравниваете» в ответе про семейный бюджет — про семью, множественное число допустимо
const ALLOWED_LINES = [/каждый записывает свои расходы, а в конце месяца вы сравниваете результаты/];

test('кабинет: нет обращения на «вы» (вы/ваш, повелительные на -ите/-йте/-ьте)', () => {
  const found = [];
  for (const f of files) {
    const lines = fs.readFileSync(new URL(f, dir), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/svg|<path|base64/.test(line) || ALLOWED_LINES.some((re) => re.test(line))) return;
      for (const m of line.matchAll(formal)) {
        if (!NOT_VERBS.has(m[1].toLowerCase())) found.push(`${f}:${i + 1} «${m[1]}»`);
      }
    });
  }
  assert.deepEqual(found, []);
});

test('старые копии страниц кабинета (*-page.html) удалены: живые страницы отдаются по маршрутам', () => {
  const dead = fs.readdirSync(dir).filter((f) => /-page\.html$/.test(f));
  assert.deepEqual(dead, []);
});
