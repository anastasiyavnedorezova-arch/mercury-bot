// Ребрендинг: сервис называется «Финник · Деньги», без слова «бот» в названии; robots/sitemap; stage не индексируется.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import { robotsTxt, sitemapXml, isStageHost, addSeoRoutes } from '../src/seo.js';
import { planTitle } from '../src/payments/yookassa.js';

const read = (p) => fs.readFileSync(p, 'utf8');
const NAME = 'Финник · Деньги';
const CABINET = fs.readdirSync('public/cabinet').filter((f) => f.endsWith('.html') && !f.includes('-page') && !f.startsWith('dashboard-') && f !== 'bot-widget.html');

test('лендинг: заголовок, описание и соцсети с названием «Финник · Деньги», без «бот» в названии', () => {
  const h = read('public/index.html');
  assert.match(h, /<title>Финник · Деньги — личный финансовый помощник<\/title>/);
  assert.match(h, /<meta name="description" content="Финник · Деньги — /);
  assert.match(h, /<meta property="og:title" content="Финник · Деньги — /);
  assert.match(h, /<meta property="og:site_name" content="Финник · Деньги"/);
  assert.match(h, /<link rel="canonical" href="https:\/\/finnikbot\.ru\/"/);
  assert.match(h, /<h1 class="hero__title">\s*Финник · Деньги&nbsp;—/);
  assert.ok(!/Финник бот|Бот Финник|Финник Бот/i.test(h), 'в названии не должно быть слова «бот»');
  const ld = h.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(ld, 'нет JSON-LD');
  const data = JSON.parse(ld[1]);
  assert.ok(data['@graph'].every((x) => x.name === NAME));
});

test('кабинет: у каждой страницы название в <title>, логотип с нужным alt', () => {
  for (const f of CABINET) {
    const h = read(`public/cabinet/${f}`);
    if (/<title>/.test(h)) assert.match(h, /<title>[^<]*Финник · Деньги/, f);
    assert.ok(!/<title>Финник — /.test(h), `${f}: старый заголовок`);
    assert.ok(!/alt="Финник" height="45"/.test(h), `${f}: старый alt у логотипа`);
  }
  assert.match(read('public/cabinet/dashboard.html'), /logo-finnik-main\.svg" alt="Финник · Деньги"/);
});

test('манифесты, виджет и страница чата называются «Финник · Деньги»', () => {
  assert.equal(JSON.parse(read('public/cabinet/manifest.json')).name, `${NAME} — Личный кабинет`);
  assert.match(JSON.parse(read('public/cabinet/bot-manifest.json')).name, /^Финник · Деньги/);
  assert.match(read('public/cabinet/bot-widget.js'), /bot-widget-name">Финник · Деньги</);
  assert.match(read('public/cabinet/bot.html'), /bot-name">Финник · Деньги</);
});

test('логотипы заменены на новые (с «Деньги») и подходят по размеру', () => {
  for (const f of ['logo-finnik-main.svg', 'logo-footer.svg']) {
    const s = read(`public/images/${f}`);
    assert.match(s, /<svg width="174" height="45" viewBox="0 0 174 45"/, f);
    assert.match(s, /M117\.008 17\.058/, `${f}: нет точки между словами`);
  }
});

test('юридические документы: сервис «Финник · Деньги», новая редакция', () => {
  for (const d of ['offer', 'privacy', 'consent', 'cookies']) {
    const t = read(`public/legal/${d}.html`);
    assert.match(t, /<title>[^<]*Финник · Деньги<\/title>/, d);
    assert.ok(!/«Финник»/.test(t), `${d}: осталось старое название`);
    // Оферта осталась в редакции 16.10; cookies обновлены 21.10.2026 (счётчик посещений, метки источника); политика и согласие — 23.10.2026 (названы страны передачи данных)
    const edition = { offer: '16.10.2026', cookies: '21.10.2026', privacy: '23.10.2026', consent: '28.10.2026' }[d];
    assert.match(t, new RegExp(`Редакция от ${edition.replace(/\./g, '\\.')}`), d);
  }
  assert.match(read('public/legal/offer.html'), /программное обеспечение «Финник · Деньги»/);
});

test('чек ЮKassa, имя отправителя и письма используют новое название', () => {
  assert.equal(planTitle(6), 'Подписка на сервис «Финник · Деньги», 6 мес.');
  assert.ok(planTitle(12).length <= 128);
  const mail = read('src/utils/email.js');
  assert.match(mail, /MAIL_FROM_NAME \|\| 'Финник · Деньги'/);
  assert.match(mail, /subject: 'Добро пожаловать в «Финник · Деньги»'/);
  assert.ok(!/Финнике|Поддержка Финника/.test(mail));
  assert.match(read('src/emails/letters.js'), /зарегистрировался в сервисе «Финник · Деньги»/);
});

test('robots.txt и sitemap.xml: боевой сайт открыт, кабинет закрыт, stage закрыт целиком', () => {
  assert.equal(isStageHost('stage.finnikbot.ru'), true);
  assert.equal(isStageHost('stage.finnikbot.ru:443'), true);
  assert.equal(isStageHost('finnikbot.ru'), false);
  assert.equal(isStageHost('www.finnikbot.ru'), false);
  const prod = robotsTxt('finnikbot.ru');
  assert.match(prod, /Disallow: \/cabinet\//);
  assert.match(prod, /Sitemap: https:\/\/finnikbot\.ru\/sitemap\.xml/);
  assert.ok(!/Disallow: \/\n/.test(prod));
  assert.match(robotsTxt('stage.finnikbot.ru'), /Disallow: \/\n/);
  const sm = sitemapXml();
  for (const p of ['/', '/legal/offer', '/legal/privacy', '/legal/consent', '/legal/cookies']) assert.ok(sm.includes(`<loc>https://finnikbot.ru${p}</loc>`), p);
  assert.ok(!sm.includes('/cabinet'));
});

test('robots и sitemap отдаются по HTTP; на stage есть X-Robots-Tag: noindex', async () => {
  const app = express();
  addSeoRoutes(app);
  app.get('/page', (req, res) => res.send('ok'));
  const srv = http.createServer(app).listen(0);
  const port = srv.address().port;
  const get = (path, host) => new Promise((resolve, reject) => {
    http.get({ port, path, headers: { host } }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: b })); }).on('error', reject);
  });
  try {
    const prod = await get('/robots.txt', 'finnikbot.ru');
    assert.equal(prod.status, 200);
    assert.match(prod.headers['content-type'], /text\/plain/);
    assert.match(prod.body, /Sitemap:/);
    assert.equal((await get('/page', 'finnikbot.ru')).headers['x-robots-tag'], undefined);
    const sm = await get('/sitemap.xml', 'finnikbot.ru');
    assert.equal(sm.status, 200);
    assert.match(sm.headers['content-type'], /xml/);
    const st = await get('/robots.txt', 'stage.finnikbot.ru');
    assert.match(st.body, /Disallow: \//);
    assert.equal((await get('/page', 'stage.finnikbot.ru')).headers['x-robots-tag'], 'noindex, nofollow');
    assert.equal((await get('/sitemap.xml', 'stage.finnikbot.ru')).status, 404);
  } finally { srv.close(); }
});
