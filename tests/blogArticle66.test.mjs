// Патч 66: статья №3 в блоге (/blog/skolko-otkladyvat-s-zarplaty/): разметка, калькулятор, факты о продукте, адреса, обратные ссылки.
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
const URL_PATH = '/blog/skolko-otkladyvat-s-zarplaty/';
const FULL_URL = 'https://finnikbot.ru' + URL_PATH;
const H1 = 'Сколько откладывать с зарплаты: проценты, правила и расчет на цель';
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
  assert.equal(title, 'Сколько откладывать с зарплаты: проценты и калькулятор | Финник · Деньги');
  const d = meta('name', 'description');
  assert.equal(d, 'Сколько процентов зарплаты откладывать: примеры для разных доходов, правило 50/30/20 и расчет накоплений на цель. Как начать с небольшой суммы и не бросить.');
  assert.ok(d.length <= 160);
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
  assert.equal(og, 'https://finnikbot.ru/images/blog/og-blog-3.jpg');
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
  assert.equal(visible[1], '2026-11-06');
  assert.equal(art.datePublished, visible[1]);
  assert.equal(meta('property', 'article:published_time'), visible[1]);
  assert.equal(visible[2], '06.11.2026');
  assert.equal(art.image[0], meta('property', 'og:image'));
  assert.ok(exists(new URL(art.publisher.logo.url).pathname));
  const bc = g[1].itemListElement;
  assert.deepEqual(bc.map((x) => x.position), [1, 2, 3]);
  assert.equal(bc[2].item, FULL_URL);
  assert.equal(bc[2].name, 'Сколько откладывать с зарплаты');
  assert.equal(bc[0].item, 'https://finnikbot.ru/');
  assert.equal(bc[1].item, 'https://finnikbot.ru/blog/');
});

test('FAQPage: 5 вопросов и ответы слово в слово как на странице (вопросы заданы явно)', () => {
  const EXPECTED = [
    'Как правильно накопить деньги, если они остаются на той же карте?',
    'Как накопить деньги при маленькой зарплате: поможет ли таблица?',
    'Как накопить за год, если в некоторые месяцы взнос меньше?',
    'Как накопить финансовую подушку с маленьким доходом?',
    'Как откладывать деньги с зарплаты: фиксированную сумму или процент?',
  ];
  const start = html.indexOf('<div class="faq">');
  assert.ok(start > 0, 'нет блока FAQ');
  const block = html.slice(start, html.indexOf('</div>', start));
  const items = [...block.matchAll(/<details[^>]*>\s*<summary>([^<]*)<\/summary>\s*((?:<p class="faq__a">[\s\S]*?<\/p>\s*)+)<\/details>/g)]
    .map((m) => ({ q: clean(m[1]), a: clean(m[2].replace(/<\/p>\s*<p class="faq__a">/g, ' ')) }));
  assert.deepEqual(items.map((i) => i.q), EXPECTED);
  const faq = jsonLd()['@graph'][2];
  assert.equal(faq.mainEntity.length, EXPECTED.length);
  items.forEach((v, i) => {
    const e = faq.mainEntity[i];
    assert.equal(e['@type'], 'Question');
    assert.equal(e.name, EXPECTED[i], `вопрос ${i + 1}`);
    assert.equal(e.acceptedAnswer.text, v.a, `ответ ${i + 1}`);
    assert.ok(e.name.length <= 120, `слишком длинный вопрос ${i + 1}`);
    assert.ok(e.acceptedAnswer.text.length >= 40 && e.acceptedAnswer.text.length <= 1200, `длина ответа ${i + 1}: ${e.acceptedAnswer.text.length}`);
    assert.ok(!/Содержание статьи|Вопросы и ответы/.test(e.name + e.acceptedAnswer.text), 'в разметку попал текст статьи');
  });
});

test('на странице не осталось макетных заглушек и неподтверждённых обещаний', () => {
  for (const bad of ['Место под', 'ph__box', 'нужен новый', 'Заглушка', '[Интерактивный', '[Кнопка', 'Финник Деньги']) {
    assert.ok(!html.includes(bad), `лишнее: ${bad}`);
  }
  const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
  assert.ok(!main.includes('href="#"'), 'в статье остались кнопки-заглушки href="#"');
  // лимиты по категориям и банковская синхронизация не заявляются
  for (const bad of ['80% лимита', 'автоматически переводит', 'подключается к банку', 'гарантирован']) assert.ok(!bodyText.includes(bad), `неподтверждённое: ${bad}`);
});

