import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import express from 'express';
import { makeDb } from './helpers/testDb.mjs';
import { createRateLimiter } from '../src/auth/rateLimit.js';
import { createAuthRouter } from '../src/auth/authRouter.js';

const JWT_SECRET = 'test-secret';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function makeRouter(db, limitsOverride = {}) {
  const app = express();
  app.use(express.json());

  const sentEmails = [];
  const mailer = {
    sendWelcomeEmail: async (args) => { sentEmails.push({ type: 'welcome', ...args }); },
    sendPasswordResetEmail: async (args) => { sentEmails.push({ type: 'reset', ...args }); },
  };

  const defaultLimits = {
    ipRegister:    createRateLimiter({ windowMs: 60_000, max: 100 }),
    emailRegister: createRateLimiter({ windowMs: 60_000, max: 100 }),
    ipLogin:       createRateLimiter({ windowMs: 60_000, max: 100 }),
    emailLogin:    createRateLimiter({ windowMs: 60_000, max: 100 }),
    ipForgot:      createRateLimiter({ windowMs: 60_000, max: 100 }),
    emailForgot:   createRateLimiter({ windowMs: 60_000, max: 100 }),
    ...limitsOverride,
  };

  const router = createAuthRouter({
    db,
    mailer,
    limits: defaultLimits,
    getBaseUrl: () => 'https://finnik.ru',
    getJwtSecret: () => JWT_SECRET,
  });

  app.use('/api/auth', router);
  return { app, sentEmails };
}

function request(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const payload = body ? JSON.stringify(body) : null;
      const options = {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      };
      const clientReq = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          server.close();
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });
      clientReq.on('error', (e) => { server.close(); reject(e); });
      if (payload) clientReq.write(payload);
      clientReq.end();
    });
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('register: создаёт пользователя, возвращает JWT и отправляет welcome email', async (t) => {
  const { db, close } = await makeDb(); t.after(close);
  const { app, sentEmails } = await makeRouter(db);

  const res = await request(app, 'POST', '/api/auth/register', {
    email: 'Alice@Example.com',
    password: 'password123',
    name: 'Alice',
  });

  assert.equal(res.status, 201);
  assert.ok(res.body.token);
  assert.equal(res.body.user.email, 'alice@example.com');
  assert.equal(res.body.user.name, 'Alice');

  const payload = jwt.verify(res.body.token, JWT_SECRET);
  assert.equal(payload.email, 'alice@example.com');

  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].type, 'welcome');
  assert.equal(sentEmails[0].to, 'alice@example.com');
});

test('register: повторный email → 409', async (t) => {
  const { db, close } = await makeDb(); t.after(close);
  const { app } = await makeRouter(db);

  await request(app, 'POST', '/api/auth/register', { email: 'dup@x.com', password: 'pass1234' });
  const res = await request(app, 'POST', '/api/auth/register', { email: 'dup@x.com', password: 'pass5678' });
  assert.equal(res.status, 409);
});

test('register: слабый пароль → 400', async (t) => {
  const { db, close } = await makeDb(); t.after(close);
  const { app } = await makeRouter(db);
  const res = await request(app, 'POST', '/api/auth/register', { email: 'a@b.com', password: '123' });
  assert.equal(res.status, 400);
});

test('register: некорректный email → 400', async (t) => {
  const { db, close } = await makeDb(); t.after(close);
  const { app } = await makeRouter(db);
  const res = await request(app, 'POST', '/api/auth/register', { email: 'notanemail', password: 'password123' });
  assert.equal(res.status, 400);
});

test('login: верные данные → JWT', async (t) => {
  const { db, close } = await makeDb(); t.after(close);
  const { app } = await makeRouter(db);

  await request(app, 'POST', '/api/auth/register', { email: 'user@test.com', password: 'secure123' });
  const res = await request(app, 'POST', '/api/auth/login', { email: 'user@test.com', password: 'secure123' });

  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  const payload = jwt.verify(res.body.token, JWT_SECRET);
  assert.equal(payload.email, 'user@test.com');
});

test('login: неверный пароль → 401 с общим сообщением', async (t) => {
  const { db, close } = await makeDb(); t.after(close);
  const { app } = await makeRouter(db);

  await request(app, 'POST', '/api/auth/register', { email: 'u@x.com', password: 'rightpass' });
  const res = await request(app, 'POST', '/api/auth/login', { email: 'u@x.com', password: 'wrongpass' });

  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Неверный e-mail или пароль');
});

