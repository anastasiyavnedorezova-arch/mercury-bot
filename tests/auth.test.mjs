import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { makeDb } from './helpers/testDb.mjs';
import { createAuthRouter } from '../src/auth/authRouter.js';
import { hashToken } from '../src/auth/authCore.js';
import { createRateLimiter } from '../src/auth/rateLimit.js';

const SECRET = 'test-secret';
let ctx;

before(async () => {
  ctx = await makeDb();
});
after(async () => {
  await ctx?.close();
});

// Приложение с новым роутером (свежие счётчики лимитов) и «почтальоном», запоминающим письма
async function start(limits = {}) {
  const sent = { welcome: [], reset: [] };
  const mailer = {
    sendWelcomeEmail: async (a) => { sent.welcome.push(a); return { ok: true }; },
    sendPasswordResetEmail: async (a) => { sent.reset.push(a); return { ok: true }; },
  };
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(createAuthRouter({ db: ctx.db, mailer, limits, getJwtSecret: () => SECRET, getBaseUrl: () => 'https://finnikbot.ru' }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, headers = {}) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    let json = null;
    try { json = await r.json(); } catch {}
    return { status: r.status, json, headers: r.headers };
  };
  return { post, sent, close: () => new Promise((r) => server.close(r)) };
}

let counter = 0;
const uniq = (p = 'u') => `${p}${Date.now()}${counter++}@Example.ru`;
const goodReg = (email, extra = {}) => ({ email, password: 'secret1', name: 'Анна', terms_accepted: true, consent_pd_accepted: true, ...extra });

test('регистрация: создаёт аккаунт, хеш bcrypt, токен, приветственное письмо', async () => {
  const s = await start();
  try {
    const email = uniq();
    const r = await s.post('/api/auth/register', goodReg(email, { telegram: '@anna_tg', email_letters_accepted: true }));
    assert.equal(r.status, 201);
    const payload = jwt.verify(r.json.token, SECRET);
    assert.ok(payload.userId);
    assert.equal(r.headers.get('cache-control'), 'no-store');

    const { data: u } = await ctx.db.from('users').select('*').eq('id', payload.userId).single();
    assert.equal(u.email, email.toLowerCase());           // e-mail хранится в нижнем регистре
    assert.equal(u.channel, 'web');
    assert.equal(u.external_id, u.id);
    assert.equal(u.web_username, 'Анна');
    assert.equal(u.tg_username, 'anna_tg');
    assert.equal(u.email_letters_accepted, true);
    assert.ok(u.terms_accepted_at);
    assert.ok(u.password_hash.startsWith('$2'));           // хеш bcrypt
    assert.ok(!JSON.stringify(u).includes('secret1'));     // пароль в открытом виде не хранится
    assert.equal(await bcrypt.compare('secret1', u.password_hash), true);

    await new Promise((r2) => setTimeout(r2, 20));
    assert.equal(s.sent.welcome.length, 1);
    assert.equal(s.sent.welcome[0].to, email.toLowerCase());
  } finally { await s.close(); }
});

test('регистрация: проверки полей, занятый e-mail (без учёта регистра), условия', async () => {
  const s = await start();
  try {
    const email = uniq('dup');
    assert.equal((await s.post('/api/auth/register', goodReg(email))).status, 201);
    const dup = await s.post('/api/auth/register', goodReg(email.toUpperCase()));
    assert.equal(dup.status, 409); assert.equal(dup.json.error, 'email_taken');

    const bad = [
      [{ ...goodReg(uniq()), email: '' }, 'email'],
      [{ ...goodReg(uniq()), email: 'не-почта' }, 'email'],
      [{ ...goodReg(uniq()), password: '12345' }, 'password'],
      [{ ...goodReg(uniq()), password: 'я'.repeat(40) }, 'password'],   // 80 байт > 72
      [{ ...goodReg(uniq()), terms_accepted: false }, 'terms'],
      [{ ...goodReg(uniq()), terms_accepted: undefined }, 'terms'],
      [{ ...goodReg(uniq()), consent_pd_accepted: false }, 'terms'],
      [{ ...goodReg(uniq()), consent_pd_accepted: undefined }, 'terms'],
    ];
    for (const [body, field] of bad) {
      const r = await s.post('/api/auth/register', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.json.field, field);
    }
  } finally { await s.close(); }
});