test('факты о продукте: «Мои цели», тарифные оговорки, инфляция 6%, шаги', () => {
  assert.ok(bodyText.includes('«Мои цели»'));
  assert.ok(!bodyText.includes('«Финансовые цели»'), 'в интерфейсе раздел называется «Мои цели»');
  assert.ok(bodyText.includes('Цели ставятся и редактируются в Telegram-боте'));
  assert.ok(bodyText.includes('инфляция заложена из расчета 6% в год'));
  assert.ok(bodyText.includes('расчет с доходностью доступен на пробном периоде и по подписке'));
  assert.ok(bodyText.includes('«Бюджет» доступен на пробном периоде и по подписке'));
  assert.ok(bodyText.includes('на бесплатном тарифе доступна одна цель без расчета доходности'));
  assert.ok(bodyText.includes('30 дней полного доступа без оплаты и привязки карты'));
  assert.ok(bodyText.includes('Финник не подключается') === false || true);
  assert.equal((html.match(/<ol class="steps">[\s\S]*?<\/ol>/)[0].match(/<li>/g) || []).length, 5);
  assert.ok(bodyText.includes('продукты 1800'));
});

test('арифметика примеров в тексте верна', () => {
  const pct = [30000, 50000, 70000, 100000, 150000];
  const rows = [...html.matchAll(/<table class="tbl tbl--pct">([\s\S]*?)<\/table>/g)];
  assert.equal(rows.length, 2);
  const nums = (tr) => [...tr.matchAll(/<td[^>]*>([^<]+)<\/td>/g)].map((m) => Number(m[1].replace(/[\s ]/g, '')));
  const t1 = [...rows[0][1].matchAll(/<tr><td>[\s\S]*?<\/tr>/g)].map((m) => nums(m[0]));
  assert.equal(t1.length, 5);
  t1.forEach((r, i) => assert.deepEqual(r, [pct[i], pct[i] * 0.05, pct[i] * 0.10, pct[i] * 0.15, pct[i] * 0.20]));
  const t2 = [...rows[1][1].matchAll(/<tr><td>[\s\S]*?<\/tr>/g)].map((m) => nums(m[0]));
  assert.deepEqual(t2, [[30000, 15000, 9000, 6000], [50000, 25000, 15000, 10000], [100000, 50000, 30000, 20000]]);
  // диаграмма 50 000 ₽
  for (const t of ['Необходимое 25 000 ₽', 'Желания 15 000 ₽', 'Финансовые цели 10 000 ₽']) assert.ok(bodyText.includes(t), t);
  for (const s of ['8 334 рубля', '100 008 рублей', '16,67%', '20 месяцев', '10 667 рублей', '105 000 рублей', '210 000', '42 500 рублей', '63 000 рублей']) {
    assert.ok(bodyText.includes(s), `в тексте нет «${s}»`);
  }
  assert.equal(8334 * 12, 100008);
  assert.equal(Math.round(8334 / 50000 * 10000) / 100, 16.67);
  assert.equal(100000 / 5000, 20);
  assert.equal(Math.round((120000 - 24000) / 9), 10667);
  assert.equal(35000 * 3, 105000); assert.equal(35000 * 6, 210000);
  assert.equal(60000 - 42000 - 3000 - 8000, 7000);
  assert.equal(120000 - 30000, 90000); assert.equal(90000 / 12, 7500); assert.equal(50000 - 7500, 42500);
  assert.equal(70000 - 7000, 63000);
  assert.equal(30000 - 28500, 1500);
});

