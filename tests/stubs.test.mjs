import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const exists = (p) => fs.existsSync(new URL(`../${p}`, import.meta.url));

test('заглушка «Аналитика»: текст, картинка, активный пункт меню', () => {
  const s = read('public/cabinet/analytics.html');
  assert.ok(s.includes('Ведутся технические работы'));
  assert.ok(s.includes('Обещаем, скоро починим'));
  assert.ok(s.includes('/images/finnik-works.webp'));
  assert.ok(s.includes("initLayout('analytics')"));
  assert.ok(exists('public/images/finnik-works.webp'));
});

test('заглушка «Семейный бюджет»: текст, картинка, активный пункт меню', () => {
  const s = read('public/cabinet/family.html');
  assert.ok(s.includes('Семейный бюджет'));
  assert.ok(s.includes('Раздел в работе'));
  assert.ok(s.includes('Скоро будет доступным!'));
  assert.ok(s.includes("initLayout('family')"));
  assert.ok(!s.includes('технические работы'));
});

test('в меню всех страниц кабинета «Семейный доступ» ведёт на /cabinet/family (меню и мобильное меню)', () => {
  for (const n of ['dashboard', 'accounting', 'history', 'categories', 'goals', 'budget', 'how-to', 'faq', 'feedback', 'profile', 'analytics', 'family']) {
    const s = read(`public/cabinet/${n}.html`);
    assert.equal((s.match(/<a href="\/cabinet\/family"/g) || []).length, 2, `${n}: ссылка на family`);
    assert.ok(!/<a href="#"\s+class="nav-item is-dis-soon">/.test(s), `${n}: осталась неактивная ссылка`);
    assert.equal((s.match(/<a href="\/cabinet\/analytics"/g) || []).length, 2, `${n}: ссылка на analytics`);
  }
});

test('сервер отдаёт страницы /cabinet/analytics и /cabinet/family', () => {
  const w = read('src/webhook.js');
  for (const n of ['analytics', 'family']) {
    assert.ok(w.includes(`app.get('/cabinet/${n}',`), `маршрут ${n}`);
    assert.ok(w.includes(`public/cabinet/${n}.html`), `файл ${n}`);
    assert.ok(w.includes(`'/cabinet/${n}.html'`), `редирект ${n}.html`);
  }
});
