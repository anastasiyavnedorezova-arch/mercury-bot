import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { evaluate, revertOnSendFailure, buildEmail, FAIL_THRESHOLD, REMINDER_EVERY_MS } from '../src/utils/healthLogic.js';
import { checkTelegram, checkOpenAI, checkApp, runChecks } from '../src/utils/healthChecks.js';

const ok = (name) => ({ name, ok: true });
const bad = (name, detail = 'x') => ({ name, ok: false, detail });

test('одиночный сбой не вызывает тревогу, второй подряд — вызывает', () => {
  let r = evaluate({}, [bad('telegram')], 1000);
  assert.equal(r.actions.length, 0);
  assert.equal(FAIL_THRESHOLD, 2);
  r = evaluate(r.state, [bad('telegram', 'нет ответа')], 2000);
  assert.deepEqual(r.actions.map((a) => [a.kind, a.name, a.since]), [['alert', 'telegram', 1000]]);
});

test('пока проблема держится, повторных писем нет, через 6 часов — напоминание', () => {
  let r = evaluate({}, [bad('openai')], 0);
  r = evaluate(r.state, [bad('openai')], 300000);
  assert.equal(r.actions[0].kind, 'alert');
  r = evaluate(r.state, [bad('openai')], 600000);
  assert.equal(r.actions.length, 0);
  r = evaluate(r.state, [bad('openai')], 300000 + REMINDER_EVERY_MS);
  assert.equal(r.actions[0].kind, 'reminder');
  r = evaluate(r.state, [bad('openai')], 300000 + REMINDER_EVERY_MS + 1000);
  assert.equal(r.actions.length, 0);
});

test('восстановление шлёт письмо только если тревога была', () => {
  let r = evaluate({}, [bad('app')], 0);
  r = evaluate(r.state, [ok('app')], 1000);
  assert.equal(r.actions.length, 0); // сбой был один — тревоги не было
  r = evaluate({}, [bad('app')], 0);
  r = evaluate(r.state, [bad('app')], 1000);
  r = evaluate(r.state, [ok('app')], 2000);
  assert.deepEqual(r.actions.map((a) => [a.kind, a.name]), [['recovered', 'app']]);
  r = evaluate(r.state, [ok('app')], 3000);
  assert.equal(r.actions.length, 0);
});

test('проверки независимы друг от друга', () => {
  let r = evaluate({}, [bad('telegram'), ok('openai')], 0);
  r = evaluate(r.state, [bad('telegram'), ok('openai')], 1000);
  assert.deepEqual(r.actions.map((a) => a.name), ['telegram']);
});

test('если письмо не ушло, состояние откатывается и следующий запуск пробует снова', () => {
  const prev = evaluate({}, [bad('telegram')], 0).state;
  const { state, actions } = evaluate(prev, [bad('telegram')], 1000);
  assert.equal(actions[0].kind, 'alert');
  const reverted = revertOnSendFailure(prev, state, actions);
  assert.equal(reverted.checks.telegram.alerted, false);
  const again = evaluate(reverted, [bad('telegram')], 2000);
  assert.equal(again.actions[0].kind, 'alert');
});

test('если письмо о восстановлении не ушло, тревога считается висящей', () => {
  let s = evaluate({}, [bad('db')], 0).state;
  const mid = evaluate(s, [bad('db')], 1000);
  s = mid.state;
  const rec = evaluate(s, [ok('db')], 2000);
  assert.equal(rec.actions[0].kind, 'recovered');
  const reverted = revertOnSendFailure(s, rec.state, rec.actions);
  assert.equal(reverted.checks.db.alerted, true);
  assert.equal(evaluate(reverted, [ok('db')], 3000).actions[0].kind, 'recovered');
});

test('письмо: тема, русские подсказки, без секретов', () => {
  const m = buildEmail([{ kind: 'alert', name: 'telegram', detail: 'нет ответа за 10 секунд', since: 0 }], 1000);
  assert.match(m.subject, /^🔴 Финник: проблема — Связь бота с Telegram$/);
  assert.match(m.text, /relay\.finnikbot\.ru/);
  const rec = buildEmail([{ kind: 'recovered', name: 'openai', since: 0 }], 1000);
  assert.match(rec.subject, /^🟢 Финник: восстановлено/);
});

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s));
  });
}
const urlOf = (s) => `http://127.0.0.1:${s.address().port}`;

test('checkTelegram: getMe через ретранслятор, токен не попадает в detail', async () => {
  let seen;
  const s = await server((req, res) => { seen = req.url; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result: {} })); });
  process.env.TELEGRAM_API_BASE_URL = `${urlOf(s)}/telegram`;
  try {
    assert.deepEqual(await checkTelegram({ TELEGRAM_BOT_TOKEN: 'SECRET123' }), { name: 'telegram', ok: true });
    assert.equal(seen, '/telegram/botSECRET123/getMe');
  } finally { s.close(); }
  process.env.TELEGRAM_API_BASE_URL = 'http://127.0.0.1:1/telegram'; // порт закрыт
  const r = await checkTelegram({ TELEGRAM_BOT_TOKEN: 'SECRET123' });
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes('SECRET123'));
  delete process.env.TELEGRAM_API_BASE_URL;
});

test('checkTelegram: ответ 502 — сбой', async () => {
  const s = await server((req, res) => { res.statusCode = 502; res.end('bad gateway'); });
  process.env.TELEGRAM_API_BASE_URL = `${urlOf(s)}/telegram`;
  try {
    const r = await checkTelegram({ TELEGRAM_BOT_TOKEN: 't' });
    assert.equal(r.ok, false);
    assert.match(r.detail, /502/);
  } finally { s.close(); delete process.env.TELEGRAM_API_BASE_URL; }
});

test('checkOpenAI: GET /models с ключом; 401 и обрыв — сбой, ключ не светится', async () => {
  let auth;
  const s = await server((req, res) => { auth = req.headers.authorization; res.statusCode = req.url === '/v1/models' && auth === 'Bearer KEY1' ? 200 : 401; res.end('{}'); });
  try {
    assert.equal((await checkOpenAI({ OPENAI_API_KEY: 'KEY1', OPENAI_BASE_URL: `${urlOf(s)}/v1/` })).ok, true);
    const r = await checkOpenAI({ OPENAI_API_KEY: 'WRONG', OPENAI_BASE_URL: `${urlOf(s)}/v1` });
    assert.equal(r.ok, false);
    assert.match(r.detail, /401/);
    assert.ok(!JSON.stringify(r).includes('WRONG'));
  } finally { s.close(); }
  const dead = await checkOpenAI({ OPENAI_API_KEY: 'K', OPENAI_BASE_URL: 'http://127.0.0.1:1/v1' });
  assert.equal(dead.ok, false);
});

test('checkApp и runChecks: SKIP и FORCE_FAIL', async () => {
  const s = await server((req, res) => { res.end('ok'); });
  try {
    const env = { PORT: String(s.address().port) };
    assert.equal((await checkApp(env)).ok, true);
    const res = await runChecks({ ...env, HEALTHCHECK_SKIP: 'db,telegram,openai' });
    assert.deepEqual(res, [{ name: 'app', ok: true }]);
    const forced = await runChecks({ ...env, HEALTHCHECK_SKIP: 'db,openai', HEALTHCHECK_FORCE_FAIL: 'telegram' });
    assert.equal(forced.find((r) => r.name === 'telegram').ok, false);
    assert.equal(forced.find((r) => r.name === 'app').ok, true);
  } finally { s.close(); }
  assert.equal((await checkApp({ PORT: '1' })).ok, false);
});