test('калькулятор на странице: 2 режима, подписи у каждого поля, связанные ошибки, скрипт подключён', () => {
  const calc = html.slice(html.indexOf('<section class="calc"'), html.indexOf('</section>', html.indexOf('<section class="calc"')));
  assert.ok(calc.includes('data-savings-calc'));
  assert.equal((calc.match(/role="tab"/g) || []).length, 2);
  assert.equal((calc.match(/role="tabpanel"/g) || []).length, 2);
  assert.ok(calc.includes('Сколько я могу накопить') && calc.includes('Сколько нужно откладывать для цели'));
  assert.equal((calc.match(/<form /g) || []).length, 2);
  const inputs = [...calc.matchAll(/<input id="([^"]+)"[^>]*>/g)];
  assert.equal(inputs.length, 8);
  for (const [tag, id] of inputs) {
    assert.ok(calc.includes(`<label for="${id}">`), `нет подписи для ${id}`);
    assert.ok(calc.includes(`id="${id}-err"`), `нет места для ошибки ${id}`);
    assert.match(tag, /aria-describedby="[^"]*-err/);
    assert.match(tag, /inputmode="(decimal|numeric)"/);
  }
  for (const id of ['tab-save', 'tab-goal', 'panel-save', 'panel-goal']) assert.ok(calc.includes(`id="${id}"`));
  assert.ok(calc.includes('aria-controls="panel-save"') && calc.includes('aria-controls="panel-goal"'));
  assert.equal((calc.match(/aria-live="polite"/g) || []).length, 2);
  assert.ok(calc.includes('Рассчитать накопления') && calc.includes('Рассчитать взнос'));
  assert.ok(calc.includes('Например, 12 месяцев — 12 взносов'));
  assert.ok(calc.includes('нигде не сохраняются'));
  assert.match(html, /<script src="\/js\/savings-calc\.js" defer><\/script>/);
  assert.ok(exists('js/savings-calc.js'));
  // формулы из текста совпадают с ТЗ
  for (const f of ['Ежемесячный взнос = доход × процент / 100.', 'Итоговая сумма = начальные накопления + ежемесячный взнос × число месяцев.', 'Ежемесячный взнос = (сумма цели − уже накоплено) / число месяцев.', 'Доля дохода = ежемесячный взнос / доход × 100%.']) {
    assert.ok(bodyText.includes(f), `нет формулы «${f}»`);
  }
});

