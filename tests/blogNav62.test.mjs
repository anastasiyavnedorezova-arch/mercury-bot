// Патч 62: кнопка «Блог» в шапке (компьютер и телефон) и в подвале; в списке документов статей нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');
const PAGES = { 'главная': 'index.html', 'статья': 'blog/kak-vesti-uchet-rashodov/index.html' };
const read = (f) => fs.readFileSync(path.join(pub, f), 'utf8');

test('иконка блога: SVG 24×24 лежит рядом с остальными иконками подвала', () => {
  const svg = read('images/icon_blog.svg');
  assert.match(svg, /^<svg width="24" height="24" viewBox="0 0 24 24"/);
  assert.ok(fs.existsSync(path.join(pub, 'images/icon_mail.svg')) && fs.existsSync(path.join(pub, 'images/icon_telegram.svg')));
});

for (const [name, file] of Object.entries(PAGES)) {
  test(`${name}: «Блог» в шапке на компьютере и в меню телефона ведёт на /blog/`, () => {
    const html = read(file);
    const desk = html.match(/<nav class="header__nav"[\s\S]*?<\/nav>/)[0];
    const mob = html.match(/<nav class="header__mobile-nav">[\s\S]*?<\/nav>/)[0];
    assert.match(desk, /<a href="\/blog\/" class="header__nav-link">Блог<\/a>/);
    assert.match(mob, /<a href="\/blog\/">Блог<\/a>/);
    // «Блог» последний пункт меню
    assert.ok(desk.trim().replace(/\s+/g, ' ').endsWith('>Блог</a> </nav>'));
  });

  test(`${name}: в подвале кнопка «Блог» с иконкой стоит первой среди контактов`, () => {
    const html = read(file);
    const box = html.match(/<div class="footer__contacts">[\s\S]*?<\/div>/)[0];
    const pills = [...box.matchAll(/<a href="([^"]+)" class="footer__contact-pill"[^>]*>[\s\S]*?<span>([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(pills, [['/blog/', 'Блог'], ['mailto:hello@finnikbot.ru', 'hello@finnikbot.ru'], ['https://t.me/FinnikMoneyBot', 'Запустить бота']]);
    assert.match(box, /<img src="\/?images\/icon_blog\.svg" width="24" height="24" alt="" aria-hidden="true"/);
  });

  test(`${name}: в списке документов подвала только документы и настройки cookie`, () => {
    const html = read(file);
    const docs = html.match(/<div class="footer__docs">[\s\S]*?<\/div>/)[0];
    const hrefs = [...docs.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(hrefs, ['/legal/offer', '/legal/privacy', '/legal/consent', '/legal/cookies', '#']);
    assert.ok(!docs.includes('blog'));
  });
}

test('шапка: на ширине до 1100px вместо меню и кнопок показывается бургер (главная и статья)', () => {
  const hero = read('css/hero.css');
  const i = hero.indexOf('@media (min-width: 769px) and (max-width: 1100px)');
  assert.ok(i > 0, 'нет блока для планшетов в hero.css');
  const block = hero.slice(i, hero.indexOf('АДАПТИВ — 768px', i));
  assert.match(block, /\.header__nav,\s*\.header__actions \{ display: none; \}/);
  assert.match(block, /\.header__burger \{\s*display: flex;/);
  assert.match(block, /\.header__mobile \{/);
  const blog = read('css/blog.css');
  const j = blog.indexOf('@media (max-width: 1100px) {\n  .header {');
  assert.ok(j > 0, 'нет блока бургера в blog.css');
  assert.match(blog.slice(j, j + 900), /\.header__nav, \.header__actions \{ display: none; \}/);
  assert.match(blog.slice(j, j + 1200), /\.header__burger \{ display: flex;/);
});
