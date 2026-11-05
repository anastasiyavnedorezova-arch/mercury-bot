// Патч 65: статья №2 в блоге (/blog/alternativa-excel-uchet-finansov/): разметка, картинки, факты о продукте, адреса.
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
const URL_PATH = '/blog/alternativa-excel-uchet-finansov/';
const FULL_URL = 'https://finnikbot.ru' + URL_PATH;
const H1 = 'Альтернатива Excel: учет финансов без таблиц и сложных приложений';
const html = fs.readFileSync(path.join(pub, URL_PATH, 'index.html'), 'utf8');

const clean = (t) => t
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').trim();
const meta = (attr, name) => (html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`)) || [])[1];
const jsonLd = () => JSON.parse(html.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/)[1]);
const exists = (p) => fs.existsSync(path.join(pub, p));
const bodyText = clean(html.slice(html.indexOf('<main'), html.indexOf('</main>')));

test('шапка страницы: title, описание, canonical, robots, соцсети, префикс article', () => {
  assert.match(html, /^<!DOCTYPE html>\s*<html lang="ru">/i);
  assert.match(html, /<head prefix="og: https:\/\/ogp\.me\/ns# article: https:\/\/ogp\.me\/ns\/article#">/);
  const title = html.match(/<title>(.*?)<\/title>/)[1];
  assert.ok(title.startsWith('Альтернатива Excel'), title);
  assert.ok(title.length <= 70, 'title слишком длинный: ' + title.length);
  const d = meta('name', 'description');
  assert.ok(d.length >= 70 && d.length <= 160, 'длина description: ' + d.length);
  assert.match(html, new RegExp(`<link rel="canonical" href="${FULL_URL}">`));
  assert.match(meta('name', 'robots'), /^index, follow/);
  assert.equal(meta('property', 'og:type'), 'article');
  assert.equal(meta('property', 'og:url'), FULL_URL);
  assert.equal(meta('property', 'og:title'), H1);
  assert.equal(meta('property', 'og:description'), d);
  assert.equal(meta('name', 'twitter:card'), 'summary_large_image');
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1, 'ровно один заголовок H1');
  assert.equal(clean(html.match(/<h1>([\s\S]*?)<\/h1>/)[1]), H1);
});

test('картинка для соцсетей: настоящий JPEG 1200×630 по боевому адресу', () => {
  const og = meta('property', 'og:image');
  assert.equal(og, 'https://finnikbot.ru/images/blog/og-blog-2.jpg');
  const buf = fs.readFileSync(path.join(pub, new URL(og).pathname));
  assert.equal(buf[0], 0xff); assert.equal(buf[1], 0xd8);
  let i = 2, w = 0, h = 0;
  while (i < buf.length) {
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
  assert.equal(art.mainEntityOfPage['@id'], FULL_URL);
  assert.equal(art.headline, H1);
  assert.equal(art.description, meta('name', 'description'));
  const visible = html.match(/<time datetime="([^"]+)">([^<]+)<\/time>/);
  assert.equal(visible[1], '2026-10-30');
  assert.equal(art.datePublished, visible[1]);
  assert.equal(meta('property', 'article:published_time'), visible[1]);
  assert.equal(visible[2], '30.10.2026');
  assert.equal(art.image[0], meta('property', 'og:image'));
  assert.ok(exists(new URL(art.publisher.logo.url).pathname));
  const bc = g[1].itemListElement;
  assert.deepEqual(bc.map((x) => x.position), [1, 2, 3]);
  assert.equal(bc[2].item, FULL_URL);
  assert.equal(bc[2].name, 'Альтернатива Excel');
  assert.equal(bc[0].item, 'https://finnikbot.ru/');
  assert.equal(bc[1].item, 'https://finnikbot.ru/blog/');
});

test('FAQPage: 2 вопроса и ответа слово в слово как на странице (вопросы заданы явно)', () => {
  const EXPECTED = [
    'Я вела таблицу. Как перенести данные из нее в Финника',
    'Мне удобнее смотреть результаты таблицей. Можно выгрузить записи',
  ];
  const start = html.indexOf('<div class="faq">');
  assert.ok(start > 0, 'нет блока FAQ');
  const block = html.slice(start, html.indexOf('</div>', start));
  const items = [...block.matchAll(/<details[^>]*>\s*<summary>([^<]*)<\/summary>\s*<p class="faq__a">([\s\S]*?)<\/p>\s*<\/details>/g)]
    .map((m) => ({ q: clean(m[1]), a: clean(m[2]) }));
  assert.deepEqual(items.map((i) => i.q), EXPECTED);
  const faq = jsonLd()['@graph'][2];
  assert.equal(faq.mainEntity.length, EXPECTED.length);
  items.forEach((v, i) => {
    const e = faq.mainEntity[i];
    assert.equal(e['@type'], 'Question');
    assert.equal(e.name, EXPECTED[i], `вопрос ${i + 1}`);
    assert.equal(e.acceptedAnswer.text, v.a, `ответ ${i + 1}`);
    assert.ok(e.name.length <= 120, `слишком длинный вопрос ${i + 1}: ${e.name.length}`);
    assert.ok(e.acceptedAnswer.text.length >= 40 && e.acceptedAnswer.text.length <= 600, `длина ответа ${i + 1}`);
    assert.ok(!/Содержание статьи|Вопросы и ответы/.test(e.name + e.acceptedAnswer.text), 'в разметку попал текст статьи');
  });
  assert.ok(JSON.stringify(jsonLd()).length < 5000, 'JSON-LD подозрительно большой');
});

test('на странице не осталось макетных заглушек', () => {
  for (const bad of ['Место под', 'ph__box', 'ph__tag', 'ph--reuse', 'нужен новый', 'из статьи 1', 'Скоро в блоге', 'Заглушка']) {
    assert.ok(!html.includes(bad), `лишнее: ${bad}`);
  }
  const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
  assert.ok(!main.includes('href="#"'), 'в статье остались кнопки-заглушки href="#"');
  const css = fs.readFileSync(path.join(pub, 'css/blog.css'), 'utf8');
  assert.ok(!css.includes('ph__') && !css.includes('ph--reuse'), 'в стилях остались плашки макета');
  assert.ok(!/fonts\.googleapis|fonts\.gstatic|https?:\/\//.test(css.replaceAll('http://www.w3.org/2000/svg', '')), 'в стилях внешние адреса');
});

test('факты о продукте: пропущенные дни, выгрузка, голос, выписки', () => {
  const sec = html.slice(html.indexOf('Если пропустил несколько дней'), html.indexOf('Категории можно настроить'));
  assert.ok(sec.length > 300);
  assert.ok(sec.includes('сегодняшней датой'));
  assert.ok(sec.includes('«Исправить»') && sec.includes('«Дату»') && sec.includes('ДД.ММ.ГГГГ'));
  assert.ok(sec.includes('выписк'));
  for (const bad of ['вчера продукты', 'постфактум', 'указанной датой', 'указать дату']) assert.ok(!sec.includes(bad), `устаревшее: ${bad}`);
  assert.ok(!html.includes('вчера продукты 1800'));
  assert.ok(html.includes('«Выгрузить таблицу в .csv»') && html.includes('фильтре «Даты»') && html.includes('«Загрузить ещё»'));
  assert.ok(html.includes('Голосовые сообщения пока доступны только в Telegram'));
  assert.ok(html.includes('Финник не подключается к банковскому аккаунту'));
  assert.ok(html.includes('Автоматического продления нет'));
  assert.ok(html.includes('30 дней полного доступа без оплаты и привязки карты'));
});

test('структура: таблица-пример, сравнение в 4 колонки, 4 цитаты, 5 шагов, 2 кнопки регистрации и ссылка на статью 1', () => {
  assert.equal((html.match(/<table class="tbl">/g) || []).length, 1);
  const cmp = html.slice(html.indexOf('<div class="cmp">'), html.indexOf('</table>', html.indexOf('<div class="cmp">')));
  assert.equal((cmp.match(/<th scope="col"/g) || []).length, 4);
  assert.equal((cmp.match(/<tbody>[\s\S]*<\/tbody>/)[0].match(/<tr>/g) || []).length, 5);
  assert.equal((html.match(/<figure class="quote">/g) || []).length, 4);
  assert.equal((html.match(/<ol class="steps">[\s\S]*?<\/ol>/)[0].match(/<li>/g) || []).length, 5);
  assert.ok(html.includes('href="/blog/kak-vesti-uchet-rashodov/"'));
  assert.ok(bodyText.includes('Попробовать учет сообщениями'));
  assert.ok(bodyText.includes('Попробовать Финника бесплатно'));
});

test('картинки: 8 штук, у каждой размеры, описание и существующий файл', () => {
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
  assert.match(content[0], /blog-2-cover\.webp/);
  assert.match(content[0], /width="1200"[^>]*height="630"/);
  assert.match(content[0], /fetchpriority="high"/, 'обложка грузится первой');
  assert.ok(content.slice(1).every((t) => /loading="lazy"/.test(t)), 'остальные грузятся лениво');
  assert.ok(html.includes('/images/blog/blog-2-table-vs-message.webp'));
});

test('ссылки: всё от корня, внутренние адреса существуют, якоря на месте', () => {
  const body = html.slice(html.indexOf('<body>'));
  const hrefs = [...body.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length > 20);
  const known = new Set(['/', '/blog/', '/blog/kak-vesti-uchet-rashodov/', '/blog/skolko-otkladyvat-s-zarplaty/', '/cabinet/login', '/cabinet/register', '/legal/offer', '/legal/privacy', '/legal/consent', '/legal/cookies']);
  for (const h of hrefs) {
    if (h.startsWith('#') || h.startsWith('mailto:') || h.startsWith('https://t.me/FinnikMoneyBot')) continue;
    const p = h.split('#')[0].split('?')[0];
    if (p === '') continue;
    assert.ok(!/^https?:\/\/finnikbot\.ru/.test(h), `абсолютный адрес сайта: ${h}`);
    assert.ok(known.has(p), `неизвестная ссылка: ${h}`);
  }
  const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
  for (const h of hrefs.filter((x) => x.startsWith('#') && x.length > 1)) assert.ok(ids.has(h.slice(1)), `нет якоря ${h}`);
  assert.ok(hrefs.includes('/cabinet/register'));
  assert.ok(hrefs.some((h) => h.startsWith('https://t.me/FinnikMoneyBot')));
});

test('баннер cookie и Метрика подключены через consent.js; своего счётчика нет', () => {
  assert.match(html, /<script src="\/js\/consent\.js" defer><\/script>/);
  assert.match(html, /<script src="\/js\/blog\.js" defer><\/script>/);
  assert.match(html, /<a href="#" class="footer__doc-link" data-cookie-settings>Настройки cookie<\/a>/);
  assert.ok(!/mc\.yandex|ym\(/.test(html));
});

test('карта сайта, иконки, статья 1 не пострадала', () => {
  const sm = sitemapXml();
  assert.ok(sm.includes(`<loc>${FULL_URL}</loc>`));
  assert.ok(sm.includes('<loc>https://finnikbot.ru/blog/kak-vesti-uchet-rashodov/</loc>'));
  for (const need of ['/favicon.ico', '/images/favicon-finnik.svg', '/images/favicon-48.png', '/images/favicon-120.png']) {
    assert.ok(html.includes(`href="${need}"`), `нет иконки ${need}`);
    assert.ok(exists(need));
  }
  assert.ok(exists('/blog/kak-vesti-uchet-rashodov/index.html'));
});

test('сервер: статья отдаётся, без слэша — 301, на stage noindex, файлы доступны', async () => {
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
    assert.match(noSlash.headers.location, /\/blog\/alternativa-excel-uchet-finansov\/$/);
    assert.equal((await get(URL_PATH, 'stage.finnikbot.ru')).headers['x-robots-tag'], 'noindex, nofollow');
    for (const [p, type] of [['/images/blog/blog-2-cover.webp', /image\/webp/], ['/images/blog/blog-2-table-vs-message.webp', /image\/webp/], ['/images/blog/og-blog-2.jpg', /image\/jpeg/]]) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers['content-type'], type, p);
      assert.ok(r.len > 200, p);
    }
  } finally { srv.close(); }
});