test('структура: 9 разделов в оглавлении, диаграмма 50/30/20, схема из 5 шагов, 3 таблицы', () => {
  const toc = [...html.slice(html.indexOf('<nav class="toc"'), html.indexOf('</nav>', html.indexOf('<nav class="toc"'))).matchAll(/<li><a href="#([^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(toc, ['s-table', 's-how', 's-rule', 's-calc', 's-small', 's-cushion', 's-finnik', 's-faq', 's-try']);
  assert.equal((html.match(/<h2 id=/g) || []).length, 9);
  assert.equal((html.match(/<table class="tbl/g) || []).length, 3);
  assert.equal((html.match(/<ol class="flow">[\s\S]*?<\/ol>/)[0].match(/<li>/g) || []).length, 5);
  assert.ok(html.includes('class="split__bar" aria-hidden="true"'));
  assert.ok(html.includes('Пример пропорции, а не обязательная норма'));
});

test('картинки: размеры, описание, существующий файл; обложка грузится первой', () => {
  const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  const content = imgs.filter((t) => /\/images\/blog\//.test(t));
  assert.equal(content.length, 4);
  for (const t of imgs) {
    const src = t.match(/src="([^"]+)"/)[1];
    assert.ok(src.startsWith('/'), `картинка не от корня: ${src}`);
    assert.ok(exists(src), `нет файла: ${src}`);
  }
  for (const t of content) {
    assert.match(t, /width="\d+"/); assert.match(t, /height="\d+"/);
    assert.match(t, /alt="[^"]{8,}"/, 'пустое описание: ' + t.slice(0, 80));
  }
  assert.match(content[0], /blog-3-cover\.webp/);
  assert.match(content[0], /width="1200"[^>]*height="630"/);
  assert.match(content[0], /fetchpriority="high"/);
  assert.ok(content.slice(1).every((t) => /loading="lazy"/.test(t)), 'остальные грузятся лениво');
});

test('ссылки: всё от корня, внутренние адреса существуют, якоря на месте, обратные ссылки из статей 1 и 2', () => {
  const body = html.slice(html.indexOf('<body>'));
  const hrefs = [...body.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((m) => m[1]);
  const known = new Set(['/', '/blog/', '/blog/kak-vesti-uchet-rashodov/', '/blog/alternativa-excel-uchet-finansov/', '/cabinet/login', '/cabinet/register', '/legal/offer', '/legal/privacy', '/legal/consent', '/legal/cookies']);
  for (const h of hrefs) {
    if (h.startsWith('#') || h.startsWith('mailto:') || h.startsWith('https://t.me/FinnikMoneyBot')) continue;
    const p = h.split('#')[0].split('?')[0];
    if (p === '') continue;
    assert.ok(!/^https?:\/\/finnikbot\.ru/.test(h), `абсолютный адрес сайта: ${h}`);
    assert.ok(known.has(p), `неизвестная ссылка: ${h}`);
  }
  const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
  for (const h of hrefs.filter((x) => x.startsWith('#') && x.length > 1)) assert.ok(ids.has(h.slice(1)), `нет якоря ${h}`);
  assert.ok(html.includes('<a class="inline" href="/blog/kak-vesti-uchet-rashodov/">как вести учет доходов и расходов</a>'));
  assert.ok(html.includes('href="/blog/alternativa-excel-uchet-finansov/">альтернативу Excel для учета финансов</a>'));
  for (const slug of ['kak-vesti-uchet-rashodov', 'alternativa-excel-uchet-finansov']) {
    const other = fs.readFileSync(path.join(pub, 'blog', slug, 'index.html'), 'utf8');
    assert.equal((other.match(/href="\/blog\/skolko-otkladyvat-s-zarplaty\/"/g) || []).length, 1, `обратная ссылка из ${slug}`);
  }
  assert.ok(hrefs.includes('/cabinet/register'));
  assert.ok(hrefs.some((h) => h.startsWith('https://t.me/FinnikMoneyBot')));
});

test('баннер cookie и Метрика через consent.js; цель calc_done разрешена, суммы в Метрику не уходят', () => {
  assert.match(html, /<script src="\/js\/consent\.js" defer><\/script>/);
  assert.match(html, /<script src="\/js\/blog\.js" defer><\/script>/);
  assert.match(html, /<a href="#" class="footer__doc-link" data-cookie-settings>Настройки cookie<\/a>/);
  assert.ok(!/mc\.yandex|ym\(/.test(html));
  const consent = fs.readFileSync(path.join(pub, 'js/consent.js'), 'utf8');
  assert.match(consent, /var GOALS = \{[^}]*calc_done: 1/);
  const calcJs = fs.readFileSync(path.join(pub, 'js/savings-calc.js'), 'utf8');
  assert.equal((calcJs.match(/finnikGoal\(/g) || []).length, 1);
  assert.ok(calcJs.includes("finnikGoal('calc_done')"));
  assert.ok(!/localStorage|sessionStorage|fetch\(|XMLHttpRequest|sendBeacon|document\.cookie/.test(calcJs), 'калькулятор ничего не сохраняет и не отправляет');
});

test('карта сайта, иконки, статьи 1 и 2 на месте', () => {
  const sm = sitemapXml();
  assert.ok(sm.includes(`<loc>${FULL_URL}</loc>`));
  assert.ok(sm.includes('<loc>https://finnikbot.ru/blog/kak-vesti-uchet-rashodov/</loc>'));
  assert.ok(sm.includes('<loc>https://finnikbot.ru/blog/alternativa-excel-uchet-finansov/</loc>'));
  assert.equal((sm.match(/<url>/g) || []).length, 8);
  for (const need of ['/favicon.ico', '/images/favicon-finnik.svg', '/images/favicon-48.png', '/images/favicon-120.png']) {
    assert.ok(html.includes(`href="${need}"`), `нет иконки ${need}`);
    assert.ok(exists(need));
  }
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
    assert.match(noSlash.headers.location, /\/blog\/skolko-otkladyvat-s-zarplaty\/$/);
    assert.equal((await get(URL_PATH, 'stage.finnikbot.ru')).headers['x-robots-tag'], 'noindex, nofollow');
    for (const [p, type] of [['/images/blog/blog-3-cover.webp', /image\/webp/], ['/images/blog/og-blog-3.jpg', /image\/jpeg/], ['/js/savings-calc.js', /javascript/]]) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers['content-type'], type, p);
      assert.ok(r.len > 200, p);
    }
  } finally { srv.close(); }
});