test('login: несуществующий email → 401 с тем же сообщением (без утечки)', async (t) => {
  const { db, close } = await makeDb(); t.after(close);
  const { app } = await makeRouter(db);

  const res = await request(app, 'POST', '/api/auth/login', { email: 'ghost@x.com', password: 'anypass' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Неверный e-mail или пароль');
});

test('rate limit: ipRegister блокирует после max попыток', async (t) => {
  const { db, close } = await makeDb(); t.after(close);
  let now = 0;
  const mockNow = () => now;
  const { app } = await makeRouter(db, {
    ipRegister:    createRateLimiter({ windowMs: 60_000, max: 2, now: mockNow }),
    emailRegister: createRateLimiter({ windowMs: 60_000, max: 100, now: mockNow }),
  });

  const r1 = await request(app, 'POST', '/api/auth/register', { email: 'a1@x.com', password: 'pass1234' });
  assert.notEqual(r1.status, 429);
  now = 1000;
  const r2 = await request(app, 'POST', '/api/auth/register', { email: 'a2@x.com', password: 'pass1234' });
  assert.notEqual(r2.status, 429);
  now = 2000;
  const r3 = await request(app, 'POST', '/api/auth/register', { email: 'a3@x.com', password: 'pass1234' });
  assert.equal(r3.status, 429);
});

test('forgot: отправляет email если пользователь существует', async (t) => {
  const { db, close } = await makeDb(); t.after(close);
  const { app, sentEmails } = await makeRouter(db);

  await request(app, 'POST', '/api/auth/register', { email: 'target@x.com', password: 'pass1234' });
  sentEmails.length = 0; // clear welcome email

  const res = await request(app, 'POST', '/api/auth/forgot', { email: 'target@x.com' });
  assert.equal(res.status, 200);
  assert.ok(res.body.message);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].type, 'reset');
  assert.ok(sentEmails[0].resetUrl.includes('/cabinet/reset-password.html?token='));
});

test('forgot: несуществующий email → тот же ответ (без утечки)', async (t) => {
  const { db, close } = await makeDb(); t.after(close);
  const { app, sentEmails } = await makeRouter(db);

  const res = await request(app, 'POST', '/api/auth/forgot', { email: 'ghost@x.com' });
  assert.equal(res.status, 200);
  assert.ok(res.body.message);
  assert.equal(sentEmails.length, 0);
});

test('reset: полный flow — смена пароля, повторное использование заблокировано', async (t) => {
  const { db, close } = await makeDb(); t.after(close);
  const { app, sentEmails } = await makeRouter(db);

  await request(app, 'POST', '/api/auth/register', { email: 'reset@x.com', password: 'oldpass1' });
  sentEmails.length = 0;

  await request(app, 'POST', '/api/auth/forgot', { email: 'reset@x.com' });
  const resetUrl = sentEmails[0].resetUrl;
  const token = new URL(resetUrl).searchParams.get('token');
  assert.ok(token);

  // Смена пароля
  const r1 = await request(app, 'POST', '/api/auth/reset', { token, password: 'newpass99' });
  assert.equal(r1.status, 200);

  // Новый пароль работает
  const login = await request(app, 'POST', '/api/auth/login', { email: 'reset@x.com', password: 'newpass99' });
  assert.equal(login.status, 200);

  // Старый пароль не работает
  const bad = await request(app, 'POST', '/api/auth/login', { email: 'reset@x.com', password: 'oldpass1' });
  assert.equal(bad.status, 401);

  // Повторный reset той же ссылкой — 400
  const r2 = await request(app, 'POST', '/api/auth/reset', { token, password: 'other999' });
  assert.equal(r2.status, 400);
});

test('reset: неверный токен → 400', async (t) => {
  const { db, close } = await makeDb(); t.after(close);
  const { app } = await makeRouter(db);
  const res = await request(app, 'POST', '/api/auth/reset', { token: 'invalidtoken', password: 'newpass99' });
  assert.equal(res.status, 400);
});

test('login: пользователь без password_hash (Telegram) → 401', async (t) => {
  const { db, close } = await makeDb(); t.after(close);
  const { app } = await makeRouter(db);

  // Создаём telegram-пользователя без password_hash
  await db.from('users').insert({ external_id: '999', channel: 'telegram', email: 'tg@x.com' });

  const res = await request(app, 'POST', '/api/auth/login', { email: 'tg@x.com', password: 'anything' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'Неверный e-mail или пароль');
});
