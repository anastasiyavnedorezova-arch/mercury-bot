// Ограничение частоты запросов: оплата, обратная связь, ссылка на Telegram, веб-чат, вход через Telegram, вебхуки.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { makeDb } from './helpers/testDb.mjs';
import { rateLimit, createFailureGuard, userKey, limitsOff, TOO_MANY_MESSAGE } from '../src/utils/httpLimits.js';
import { createPaymentRouter } from '../src/payments/routes.js';
import { createRusenderRouter } from '../src/emails/events.js';

process.env.JWT_SECRET = 'test-secret';
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const quiet = { warn() {} };

let ctx;
before(async () => { ctx = await makeDb(); });
after(async () => { await ctx?.close(); });

async function serve(app) {
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('rateLimit: после лимита 429 с Retry-After и понятным текстом, потом окно проходит', async () => {
  let t = 1_000_000;
  const app = express();
  app.post('/x', rateLimit({ name: 't', windowMs: 60_000, max: 3, now: () => t, logger: quiet }), (req, res) => res.json({ ok: true }));
  const srv = await serve(app);
  try {
    for (let i = 0; i < 3; i++) assert.equal((await fetch(`${srv.base}/x`, { method: 'POST' })).status, 200);
    const r = await fetch(`${srv.base}/x`, { method: 'POST' });
    assert.equal(r.status, 429);
    const body = await r.json();
    assert.equal(body.error, 'too_many');
    assert.equal(body.message, TOO_MANY_MESSAGE);
    assert.ok(body.retry_after >= 1 && body.retry_after <= 60);
    assert.equal(r.headers.get('retry-after'), String(body.retry_after));
    t += 61_000;
    assert.equal((await fetch(`${srv.base}/x`, { method: 'POST' })).status, 200, 'через окно снова можно');
  } finally { await srv.close(); }
});

test('rateLimit: ключи независимы (разные люди не мешают друг другу); свой текст и свой ответ onLimited', async () => {
  const app = express();
  app.use((req, res, next) => { req.userId = req.headers['x-user']; next(); });
  app.post('/a', rateLimit({ name: 'a', windowMs: 60_000, max: 1, key: userKey, message: 'свой текст', logger: quiet }), (req, res) => res.json({ ok: true }));
  app.post('/b', rateLimit({ name: 'b', windowMs: 60_000, max: 1, key: userKey, logger: quiet, onLimited: (req, res) => res.json({ ok: true, limited: true }) }), (req, res) => res.json({ ok: true }));
  const srv = await serve(app);
  const post = (path, user) => fetch(`${srv.base}${path}`, { method: 'POST', headers: { 'x-user': user } });
  try {
    assert.equal((await post('/a', 'u1')).status, 200);
    assert.equal((await post('/a', 'u2')).status, 200, 'второй человек не заблокирован');
    const blocked = await post('/a', 'u1');
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).message, 'свой текст');
    assert.equal((await (await post('/b', 'u1')).json()).limited, undefined);
    assert.equal((await (await post('/b', 'u1')).json()).limited, true);
  } finally { await srv.close(); }
});

test('RATE_LIMITS=off отключает ограничения', async () => {
  assert.equal(limitsOff({ RATE_LIMITS: 'off' }), true);
  assert.equal(limitsOff({ RATE_LIMITS: 'OFF' }), true);
  assert.equal(limitsOff({}), false);
  const mw = rateLimit({ name: 'off', windowMs: 60_000, max: 1, env: { RATE_LIMITS: 'off' }, logger: quiet });
  let passed = 0;
  for (let i = 0; i < 5; i++) mw({ ip: '1.1.1.1' }, {}, () => { passed++; });
  assert.equal(passed, 5);
  const guard = createFailureGuard({ name: 'g', max: 1, env: { RATE_LIMITS: 'off' }, logger: quiet });
  guard.fail('1.1.1.1'); guard.fail('1.1.1.1');
  assert.equal(guard.blocked('1.1.1.1'), false);
});

test('createFailureGuard: блокирует IP только после нужного числа ошибок', () => {
  let t = 5_000_000;
  const g = createFailureGuard({ name: 'g', windowMs: 60_000, max: 3, now: () => t, logger: quiet });
  assert.equal(g.blocked('9.9.9.9'), false);
  g.fail('9.9.9.9'); g.fail('9.9.9.9');
  assert.equal(g.blocked('9.9.9.9'), false);
  g.fail('9.9.9.9');
  assert.equal(g.blocked('9.9.9.9'), true);
  assert.equal(g.blocked('8.8.8.8'), false, 'другой IP не затронут');
  t += 61_000;
  assert.equal(g.blocked('9.9.9.9'), false);
});

