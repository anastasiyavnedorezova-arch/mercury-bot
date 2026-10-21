// Баннер cookie, Яндекс Метрика (только после согласия), метки источника (utm), документы и цели.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import express from 'express';
import jwt from 'jsonwebtoken';
import { makeDb } from './helpers/testDb.mjs';
import { createAuthRouter } from '../src/auth/authRouter.js';
import { sanitizeUtm, parseStartPayload } from '../src/utils/utm.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SCRIPT = read('public/js/consent.js');
const COUNTER = 113714004;

// ── Чистые функции скрипта ────────────────────────────────────────────────
function pure() {
  const ctx = { module: { exports: {} }, URL, URLSearchParams };
  vm.runInNewContext(SCRIPT, ctx);
  return ctx.module.exports;
}

test('метки из адреса и сайт-источник: разбор, очистка, слияние', () => {
  const c = pure();
  const u = c.parseUtm('?utm_source=yandex&utm_medium=cpc&utm_campaign=brand1&x=1', 'https://yandex.ru/search', 'finnikbot.ru', '/');
  assert.deepEqual({ ...u }, { utm_source: 'yandex', utm_medium: 'cpc', utm_campaign: 'brand1', ref: 'yandex.ru', landing: '/' });
  assert.deepEqual({ ...c.parseUtm('', 'https://www.google.com/x', 'finnikbot.ru', '/') }, { ref: 'google.com', landing: '/' });
  assert.equal(c.parseUtm('', 'https://finnikbot.ru/a', 'finnikbot.ru', '/'), null, 'свой сайт не источник');
  assert.equal(c.parseUtm('', 'https://stage.finnikbot.ru/a', 'finnikbot.ru', '/'), null, 'поддомен своего сайта не источник');
  assert.equal(c.parseUtm('', '', 'finnikbot.ru', '/'), null);
  assert.equal(c.cleanValue('<script>"x"</script>'), 'scriptx/script');
  assert.equal(c.parseUtm('?utm_source=' + encodeURIComponent('<script>"x"</script>'), '', 'finnikbot.ru', '/').utm_source, 'scriptx/script');
  assert.equal(c.cleanValue('a'.repeat(300)).length, 100);
  // слияние: реклама заменяет прежнее, домен-источник не затирает рекламу
  const ad = { utm_source: 'yandex' }; const refOnly = { ref: 'google.com' };
  assert.equal(c.mergeUtm(null, ad), ad);
  assert.equal(c.mergeUtm(ad, refOnly), ad);
  assert.deepEqual({ ...c.mergeUtm(ad, { utm_source: 'vk' }) }, { utm_source: 'vk' });
  assert.equal(c.mergeUtm(ad, null), ad);
  assert.equal(c.mergeUtm(null, null), null);
});

test('параметр ссылки на бота: скрипт строит, сервер разбирает', () => {
  const c = pure();
  assert.equal(c.startParam({ utm_source: 'yandex', utm_medium: 'cpc', utm_campaign: 'Brand_1' }), 'u_yandex_cpc_brand1');
  assert.equal(c.startParam({ utm_source: 'yandex' }), 'u_yandex');
  assert.equal(c.startParam({ ref: 'google.com' }), 'r_googlecom');
  assert.equal(c.startParam({ utm_source: 'Яндекс' }), '');
  assert.equal(c.startParam(null), '');
  assert.ok(c.startParam({ utm_source: 'a'.repeat(50), utm_medium: 'b'.repeat(50), utm_campaign: 'c'.repeat(50) }).length <= 64);
  assert.deepEqual(parseStartPayload('u_yandex_cpc_brand1'), { utm_source: 'yandex', utm_medium: 'cpc', utm_campaign: 'brand1', via: 'tg_start' });
  assert.deepEqual(parseStartPayload('u_yandex'), { utm_source: 'yandex', via: 'tg_start' });
  assert.deepEqual(parseStartPayload('r_googlecom'), { ref: 'googlecom', via: 'tg_start' });
  for (const bad of [undefined, '', 'link_abc', 'u_', 'u_YANDEX', 'u_a_b_c_d', 'x_y', 'u_' + 'a'.repeat(70), 'u_ya ndex']) assert.equal(parseStartPayload(bad), null, String(bad));
});

