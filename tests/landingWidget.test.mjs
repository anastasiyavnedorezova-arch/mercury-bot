// Виджет на лендинге: приветствие как в онбординге бота, на любое действие — ответ про вход/регистрацию.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  GREETING_TEXT, GREETING_BUTTONS, AUTH_TEXT, AUTH_LINKS, replyFor, hasSession, SESSION_TOKEN_KEY,
} from '../public/js/landing-widget.js';

const onboarding = fs.readFileSync('src/handlers/onboarding.js', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');
const css = fs.readFileSync('public/css/landing-widget.css', 'utf8');
const norm = (s) => s.replace(/\s+/g, ' ').trim();

test('приветствие и кнопки совпадают с онбордингом бота', () => {
  const intro = GREETING_TEXT.split('\n\n').slice(0, 3).join(' ');
  for (const part of ['Привет! Я Финник — твой личный финансовый помощник 👋', 'понять, куда уходят деньги', 'поставить финансовую цель и двигаться к ней', 'видеть понятную аналитику по доходам и расходам', '«продукты 2500»', '«зарплата 120000»']) {
    assert.ok(norm(onboarding).includes(part), `в онбординге бота нет: ${part}`);
    assert.ok(norm(GREETING_TEXT).includes(part), `в виджете нет: ${part}`);
  }
  assert.ok(intro.length > 0);
  assert.deepEqual(GREETING_BUTTONS, [
    'Как записывать расходы и доходы?',
    'Расскажи о целях',
    'Подробнее об аналитике',
    'Зачем устанавливать бюджет?',
    'Записать первую трату',
  ]);
  for (const label of GREETING_BUTTONS) assert.ok(onboarding.includes(label), `нет кнопки в онбординге: ${label}`);
});

test('любое действие ведёт к одному ответу: нужно войти, ссылки на регистрацию и вход', () => {
  for (const action of ['Записать первую трату', 'Расскажи о целях', 'такси 450', '☰ Главное меню', 'Установить бюджет', '']) {
    const r = replyFor(action);
    assert.equal(r.text, AUTH_TEXT);
    assert.deepEqual(r.links, AUTH_LINKS);
  }
  assert.match(AUTH_TEXT, /войти в личный кабинет или создать аккаунт/);
  assert.match(AUTH_TEXT, /30 дней пробного периода/);
  assert.deepEqual(AUTH_LINKS.map((l) => l.href), ['/cabinet/register', '/cabinet/login']);
  assert.ok(AUTH_LINKS.every((l) => l.href.startsWith('/')), 'ссылки относительные — на stage ведут на stage');
  assert.ok(!/(^|[^А-Яа-яЁё])(вы|вам|ваш[а-яё]*)(?![А-Яа-яЁё])/i.test(AUTH_TEXT + GREETING_TEXT), 'обращение на «ты»');
});

test('вошедшему посетителю кнопка ведёт в настоящий чат (есть токен)', () => {
  const store = (v) => ({ getItem: (k) => (k === SESSION_TOKEN_KEY ? v : null) });
  assert.equal(hasSession(store('a.b.c')), true);
  assert.equal(hasSession(store(null)), false);
  assert.equal(hasSession(null), false);
  assert.equal(hasSession({ getItem() { throw new Error('blocked'); } }), false);
});

test('лендинг подключает виджет: стили, модуль, слои над шапкой и под окном тарифов', () => {
  assert.match(html, /<link rel="stylesheet" href="css\/landing-widget\.css" \/>/);
  assert.match(html, /<script type="module" src="js\/landing-widget\.js"><\/script>/);
  assert.match(css, /\.lw-fab\s*\{[^}]*position:\s*fixed;[^}]*right:\s*20px;[^}]*bottom:/);
  assert.match(css, /\.lw-fab\s*\{[^}]*z-index:\s*150/);   // выше шапки (100), ниже окон (200)
  assert.match(css, /\.lw-overlay\s*\{[^}]*z-index:\s*300/);
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.lw-page\s*\{[^}]*height:\s*100dvh/); // на телефоне на весь экран
});

test('виджет ничего не отправляет на сервер', () => {
  const js = fs.readFileSync('public/js/landing-widget.js', 'utf8');
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon/.test(js));
});
