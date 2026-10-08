import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, root), 'utf8');
const DOCS = ['offer', 'privacy', 'consent', 'cookies'];

test('юридические страницы существуют и содержат реквизиты продавца', () => {
  for (const d of DOCS) {
    const html = read(`public/legal/${d}.html`);
    assert.match(html, /504230305760/, d);
    assert.match(html, /326508100607489/, d);
    assert.match(html, /hello@finnikbot\.ru/, d);
    assert.match(html, /Захарова Анастасия Вячеславовна/, d);
    assert.ok(!/\[ГОРОД/.test(html), `${d}: не подставлен город и область`);
    assert.ok(!/telegra\.ph|Merkuri|Меркури/i.test(html), d);
  }
});

test('оферта: тарифы, пробный период 30 дней, ручное продление, возврат', () => {
  const t = read('public/legal/offer.html');
  assert.match(t, /399 ₽/);
  assert.match(t, /1 995 ₽/);
  assert.match(t, /3 990 ₽/);
  assert.match(t, /30 \(тридцать\) календарных дней/);
  assert.match(t, /не продлевается автоматически/);
  assert.match(t, /пропорционально неиспользованному/);
});

test('политика и согласие: OpenAI (США), Telegram, Россия, 30 дней', () => {
  for (const d of ['privacy', 'consent']) {
    const t = read(`public/legal/${d}.html`);
    assert.match(t, /OpenAI/, d);
    assert.match(t, /США/, d);
    assert.match(t, /Telegram/, d);
  }
  assert.match(read('public/legal/privacy.html'), /территории Российской Федерации/);
  assert.match(read('public/legal/privacy.html'), /30 дней/);
});

test('внутренние ссылки /legal/* ведут на существующие страницы и маршруты', () => {
  const route = read('src/webhook.js');
  assert.match(route, /\['offer', 'privacy', 'consent', 'cookies'\]/);
  const files = ['public/index.html', 'public/cabinet/register.html', 'public/cabinet/profile.html', ...DOCS.map((d) => `public/legal/${d}.html`)];
  for (const f of files) {
    for (const m of read(f).matchAll(/href="\/legal\/([a-z]+)"/g)) {
      assert.ok(DOCS.includes(m[1]), `${f}: нет страницы /legal/${m[1]}`);
    }
  }
});

test('старых ссылок telegra.ph нет ни на сайте, ни в боте', () => {
  for (const f of ['public/index.html', 'public/cabinet/register.html', 'public/cabinet/profile.html', 'src/handlers/onboarding.js']) {
    assert.ok(!/telegra\.ph/.test(read(f)), f);
  }
});

test('регистрация: две отдельные обязательные галочки, согласие уходит на сервер', () => {
  const t = read('public/cabinet/register.html');
  assert.match(t, /id="checkTermsBox"/);
  assert.match(t, /id="checkConsentBox"/);
  assert.match(t, /consent_pd_accepted:\s+true/);
  assert.match(t, /!termsChecked \|\| !consentChecked/);
});

test('бот: текст согласия честно говорит про OpenAI и новые документы', () => {
  const t = read('src/handlers/onboarding.js');
  assert.ok(!/не\s+передаются третьим лицам/.test(t));
  assert.match(t, /OpenAI \(США\)/);
  assert.match(t, /finnikbot\.ru\/legal\/offer/);
  assert.match(t, /finnikbot\.ru\/legal\/consent/);
});

test('кабинет бота не тянет шрифты с Google', () => {
  assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(read('public/cabinet/bot.html')));
});

test('старая почта поддержки убрана со страниц, везде hello@finnikbot.ru', () => {
  for (const f of ['public/index.html', 'public/cabinet/faq.html', 'public/cabinet/how-to.html', 'public/cabinet/profile.html', 'public/cabinet/register.html']) {
    const t = read(f);
    assert.ok(!/finnikbot\.help@yandex|mercury\.finbot@yandex|help@mercuryfinbot/i.test(t), f);
  }
  assert.match(read('public/index.html'), /mailto:hello@finnikbot\.ru/);
  assert.match(read('public/cabinet/profile.html'), /mailto:hello@finnikbot\.ru/);
});