test('sanitizeUtm: только известные поля, обрезка, мусор отбрасывается', () => {
  assert.equal(sanitizeUtm(null), null);
  assert.equal(sanitizeUtm([]), null);
  assert.equal(sanitizeUtm('x'), null);
  assert.equal(sanitizeUtm({ foo: 'bar' }), null);
  assert.equal(sanitizeUtm({ landing: '/' }), null, 'одна страница входа без источника ничего не значит');
  const u = sanitizeUtm({ utm_source: ' yandex ', utm_campaign: '<b>x</b>', evil: 'y', utm_term: 'a'.repeat(500), at: '2026-10-21T10:00:00Z', ref: 'google.com' });
  assert.equal(u.utm_source, 'yandex');
  assert.equal(u.utm_campaign, 'bx/b');
  assert.equal(u.utm_term.length, 100);
  assert.equal(u.evil, undefined);
  assert.equal(u.at, '2026-10-21T10:00:00.000Z');
  assert.equal(u.via, 'web_register');
  assert.equal(sanitizeUtm({ utm_source: 'a', at: 'не дата' }).at, undefined);
});

// ── Скрипт на «странице»: что грузится и когда ────────────────────────────
function makePage({ stored = {}, search = '', referrer = '' } = {}) {
  const store = { ...stored };
  const mk = (tag) => ({
    tag, children: [], attrs: {}, listeners: {}, className: '', id: '', textContent: '', type: '', href: '', parentNode: null, async: 0, src: '',
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    insertBefore(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
    setAttribute(k, v) { this.attrs[k] = v; if (k === 'id') this.id = v; },
    getAttribute(k) { return k === 'href' && this.href && !(k in this.attrs) ? this.href : (this.attrs[k] ?? null); },
    hasAttribute(k) { return k in this.attrs; },
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
  });
  const head = mk('head'); const body = mk('body'); const firstScript = mk('script'); head.appendChild(firstScript);
  const docListeners = {};
  const document = {
    head, body, scripts: [], readyState: 'complete', referrer, cookie: '',
    createElement: mk, createTextNode: (t) => ({ text: t }), getElementById: () => null,
    getElementsByTagName: () => [firstScript],
    addEventListener(t, f) { (docListeners[t] ||= []).push(f); },
  };
  const window = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    URL, URLSearchParams, Date,
  };
  window.window = window;
  const location = { search, hostname: 'finnikbot.ru', pathname: '/', href: 'https://finnikbot.ru/' };
  const ctx = { window, document, location, URL, URLSearchParams, Date, module: undefined };
  vm.runInNewContext(SCRIPT.replace('})(typeof window !== \'undefined\' ? window : undefined);', '})(window);'), Object.assign(ctx, window, { document, location }));
  const all = (n, out = []) => { out.push(n); (n.children || []).forEach((c) => all(c, out)); return out; };
  return {
    window: ctx.window, store, docListeners,
    banner: () => all(body).find((n) => n.id === 'finnik-consent'),
    button: (cls) => all(body).find((n) => n.className === cls),
    metrikaScripts: () => all(head).filter((n) => n.tag === 'script' && String(n.src).includes('mc.yandex.ru')),
    ymCalls: () => Array.from((ctx.window.ym && ctx.window.ym.a) || [], (a) => Array.from(a)),
    ctx,
  };
}

test('без согласия: баннер есть, Метрика не загружается; «Только необходимые» её не включает', () => {
  const p = makePage();
  assert.ok(p.banner(), 'баннер показан');
  assert.equal(p.metrikaScripts().length, 0, 'Метрика не загружена');
  assert.equal(p.ymCalls().length, 0);
  p.button('fc-reject').listeners.click[0]();
  assert.equal(JSON.parse(p.store.finnik_consent).choice, 'necessary');
  assert.equal(p.banner(), undefined, 'баннер закрыт');
  assert.equal(p.metrikaScripts().length, 0);
  assert.equal(p.ymCalls().length, 0);
});

test('«Принять»: загружается счётчик без Вебвизора, карты кликов и электронной коммерции', () => {
  const p = makePage();
  p.button('fc-accept').listeners.click[0]();
  assert.equal(JSON.parse(p.store.finnik_consent).choice, 'all');
  const scripts = p.metrikaScripts();
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].src, `https://mc.yandex.ru/metrika/tag.js?id=${COUNTER}`);
  const init = p.ymCalls().find((a) => a[1] === 'init');
  assert.equal(init[0], COUNTER);
  assert.equal(init[2].webvisor, false);
  assert.equal(init[2].clickmap, false);
  assert.equal(init[2].ecommerce, undefined);
  assert.equal(init[2].trackLinks, true);
});

