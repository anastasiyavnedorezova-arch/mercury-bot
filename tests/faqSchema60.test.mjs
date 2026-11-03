// Патч 60: разметка FAQPage на главной. Текст в разметке должен совпадать с тем, что видит человек в блоке FAQ.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');

const clean = (t) => t
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
  .replace(/\s+/g, ' ').trim();

function visibleFaq() {
  const start = html.indexOf('<section class="faq" id="faq">');
  assert.ok(start > 0, 'блок FAQ не найден');
  const sec = html.slice(start, html.indexOf('</section>', start));
  const re = /<div class="faq__item">\s*<button class="faq__q"[^>]*>([\s\S]*?)<span class="faq__arrow"[^>]*><\/span><\/button>\s*<div class="faq__a"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  return [...sec.matchAll(re)].map((m) => ({ q: clean(m[1]), a: clean(m[2]) }));
}

function jsonLd() {
  const m = html.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/);
  assert.ok(m, 'JSON-LD не найден');
  return JSON.parse(m[1]);
}

test('в JSON-LD на главной есть FAQPage рядом с WebSite и SoftwareApplication', () => {
  const types = jsonLd()['@graph'].map((n) => n['@type']);
  assert.deepEqual(types, ['WebSite', 'SoftwareApplication', 'FAQPage']);
});

test('вопросы и ответы в разметке совпадают с текстом на странице слово в слово', () => {
  const vis = visibleFaq();
  assert.equal(vis.length, 20, 'на странице должно быть 20 вопросов');
  const faq = jsonLd()['@graph'].find((n) => n['@type'] === 'FAQPage');
  assert.equal(faq.mainEntity.length, vis.length);
  vis.forEach((v, i) => {
    const e = faq.mainEntity[i];
    assert.equal(e['@type'], 'Question');
    assert.equal(e.name, v.q, `вопрос ${i + 1}`);
    assert.equal(e.acceptedAnswer['@type'], 'Answer');
    assert.equal(e.acceptedAnswer.text, v.a, `ответ ${i + 1}`);
    assert.ok(v.q.length > 3 && v.a.length > 10, `пустой текст в вопросе ${i + 1}`);
  });
});

test('в разметке нет HTML-тегов и повторяющихся вопросов', () => {
  const faq = jsonLd()['@graph'].find((n) => n['@type'] === 'FAQPage');
  const names = faq.mainEntity.map((e) => e.name);
  assert.equal(new Set(names).size, names.length);
  for (const e of faq.mainEntity) assert.doesNotMatch(e.acceptedAnswer.text, /<[a-z\/]/i);
});

test('в разметке вопросов нет «раздутых» текстов: вопрос короткий, ответ в разумных пределах', () => {
  const faq = jsonLd()['@graph'].find((n) => n['@type'] === 'FAQPage');
  for (const [i, e] of faq.mainEntity.entries()) {
    assert.ok(e.name.length <= 120, `вопрос ${i + 1} слишком длинный: ${e.name.length}`);
    assert.ok(e.acceptedAnswer.text.length >= 20 && e.acceptedAnswer.text.length <= 800, `длина ответа ${i + 1}`);
  }
});
