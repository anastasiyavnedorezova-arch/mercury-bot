// Виджет на лендинге: приветствие как в онбординге бота, на любое действие — ответ про вход/регистрацию.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  GREETING_TEXT, GREETING_BUTTONS, FLOW, AUTH, AUTH_TEXT, AUTH_LINKS, replyFor, hasSession, SESSION_TOKEN_KEY,
} from '../public/js/landing-widget.js';

const onboarding = fs.readFileSync('src/handlers/onboarding.js', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');
const css = fs.readFileSync('public/css/landing-widget.css', 'utf8');
// Текст из исходника бота: склеиваем строки-литералы, чтобы сравнивать со строками виджета
const botSource = onboarding.replace(/`\s*\+\s*`/g, '').replace(/\\n/g, '\n');
const flat = (t) => t.replace(/\s+/g, ' ').trim();

test('приветствие и кнопки совпадают с онбордингом бота', () => {
  for (const part of ['Привет! Я бот сервиса Финник Деньги 👋', '«продукты 2500»', '«зарплата 120000»', 'Категорию и сумму я определю сам, а ты поправишь, если нужно']) {
    assert.ok(flat(botSource).includes(part), `в онбординге бота нет: ${part}`);
    assert.ok(flat(GREETING_TEXT).includes(part), `в виджете нет: ${part}`);
  }
  assert.deepEqual(GREETING_BUTTONS.map((b) => b.label), ['✍️ Записать первую трату', 'Что ещё умею']);
  for (const b of GREETING_BUTTONS) assert.ok(onboarding.includes(b.label), `нет кнопки в онбординге: ${b.label}`);
  // «Что ещё умею» раскрывает те же четыре вопроса, что и в боте
  assert.deepEqual(FLOW.more.buttons.map((b) => b.label), [
    'Как записывать расходы и доходы?', 'Расскажи о целях', 'Подробнее об аналитике', 'Зачем устанавливать бюджет?',
  ]);
  for (const b of FLOW.more.buttons) assert.ok(onboarding.includes(b.label), `нет кнопки в онбординге: ${b.label}`);
});

test('информационные кнопки отвечают как настоящий бот: тот же текст и те же кнопки', () => {
  const infoNodes = ['how_to_record', 'about_goals', 'about_analytics', 'about_budget'];
  for (const id of infoNodes) {
    const node = FLOW[id];
    assert.ok(node, id);
    // каждое предложение ответа есть в исходнике бота
    for (const line of node.text.split('\n').map(flat).filter(Boolean)) {
      assert.ok(flat(botSource).includes(line), `${id}: в онбординге бота нет строки «${line}»`);
    }
    assert.ok(!node.text.includes('нужно войти в личный кабинет'), `${id}: информационный ответ не должен просить регистрацию`);
    assert.ok(node.buttons.length >= 1, `${id}: после ответа бот предлагает действие`);
  }
  for (const b of Object.values(FLOW).flatMap((n) => n.buttons || [])) {
    assert.ok(onboarding.includes(b.label), `нет кнопки в онбординге: ${b.label}`);
  }
});

test('действия (цель, бюджет, запись из аналитики, меню) ведут к «войди или зарегистрируйся»', () => {
  const actions = Object.values(FLOW).flatMap((n) => n.buttons || []).concat(GREETING_BUTTONS).filter((b) => b.to === AUTH);
  assert.deepEqual(actions.map((b) => b.label).sort(), [
    'Задать бюджет', 'Записать расход или доход', 'Поставить цель',
  ].sort());
  // «Записать первую трату» и «Записать первый расход или доход» ведут в демо (патч 57), а не к регистрации
  const demo = Object.values(FLOW).flatMap((n) => n.buttons || []).concat(GREETING_BUTTONS).filter((b) => b.to === 'try');
  assert.deepEqual(demo.map((b) => b.label).sort(), ['Записать первый расход или доход', '✍️ Записать первую трату'].sort());
  for (const to of [AUTH, undefined, 'unknown']) {
    const r = replyFor(to);
    assert.equal(r.text, AUTH_TEXT);
    assert.deepEqual(r.links, AUTH_LINKS);
    assert.deepEqual(r.buttons, []);
  }
  assert.match(AUTH_TEXT, /войти в личный кабинет или создать аккаунт/);
  assert.match(AUTH_TEXT, /30 дней пробного периода/);
  assert.deepEqual(AUTH_LINKS.map((l) => l.href), ['/cabinet/register', '/cabinet/login']);
  assert.ok(AUTH_LINKS.every((l) => l.href.startsWith('/')), 'ссылки относительные — на stage ведут на stage');
});

test('ветки «позже» отвечают текстом без регистрации, все переходы ведут в существующие ответы', () => {
  for (const id of ['goal_later', 'analytics_later', 'budget_later']) {
    assert.ok(FLOW[id].text && !FLOW[id].buttons, id);
    assert.ok(!/напомню/i.test(FLOW[id].text), 'посетителю без аккаунта напоминание отправить некуда');
  }
  for (const b of Object.values(FLOW).flatMap((n) => n.buttons || []).concat(GREETING_BUTTONS)) {
    assert.ok(b.to === AUTH || FLOW[b.to], `переход в никуда: ${b.label} → ${b.to}`);
  }
  assert.ok(!/(^|[^А-Яа-яЁё])(вы|вам|ваш[а-яё]*)(?![А-Яа-яЁё])/i.test(AUTH_TEXT + GREETING_TEXT + Object.values(FLOW).map((n) => n.text).join(' ')), 'обращение на «ты»');
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