test('сохранённый выбор: «all» сразу грузит счётчик без баннера; «necessary» не грузит и без баннера', () => {
  const yes = makePage({ stored: { finnik_consent: JSON.stringify({ v: 1, choice: 'all' }) } });
  assert.equal(yes.banner(), undefined);
  assert.equal(yes.metrikaScripts().length, 1);
  const no = makePage({ stored: { finnik_consent: JSON.stringify({ v: 1, choice: 'necessary' }) } });
  assert.equal(no.banner(), undefined);
  assert.equal(no.metrikaScripts().length, 0);
  const junk = makePage({ stored: { finnik_consent: 'не json' } });
  assert.ok(junk.banner(), 'испорченное значение = выбора нет, баннер показан');
  assert.equal(junk.metrikaScripts().length, 0);
});

test('цели: без согласия никуда не уходят; после согласия уходят только известные имена', () => {
  const none = makePage();
  none.window.finnikGoal('register');
  assert.equal(none.ymCalls().length, 0);
  const yes = makePage({ stored: { finnik_consent: JSON.stringify({ choice: 'all' }) } });
  yes.window.finnikGoal('register'); yes.window.finnikGoal('pay_start'); yes.window.finnikGoal('paid'); yes.window.finnikGoal('bot_click');
  yes.window.finnikGoal('secret_amount_1234');
  const goals = yes.ymCalls().filter((a) => a[1] === 'reachGoal').map((a) => a[2]);
  assert.deepEqual(goals, ['register', 'pay_start', 'paid', 'bot_click']);
});

test('метки сохраняются в браузере; ссылка на бота получает параметр start, чужой параметр не перетирается', () => {
  const p = makePage({ search: '?utm_source=yandex&utm_medium=cpc&utm_campaign=brand1', referrer: 'https://yandex.ru/' });
  const saved = JSON.parse(p.store.finnik_utm);
  assert.equal(saved.utm_source, 'yandex');
  assert.ok(saved.at);
  assert.deepEqual({ ...p.window.finnikConsent.getUtm() }, saved);
  const click = p.docListeners.click[0];
  const mkLink = (href) => { const a = { attrs: { href }, getAttribute: (k) => a.attrs[k] ?? null, setAttribute: (k, v) => { a.attrs[k] = v; }, hasAttribute: (k) => k in a.attrs }; return a; };
  const plain = mkLink('https://t.me/FinnikMoneyBot');
  click({ target: { closest: () => plain } });
  assert.equal(plain.attrs.href, 'https://t.me/FinnikMoneyBot?start=u_yandex_cpc_brand1');
  const withStart = mkLink('https://t.me/FinnikMoneyBot?start=link_abc');
  click({ target: { closest: () => withStart } });
  assert.equal(withStart.attrs.href, 'https://t.me/FinnikMoneyBot?start=link_abc');
  const other = mkLink('https://example.com/');
  click({ target: { closest: () => other } });
  assert.equal(other.attrs.href, 'https://example.com/');
});

test('ссылка «Настройки cookie» снова показывает баннер', () => {
  const p = makePage({ stored: { finnik_consent: JSON.stringify({ choice: 'all' }) } });
  assert.equal(p.banner(), undefined);
  const link = { attrs: { 'data-cookie-settings': '' }, hasAttribute: (k) => k in link.attrs, getAttribute: () => null };
  let prevented = false;
  p.docListeners.click[0]({ target: { closest: () => link }, preventDefault: () => { prevented = true; } });
  assert.ok(prevented);
  assert.ok(p.banner());
});

// ── Сервер: источник при регистрации ──────────────────────────────────────
let ctx;
before(async () => { ctx = await makeDb(); });
after(async () => { await ctx?.close(); });

async function register(body) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  const mailer = { sendWelcomeEmail: async () => ({ ok: true }) };
  app.use(createAuthRouter({ db: ctx.db, mailer, getJwtSecret: () => 'test-secret', getBaseUrl: () => 'https://finnikbot.ru' }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await r.json();
    const { userId } = jwt.verify(json.token, 'test-secret');
    const { rows } = await ctx.query('select utm from users where id = $1', [userId]);
    return rows[0].utm;
  } finally { await new Promise((r) => server.close(r)); }
}
let n = 0;
const base = () => ({ email: `utm${Date.now()}${n++}@example.ru`, password: 'secret1', terms_accepted: true, consent_pd_accepted: true });

