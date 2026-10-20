// Сообщения сервера (ошибки входа и оплаты, письма, страница отписки) в обращении «ты» (патч 4b-3).
// Юридические документы остаются на «вы». Служебные сообщения для владельца (healthLogic) не проверяются.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('../src/', import.meta.url);
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir)]));
}
const files = walk(root).filter((u) => u.pathname.endsWith('.js') && !u.pathname.endsWith('/utils/healthLogic.js'));

const L = '[А-Яа-яЁё]';
const formal = new RegExp(`(?<!${L})(вы|вас|вам|вами|ваш${L}*|${L}{3,}(?:ите|йте|ьте|итесь|йтесь)|${L}{3,}(?:ете|ётесь|етесь))(?!${L})`, 'gi');
const NOT_VERBS = new Set(['кабинете', 'виджете', 'сайте']);

test('сообщения сервера: нет обращения на «вы»', () => {
  const found = [];
  for (const u of files) {
    fs.readFileSync(u, 'utf8').split('\n').forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      for (const m of line.matchAll(formal)) {
        if (!NOT_VERBS.has(m[1].toLowerCase())) found.push(`${path.relative(root.pathname, u.pathname)}:${i + 1} «${m[1]}»`);
      }
    });
  }
  assert.deepEqual(found, []);
});