test('регистрация: то же самое при параллельных запросах — создаётся один аккаунт', async () => {
  const s = await start();
  try {
    const email = uniq('race');
    const rs = await Promise.all([1, 2, 3].map(() => s.post('/api/auth/register', goodReg(email))));
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409]);
    const { data } = await ctx.db.from('users').select('id').eq('email', email.toLowerCase());
    assert.equal(data.length, 1);
  } finally { await s.close(); }
});

test('вход: верный пароль, неверный пароль, неизвестный e-mail — одинаковая ошибка', async () => {
  const s = await start();
  try {
    const email = uniq('login');
    await s.post('/api/auth/register', goodReg(email));
    const ok = await s.post('/api/auth/login', { email: email.toUpperCase(), password: 'secret1' });
    assert.equal(ok.status, 200);
    assert.ok(jwt.verify(ok.json.token, SECRET).userId);

    const wrong = await s.post('/api/auth/login', { email, password: 'неверный' });
    const none = await s.post('/api/auth/login', { email: uniq('none'), password: 'secret1' });
    assert.equal(wrong.status, 401); assert.equal(none.status, 401);
    assert.deepEqual(wrong.json, none.json);

    assert.equal((await s.post('/api/auth/login', { email })).status, 400);
    assert.equal((await s.post('/api/auth/login', {})).status, 400);
  } finally { await s.close(); }
});

test('вход: пароли, перенесённые из Supabase ($2a$10$…), работают', async () => {
  const s = await start();
  try {
    const email = uniq('legacy').toLowerCase();
    const legacyHash = bcrypt.hashSync('старыйПароль1', 10);
    assert.ok(legacyHash.startsWith('$2'));
    await ctx.db.from('users').insert({ external_id: 'legacy-1', channel: 'web', email, password_hash: legacyHash });
    const ok = await s.post('/api/auth/login', { email, password: 'старыйПароль1' });
    assert.equal(ok.status, 200);
    assert.equal((await s.post('/api/auth/login', { email, password: 'другой' })).status, 401);
  } finally { await s.close(); }
});

test('вход: удалённые, объединённые и «только Telegram» аккаунты войти не могут', async () => {
  const s = await start();
  try {
    const hash = bcrypt.hashSync('secret1', 10);
    const e1 = uniq('del').toLowerCase(), e2 = uniq('mrg').toLowerCase(), e3 = uniq('tgo').toLowerCase();
    await ctx.db.from('users').insert({ external_id: 'd1', channel: 'web', email: e1, password_hash: hash, status: 'deleted' });
    await ctx.db.from('users').insert({ external_id: 'm1', channel: 'web', email: e2, password_hash: hash, status: 'merged' });
    await ctx.db.from('users').insert({ external_id: 't1', channel: 'telegram', email: e3 });  // без пароля
    for (const e of [e1, e2, e3]) assert.equal((await s.post('/api/auth/login', { email: e, password: 'secret1' })).status, 401);
    // e-mail удалённого аккаунта можно занять заново
    assert.equal((await s.post('/api/auth/register', goodReg(e1))).status, 201);
    // e-mail, который бот сохранил у пользователя Telegram, не мешает регистрации на сайте
    assert.equal((await s.post('/api/auth/register', goodReg(e3))).status, 201);
  } finally { await s.close(); }
});

