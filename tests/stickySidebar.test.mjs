// Сайдбар и хедер кабинета липкие (position: sticky). Любой overflow: hidden у родителя (html, body, .page-layout)
// делает родителя «прокручиваемым контейнером», и sticky перестаёт работать: сайдбар уезжает вверх при прокрутке
// (заметно при небольшом окне, когда страница длиннее экрана). Вместо hidden нужен overflow: clip.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const dir = new URL('../public/cabinet/', import.meta.url);
const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));

// Убирает @media-блоки: на узком экране сайдбара нет, там overflow: hidden не мешает.
function stripMedia(css) {
  let out = ''; let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@media', i);
    if (at === -1) { out += css.slice(i); break; }
    out += css.slice(i, at);
    let j = css.indexOf('{', at); let depth = 1; j += 1;
    while (j < css.length && depth > 0) { if (css[j] === '{') depth += 1; else if (css[j] === '}') depth -= 1; j += 1; }
    i = j;
  }
  return out;
}
const rules = (css, selectorRe) => [...css.matchAll(new RegExp(`(?<![\\w.#-])(${selectorRe})\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[2]);
const hidden = /overflow(-x|-y)?\s*:\s*hidden/;

test('страницы кабинета с липким сайдбаром: у .page-layout и html/body нет overflow: hidden (нужен clip)', () => {
  const checked = [];
  for (const f of pages) {
    const html = fs.readFileSync(new URL(f, dir), 'utf8');
    const css = stripMedia([...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n'));
    if (!/\.lk-sidebar\s*\{[^}]*position:\s*sticky/.test(css)) continue;
    checked.push(f);
    for (const body of [...rules(css, '\\.page-layout'), ...rules(css, 'html\\s*,\\s*body'), ...rules(css, 'html'), ...rules(css, 'body')]) {
      assert.doesNotMatch(body, hidden, `${f}: overflow: hidden у родителя ломает sticky сайдбара, используй overflow: clip`);
    }
  }
  assert.ok(checked.length >= 10, `проверено страниц с липким сайдбаром: ${checked.length}`);
});