test('регистрация сохраняет источник; без источника и с мусором поле пустое', async () => {
  const u = await register({ ...base(), utm: { utm_source: 'yandex', utm_medium: 'cpc', utm_campaign: 'brand1', ref: 'yandex.ru', landing: '/', at: '2026-10-21T10:00:00.000Z' } });
  assert.equal(u.utm_source, 'yandex');
  assert.equal(u.utm_campaign, 'brand1');
  assert.equal(u.ref, 'yandex.ru');
  assert.equal(u.via, 'web_register');
  assert.equal(await register(base()), null);
  assert.equal(await register({ ...base(), utm: 'строка' }), null);
  assert.equal(await register({ ...base(), utm: { x: 1 } }), null);
  const trimmed = await register({ ...base(), utm: { utm_source: 'z'.repeat(1000), evil: 'x' } });
  assert.equal(trimmed.utm_source.length, 100);
  assert.equal(trimmed.evil, undefined);
});

test('первый /start в боте: источник записывается в новый аккаунт (по тексту кода)', () => {
  const s = read('src/handlers/start.js');
  assert.match(s, /parseStartPayload\(payload\)/);
  assert.match(s, /utm: JSON\.stringify\(utm\)/);
  const mig = read('db/migrations/009_utm.sql');
  assert.match(mig, /ADD COLUMN IF NOT EXISTS utm jsonb/);
});

// ── Страницы, документы, заголовки ────────────────────────────────────────
function pages() {
  const out = ['public/index.html'];
  for (const dir of ['public/cabinet', 'public/legal']) {
    for (const f of fs.readdirSync(new URL(`../${dir}`, import.meta.url))) {
      if (f.endsWith('.html')) out.push(`${dir}/${f}`);
    }
  }
  return out.filter((f) => !/(bot-widget|dashboard-sidebar|tg-callback)\.html$/.test(f));
}

test('скрипт баннера подключён на всех страницах, самого кода Метрики на страницах нет', () => {
  const list = pages();
  assert.ok(list.length >= 20, `страниц: ${list.length}`);
  for (const f of list) {
    const t = read(f);
    assert.equal((t.match(/<script src="\/js\/consent\.js" defer><\/script>/g) || []).length, 1, f);
    assert.ok(!/mc\.yandex\.ru/.test(t), `${f}: код Метрики не должен быть на странице`);
  }
  assert.ok(!/webvisor:\s*true|ecommerce|ssr:\s*true/.test(SCRIPT));
});

test('заголовок защиты кабинета разрешает Метрику и только её', () => {
  const w = read('src/webhook.js');
  assert.match(w, /script-src[^;]*https:\/\/mc\.yandex\.ru[^;]*https:\/\/yastatic\.net/);
  assert.match(w, /connect-src 'self' https:\/\/mc\.yandex\.ru https:\/\/mc\.yandex\.com/);
  assert.ok(!/frame-src[^;]*yandex/.test(w), 'фреймы Метрики (Вебвизор) не разрешаем');
});

test('цели подключены: регистрация, начало оплаты, успешная оплата', () => {
  assert.match(read('public/cabinet/register.html'), /finnikGoal\('register'\)/);
  assert.match(read('public/cabinet/register.html'), /finnikConsent\.getUtm\(\)/);
  const prof = read('public/cabinet/profile.html');
  assert.match(prof, /finnikGoal\('pay_start'\)/);
  assert.match(prof, /subscription\.status === 'active'[\s\S]{0,200}finnikGoal\('paid'\)/);
});

test('документы: про счётчик сказано честно, ссылка на настройки есть на сайте и в документах', () => {
  const cookies = read('public/legal/cookies.html');
  assert.match(cookies, /Редакция от 21\.10\.2026/);
  assert.match(cookies, /Яндекс Метрики/);
  assert.match(cookies, /Вебвизор/);
  assert.ok(!/не устанавливаем счетчики/.test(cookies), 'старая фраза про отсутствие счётчиков');
  assert.match(read('public/legal/privacy.html'), /Сервис веб-аналитики/);
  assert.match(read('public/legal/privacy.html'), /Редакция от 21\.10\.2026/);
  assert.match(read('public/legal/consent.html'), /Редакция от 21\.10\.2026/);
  for (const f of ['public/index.html', 'public/legal/offer.html', 'public/legal/privacy.html', 'public/legal/consent.html', 'public/legal/cookies.html']) {
    assert.match(read(f), /data-cookie-settings/, f);
  }
});
