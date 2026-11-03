// Патч 61: статья №1 в блоге (/blog/kak-vesti-uchet-rashodov/): разметка для поиска, картинки, адреса, сервер.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { addSeoRoutes, sitemapXml } from '../src/seo.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');
const URL_PATH = '/blog/kak-vesti-uchet-rashodov/';
const FULL_URL = 'https://finnikbot.ru' + URL_PATH;
const html = fs.readFileSync(path.join(pub, URL_PATH, 'index.html'), 'utf8');

const clean = (t) => t
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
  .replace(/\s+/g, ' ').trim();
const meta = (attr, name) => (html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`)) || [])[1];
const jsonLd = () => JSON.parse(html.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/)[1]);
const exists = (p) => fs.existsSync(path.join(pub, p));

test('шапка страницы: title, описание, canonical, robots, соцсети', () => {
  assert.match(html, /^<!DOCTYPE html>\s*<html lang="ru">/i);
  const title = html.match(/<title>(.*?)<\/title>/)[1];
  assert.ok(title.startsWith('Как вести учет расходов без таблиц и не бросить'), title);
  assert.ok(title.length <= 80, 'title слишком длинный: ' + title.length);
  const d = meta('name', 'description');
  assert.ok(d.length >= 70 && d.length <= 170, 'длина description: ' + d.length);
  assert.match(html, new RegExp(`<link rel="canonical" href="${FULL_URL}">`));
  assert.match(meta('name', 'robots'), /^index, follow/);
  assert.equal(meta('property', 'og:type'), 'article');
  assert.equal(meta('property', 'og:url'), FULL_URL);
  assert.equal(meta('property', 'og:title'), 'Как вести учет расходов без таблиц и не бросить');
  assert.equal(meta('property', 'og:description'), d);
  assert.equal(meta('name', 'twitter:card'), 'summary_large_image');
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1, 'ровно один заголовок H1');
});

test('картинка для соцсетей: настоящий JPEG 1200×630 по боевому адресу', () => {
  const og = meta('property', 'og:image');
  assert.match(og, /^https:\/\/finnikbot\.ru\/images\/blog\/og-blog-1\.jpg$/);
  const buf = fs.readFileSync(path.join(pub, new URL(og).pathname));
  assert.equal(buf[0], 0xff); assert.equal(buf[1], 0xd8);
  let i = 2, w = 0, h = 0;
  while (i < buf.length) { // ищем блок SOF с размерами
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) { h = buf.readUInt16BE(i + 5); w = buf.readUInt16BE(i + 7); break; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  assert.deepEqual([w, h], [1200, 630]);
  assert.ok(buf.length < 300 * 1024, 'файл тяжелее 300 КБ');
});

test('JSON-LD: Article, BreadcrumbList и FAQPage; дата совпадает с видимой', () => {
  const g = jsonLd()['@graph'];
  assert.deepEqual(g.map((n) => n['@type']), ['Article', 'BreadcrumbList', 'FAQPage']);
  const art = g[0];
  assert.equal(art.mainEntityPage ?? art.mainEntityOfPage['@id'], FULL_URL);
  assert.equal(art.headline, 'Как вести учет расходов без таблиц и не бросить');
  assert.equal(art.description, meta('name', 'description'));
  const visible = html.match(/<time datetime="([^"]+)">([^<]+)<\/time>/);
  assert.equal(art.datePublished, visible[1]);
  assert.equal(meta('property', 'article:published_time'), visible[1]);
  const [y, m, d] = visible[1].split('-');
  assert.equal(visible[2], `${d}.${m}.${y}`);
  assert.equal(art.image[0], meta('property', 'og:image'));
  assert.ok(exists(new URL(art.publisher.logo.url).pathname));
  const bc = g[1].itemListElement;
  assert.deepEqual(bc.map((x) => x.position), [1, 2, 3]);
  assert.equal(bc[2].item, FULL_URL);
  assert.equal(bc[0].item, 'https://finnikbot.ru/');
});

test('FAQPage: 4 вопроса и ответа слово в слово как на странице', () => {
  const items = [...html.matchAll(/<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>\s*<p class="faq__a">([\s\S]*?)<\/p>\s*<\/details>/g)]
    .map((m) => ({ q: clean(m[1]), a: clean(m[2]) }));
  assert.equal(items.length, 4);
  const faq = jsonLd()['@graph'][2];
  assert.equal(faq.mainEntity.length, items.length);
  items.forEach((v, i) => {
    assert.equal(faq.mainEntity[i].name, v.q, `вопрос ${i + 1}`);
    assert.equal(faq.mainEntity[i].acceptedAnswer.text, v.a, `ответ ${i + 1}`);
  });
});

test('на странице не осталось макетных заглушек, автора и «Скоро в блоге»', () => {
  for (const bad of ['Место под', 'ph__box', 'Скоро в блоге', 'Автор:', 'Обновлено:', 'Заглушка']) {
    assert.ok(!html.includes(bad), `лишнее: ${bad}`);
  }
  const css = fs.readFileSync(path.join(pub, 'css/blog.css'), 'utf8');
  assert.ok(!css.includes('ph__box') && !css.includes('.more'), 'в стилях остались плашки или блок «Скоро в блоге»');
  assert.ok(!/fonts\.googleapis|fonts\.gstatic|https?:\/\//.test(css.replaceAll('http://www.w3.org/2000/svg', '')), 'в стилях внешние адреса');
});

test('блок «Пропущенные дни»: описано реальное поведение бота', () => {
  const sec = html.slice(html.indexOf('Пропущенные дни можно добавить позже'), html.indexOf('Категории можно подстроить'));
  assert.ok(sec.length > 300);
  assert.ok(sec.includes('сегодняшней датой'));
  assert.ok(sec.includes('«Исправить»') && sec.includes('«Дату»') && sec.includes('ДД.ММ.ГГГГ'));
  assert.ok(sec.includes('выписк'));
  for (const bad of ['вчера продукты', 'постфактум', 'указанной датой']) assert.ok(!sec.includes(bad), `устаревшее: ${bad}`);
  assert.ok(!html.includes('вчера продукты 1800'));
});

test('картинки: 8 штук, у каждой размеры, описание и существующий файл; нет внешних картинок', () => {
  const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  const content = imgs.filter((t) => /\/images\/blog\//.test(t));
  assert.equal(content.length, 8);
  for (const t of imgs) {
    const src = t.match(/src="([^"]+)"/)[1];
    assert.ok(src.startsWith('/'), `картинка не от корня: ${src}`);
    assert.ok(exists(src), `нет файла: ${src}`);
  }
  for (const t of content) {
    assert.match(t, /width="\d+"/); assert.match(t, /height="\d+"/);
    assert.match(t, /alt="[^"]{8,}"/, 'пустое описание: ' + t.slice(0, 80));
  }
  assert.match(content[0], /fetchpriority="high"/, 'обложка грузится первой');
  assert.ok(content.slice(1).every((t) => /loading="lazy"/.test(t)), 'остальные грузятся лениво');
  assert.ok(html.includes('/images/blog/blog-1-cover.webp'));
});

test('ссылки: всё от корня, нет боевого домена в тексте, внутренние адреса существуют', () => {
  const body = html.slice(html.indexOf('<body>'));
  const hrefs = [...body.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length > 20);
  const known = new Set(['/', '/blog/', '/cabinet/login', '/cabinet/register', '/legal/offer', '/legal/privacy', '/legal/consent', '/legal/cookies']);
  for (const h of hrefs) {
    if (h.startsWith('#') || h.startsWith('mailto:') || h.startsWith('https://t.me/FinnikMoneyBot')) continue;
    const p = h.split('#')[0].split('?')[0];
    if (p === '' ) continue;
    assert.ok(!/^https?:\/\/finnikbot\.ru/.test(h), `абсолютный адрес сайта: ${h}`);
    assert.ok(known.has(p), `неизвестная ссылка: ${h}`);
  }
  const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
  for (const h of hrefs.filter((x) => x.startsWith('#') && x.length > 1)) assert.ok(ids.has(h.slice(1)), `нет якоря ${h}`);
  assert.ok(hrefs.includes('/cabinet/register'));
  assert.ok(hrefs.some((h) => h.startsWith('https://t.me/FinnikMoneyBot')));
});

test('баннер cookie и Метрика подключены так же, как на главной; своего счётчика нет', () => {
  assert.match(html, /<script src="\/js\/consent\.js" defer><\/script>/);
  assert.match(html, /<a href="#" class="footer__doc-link" data-cookie-settings>Настройки cookie<\/a>/);
  assert.ok(!/mc\.yandex|ym\(/.test(html), 'счётчик должен подключаться только через consent.js');
  const js = fs.readFileSync(path.join(pub, 'js/blog.js'), 'utf8');
  assert.ok(!js.includes('data-cookie-settings'), 'заглушка настроек cookie мешает баннеру');
  assert.match(html, /<script src="\/js\/blog\.js" defer><\/script>/);
});

test('карта сайта и иконки', () => {
  assert.ok(sitemapXml().includes(`<loc>${FULL_URL}</loc>`));
  for (const need of ['/favicon.ico', '/images/favicon-finnik.svg', '/images/favicon-48.png', '/images/favicon-120.png']) {
    assert.ok(html.includes(`href="${need}"`), `нет иконки ${need}`);
    assert.ok(exists(need));
  }
});

test('сервер: статья отдаётся, без слэша — 301 на адрес со слэшем, /blog/ — 302 на статью, на stage noindex', async () => {
  const app = express();
  addSeoRoutes(app);
  app.use(express.static(pub));
  const srv = http.createServer(app).listen(0);
  const port = srv.address().port;
  const get = (p, host = 'finnikbot.ru') => new Promise((resolve, reject) => {
    http.get({ port, path: p, headers: { host } }, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, len: Buffer.concat(c).length })); }).on('error', reject);
  });
  try {
    const a = await get(URL_PATH);
    assert.equal(a.status, 200);
    assert.match(a.headers['content-type'], /text\/html/);
    assert.equal(a.headers['x-robots-tag'], undefined);
    const noSlash = await get(URL_PATH.slice(0, -1));
    assert.equal(noSlash.status, 301);
    assert.match(noSlash.headers.location, /\/blog\/kak-vesti-uchet-rashodov\/$/);
    for (const p of ['/blog', '/blog/']) {
      const r = await get(p);
      assert.equal(r.status, 302, p);
      assert.equal(r.headers.location, URL_PATH);
    }
    assert.equal((await get(URL_PATH, 'stage.finnikbot.ru')).headers['x-robots-tag'], 'noindex, nofollow');
    for (const [p, type] of [['/css/blog.css', /text\/css/], ['/js/blog.js', /javascript/], ['/images/blog/blog-1-cover.webp', /image\/webp/], ['/images/blog/og-blog-1.jpg', /image\/jpeg/]]) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers['content-type'], type, p);
      assert.ok(r.len > 200, p);
    }
  } finally { srv.close(); }
});