test('ограничение попыток входа: после лимита ответ 429 с Retry-After; успешный вход сбрасывает счётчик e-mail', async () => {
  const s = await start({ loginEmail: { max: 3 } });
  try {
    const email = uniq('rl');
    await s.post('/api/auth/register', goodReg(email));
    for (let i = 0; i < 3; i++) assert.equal((await s.post('/api/auth/login', { email, password: 'x' + i + 'xxxxx' })).status, 401);
    const blocked = await s.post('/api/auth/login', { email, password: 'secret1' });   // даже верный пароль не пускает
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal(blocked.json.error, 'too_many_requests');
  } finally { await s.close(); }
  const s2 = await start({ loginEmail: { max: 3 } });
  try {
    const email = uniq('rl2');
    await s2.post('/api/auth/register', goodReg(email));
    await s2.post('/api/auth/login', { email, password: 'bad1bad1' });
    await s2.post('/api/auth/login', { email, password: 'bad2bad2' });
    assert.equal((await s2.post('/api/auth/login', { email, password: 'secret1' })).status, 200);   // сброс
    await s2.post('/api/auth/login', { email, password: 'bad3bad3' });
    await s2.post('/api/auth/login', { email, password: 'bad4bad4' });
    assert.equal((await s2.post('/api/auth/login', { email, password: 'secret1' })).status, 200);
  } finally { await s2.close(); }
});