async function newUser(email) {
  const id = crypto.randomUUID();
  const { error } = await ctx.db.from('users').insert({ id, external_id: `web-${id}`, channel: 'web', email, status: 'active' });
  assert.ifError(error);
  return id;
}
const tok = (id) => jwt.sign({ userId: id }, process.env.JWT_SECRET);
const postPay = (base, token, body = { months: 1 }) => fetch(`${base}/api/pay`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

test('/api/pay: больше 10 попыток за 10 минут с одного аккаунта — 429, платёж в ЮKassa не создаётся; другой человек не затронут', async () => {
  const a = await newUser('lim-a@example.com');
  const b = await newUser('lim-b@example.com');
  let created = 0;
  const create = async () => { created++; return { ok: true, id: 'pay-limit-1', url: 'https://yoomoney.ru/pay/1' }; };
  const app = express();
  app.use(express.json());
  app.use(createPaymentRouter({ db: ctx.db, create }));
  const srv = await serve(app);
  try {
    for (let i = 0; i < 10; i++) assert.equal((await postPay(srv.base, tok(a))).status, 200, `попытка ${i + 1}`);
    const r = await postPay(srv.base, tok(a));
    assert.equal(r.status, 429);
    assert.match((await r.json()).message, /Слишком много попыток/);
    assert.equal(created, 10, 'одиннадцатая попытка не дошла до ЮKassa');
    assert.equal((await postPay(srv.base, tok(b))).status, 200, 'другой аккаунт не блокируется');
  } finally { await srv.close(); }
});

test('/api/pay: общий лимит по IP; без входа сначала 401 (лимит не тратится)', async () => {
  const users = [await newUser('ip-1@example.com'), await newUser('ip-2@example.com'), await newUser('ip-3@example.com')];
  const app = express();
  app.use(express.json());
  app.use(createPaymentRouter({ db: ctx.db, create: async () => ({ ok: true, id: 'p', url: 'https://yoomoney.ru/pay/2' }), limits: { payIp: { max: 2 } } }));
  const srv = await serve(app);
  try {
    assert.equal((await fetch(`${srv.base}/api/pay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"months":1}' })).status, 401);
    assert.equal((await postPay(srv.base, tok(users[0]))).status, 200);
    assert.equal((await postPay(srv.base, tok(users[1]))).status, 200);
    assert.equal((await postPay(srv.base, tok(users[2]))).status, 429, 'третий запрос с того же IP');
  } finally { await srv.close(); }
});

test('вебхук RuSender: после череды неверных секретов IP блокируется, верный секрет работает до этого', async () => {
  process.env.RUSENDER_WEBHOOK_SECRET = 'right-secret-123456789012345';
  const guard = createFailureGuard({ name: 'rs', max: 3, logger: quiet });
  const app = express();
  app.use(express.json());
  app.use(createRusenderRouter({ db: ctx.db, guard }));
  const srv = await serve(app);
  const hit = (secret) => fetch(`${srv.base}/webhook/rusender/${secret}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]' });
  try {
    assert.notEqual((await hit('right-secret-123456789012345')).status, 404, 'верный секрет принят');
    for (let i = 0; i < 3; i++) assert.equal((await hit(`wrong-${i}`)).status, 404);
    assert.equal((await hit('right-secret-123456789012345')).status, 404, 'после 3 ошибок IP заблокирован');
  } finally { await srv.close(); }
});

test('лимиты подключены ко всем нужным маршрутам (по тексту кода)', () => {
  const cab = read('src/cabinetRoutes.js');
  for (const route of [
    "router.post('/api/auth/telegram', limitTelegramLogin,",
    "router.post('/api/feedback', requireAuth, limitFeedback,",
    "router.post('/api/profile/telegram-link', requireAuth, limitTelegramLink,",
    "router.post('/api/bot/send', requireAuth, limitChatSend,",
  ]) assert.ok(cab.includes(route), route);
  assert.match(cab, /name: 'chat-send', windowMs: 60_000, max: 30/);
  assert.match(cab, /webBot\.sendMessage\(chatId, 'Ты пишешь очень часто/, 'веб-чат отвечает сообщением бота, а не ошибкой');
  assert.match(read('src/webhook.js'), /app\.post\('\/webhook\/yookassa', rateLimit\(/);
  assert.match(read('src/payments/routes.js'), /router\.post\('\/api\/pay', requireAuth, payLimits,/);
  assert.match(read('src/emails/events.js'), /guard\.blocked\(ip\)/);
});

test('кабинет показывает понятный текст при 429 (обратная связь, подключение Telegram)', () => {
  assert.match(read('public/cabinet/feedback.html'), /res\.status === 429[\s\S]{0,300}Попробуй чуть позже/);
  assert.match(read('public/cabinet/profile.html'), /res\.status === 429[\s\S]{0,200}Слишком часто/);
});