test('сброс пароля: письмо, смена пароля, ссылка одноразовая, старый пароль не работает', async () => {
  const s = await start();
  try {
    const email = uniq('reset');
    await s.post('/api/auth/register', goodReg(email));

    const f = await s.post('/api/auth/forgot', { email: email.toUpperCase() });
    assert.equal(f.status, 200); assert.deepEqual(f.json, { ok: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(s.sent.reset.length, 1);
    const link = s.sent.reset[0].link;
    assert.match(link, /^https:\/\/finnikbot\.ru\/cabinet\/reset-password#token=[0-9a-f]{64}$/);
    const token = link.split('#token=')[1];

    // в базе только хеш токена
    const { data: rows } = await ctx.db.from('password_resets').select('token_hash, expires_at, used_at');
    assert.ok(rows.some((r) => r.token_hash === hashToken(token)));
    assert.ok(!rows.some((r) => r.token_hash === token));

    // слабый пароль не принимается, ссылка при этом не сгорает
    const weak = await s.post('/api/auth/reset', { token, password: '123' });
    assert.equal(weak.status, 400); assert.equal(weak.json.field, 'password');

    const done = await s.post('/api/auth/reset', { token, password: 'новыйПароль7' });
    assert.equal(done.status, 200);
    assert.equal((await s.post('/api/auth/login', { email, password: 'secret1' })).status, 401);
    assert.equal((await s.post('/api/auth/login', { email, password: 'новыйПароль7' })).status, 200);

    const again = await s.post('/api/auth/reset', { token, password: 'ещёОдин123' });   // повторное использование
    assert.equal(again.status, 400); assert.equal(again.json.error, 'invalid_token');
  } finally { await s.close(); }
});

test('сброс пароля: неизвестный e-mail не выдаёт себя; просроченная, чужая и новая ссылка', async () => {
  const s = await start();
  try {
    const ghost = await s.post('/api/auth/forgot', { email: uniq('ghost') });
    assert.equal(ghost.status, 200); assert.deepEqual(ghost.json, { ok: true });
    assert.equal((await s.post('/api/auth/forgot', { email: 'не-почта' })).status, 400);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(s.sent.reset.length, 0);

    const email = uniq('exp');
    await s.post('/api/auth/register', goodReg(email));
    await s.post('/api/auth/forgot', { email });
    await new Promise((r) => setTimeout(r, 20));
    const t1 = s.sent.reset[0].link.split('#token=')[1];
    // просрочиваем ссылку
    await ctx.db.from('password_resets').update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq('token_hash', hashToken(t1));
    assert.equal((await s.post('/api/auth/reset', { token: t1, password: 'пароль1234' })).status, 400);

    // новый запрос: старая ссылка перестаёт работать, новая — работает
    const email2 = uniq('two');
    await s.post('/api/auth/register', goodReg(email2));
    await s.post('/api/auth/forgot', { email: email2 });
    await new Promise((r) => setTimeout(r, 20));
    const a = s.sent.reset.at(-1).link.split('#token=')[1];
    await s.post('/api/auth/forgot', { email: email2 });
    await new Promise((r) => setTimeout(r, 20));
    const b = s.sent.reset.at(-1).link.split('#token=')[1];
    assert.notEqual(a, b);
    assert.equal((await s.post('/api/auth/reset', { token: a, password: 'пароль1234' })).status, 400);
    assert.equal((await s.post('/api/auth/reset', { token: b, password: 'пароль1234' })).status, 200);

    // мусор вместо токена
    for (const bad of ['', 'abc', 'x'.repeat(64), null, 123, undefined]) {
      assert.equal((await s.post('/api/auth/reset', { token: bad, password: 'пароль1234' })).status, 400);
    }
  } finally { await s.close(); }
});

test('сброс пароля: параллельные запросы с одной ссылкой — пароль меняется один раз', async () => {
  const s = await start();
  try {
    const email = uniq('par');
    await s.post('/api/auth/register', goodReg(email));
    await s.post('/api/auth/forgot', { email });
    await new Promise((r) => setTimeout(r, 20));
    const token = s.sent.reset[0].link.split('#token=')[1];
    const rs = await Promise.all(['парольА111', 'парольБ222', 'парольВ333'].map((password) => s.post('/api/auth/reset', { token, password })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 400, 400]);
  } finally { await s.close(); }
});

test('ограничения на запросы письма: по адресу письмо молча не уходит, по IP — 429', async () => {
  const s = await start({ forgotEmail: { max: 2 }, forgotIp: { max: 4 } });
  try {
    const email = uniq('fl');
    await s.post('/api/auth/register', goodReg(email));
    for (let i = 0; i < 3; i++) assert.equal((await s.post('/api/auth/forgot', { email })).status, 200);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(s.sent.reset.length, 2);                                   // третье письмо не отправлено
    assert.equal((await s.post('/api/auth/forgot', { email })).status, 200);
    assert.equal((await s.post('/api/auth/forgot', { email })).status, 429); // лимит по IP
  } finally { await s.close(); }
});

test('ограничитель: окно скользит, clear сбрасывает', () => {
  let t = 0;
  const rl = createRateLimiter({ windowMs: 1000, max: 2, now: () => t });
  assert.equal(rl.retryAfterSec('k'), 0);
  rl.record('k'); rl.record('k');
  assert.ok(rl.retryAfterSec('k') > 0);
  t = 1500;
  assert.equal(rl.retryAfterSec('k'), 0);
  rl.record('k'); rl.record('k');
  rl.clear('k');
  assert.equal(rl.retryAfterSec('k'), 0);
});

test('миграция: e-mail веб-аккаунтов уникален на уровне базы, у Telegram-пользователей — нет', async () => {
  const hash = bcrypt.hashSync('secret1', 4);
  const e = uniq('uq').toLowerCase();
  assert.equal((await ctx.db.from('users').insert({ external_id: 'q1', channel: 'web', email: e, password_hash: hash })).error, null);
  const dup = await ctx.db.from('users').insert({ external_id: 'q2', channel: 'web', email: e.toUpperCase(), password_hash: hash });
  assert.equal(dup.error.code, '23505');
  assert.equal((await ctx.db.from('users').insert({ external_id: 'q3', channel: 'telegram', email: e })).error, null);
  assert.equal((await ctx.db.from('users').insert({ external_id: 'q4', channel: 'telegram', email: e })).error, null);
});

test('requireAuth: принимает токены с userId и токены первой версии входа с id в поле sub', async () => {
  const { requireAuth } = await import('../src/authMiddleware.js');
  process.env.JWT_SECRET = SECRET;
  const run = (payload) => {
    const req = { headers: { authorization: 'Bearer ' + jwt.sign(payload, SECRET) } };
    let status = 200;
    const res = { status(c) { status = c; return this; }, json() { return this; } };
    let nexted = false;
    requireAuth(req, res, () => { nexted = true; });
    return { nexted, status, userId: req.userId };
  };
  assert.deepEqual(run({ userId: 'u1', telegramId: '5' }), { nexted: true, status: 200, userId: 'u1' });
  assert.equal(run({ sub: 'u2', email: 'a@b.ru' }).userId, 'u2');
  const bad = run({ foo: 1 });                           // токен без id пользователя отклоняется
  assert.equal(bad.nexted, false);
  assert.equal(bad.status, 401);
});
