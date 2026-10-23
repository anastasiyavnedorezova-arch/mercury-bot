// Виджет бота: ссылки на оплату и почты кликабельны, теги <b> не видны (23.10.2026: ссылка на оплату не нажималась).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseRichText, appendRichText } from '../public/cabinet/rich-text.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const links = (s) => parseRichText(s).filter((t) => t.type === 'link');

test('ссылка на оплату в Markdown-виде превращается в ссылку с понятным текстом', () => {
  const msg = 'Отлично! Для оплаты перейди по ссылке 👇\n\n[Оплатить 1 месяц — 399 ₽](https://yoomoney.ru/checkout/payments/v2/contract?orderId=326d5951-000f-5001-a000-1402814ff46e)\n\nЧек придёт на email из твоего профиля.';
  const l = links(msg);
  assert.equal(l.length, 1);
  assert.equal(l[0].text, 'Оплатить 1 месяц — 399 ₽');
  assert.equal(l[0].href, 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=326d5951-000f-5001-a000-1402814ff46e');
  assert.ok(!parseRichText(msg).some((t) => t.type === 'text' && /[\[\]]\(?https?/.test(t.text)), 'в тексте не осталось «[…](…)»');
});

test('голые ссылки и почты кликабельны, точка в конце предложения к ссылке не относится', () => {
  const l = links('Сайт https://finnikbot.ru/cabinet. Пиши на hello@finnikbot.ru, ответим.');
  assert.deepEqual(l.map((x) => x.href), ['https://finnikbot.ru/cabinet', 'mailto:hello@finnikbot.ru']);
  const text = parseRichText('Сайт https://finnikbot.ru/cabinet. Дальше').filter((t) => t.type === 'text').map((t) => t.text).join('');
  assert.equal(text, 'Сайт . Дальше');
});

test('HTML-оформление бота: <b>, <i>, <a href> разбираются, остальные теги остаются обычным текстом', () => {
  const t = parseRichText('Записываю <b>500 ₽</b> 💸 <i>тихо</i> <a href="https://finnikbot.ru/x">тут</a> &lt;3 <u>x</u>');
  assert.deepEqual(t.filter((x) => x.type !== 'text').map((x) => [x.type, x.text]), [['b', '500 ₽'], ['i', 'тихо'], ['link', 'тут']]);
  const plain = t.filter((x) => x.type === 'text').map((x) => x.text).join('');
  assert.ok(plain.includes('<3') && plain.includes('<u>x</u>'));
});

test('экранирование Markdown убирается («AB\\_C» → «AB_C»)', () => {
  assert.equal(parseRichText('Промокод AB\\_C применён').map((x) => x.text).join(''), 'Промокод AB_C применён');
});

test('опасное не становится ссылкой: javascript:, data:, вставки скриптов', () => {
  assert.equal(links('[нажми](javascript:alert(1))').length, 0);
  assert.equal(links('[нажми](data:text/html;base64,AAAA)').length, 0);
  assert.equal(links('<a href="javascript:alert(1)">x</a>').length, 0);
  const t = parseRichText('<script>alert(1)</script>');
  assert.deepEqual(t.map((x) => x.type), ['text']);
});

// Минимальный «документ»: проверяем, что DOM собирается безопасно, без innerHTML
function fakeDoc() {
  const mk = (tag) => ({ tag, attrs: {}, children: [], textContent: '', setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); } });
  return { createElement: mk, createTextNode: (text) => ({ tag: '#text', text }) };
}

test('appendRichText: <a> с target=_blank и rel для сайтов, mailto без target; текст вставляется как текст', () => {
  const doc = fakeDoc();
  const el = doc.createElement('div');
  appendRichText(el, '[Оплатить](https://yoomoney.ru/p?x=1) или hello@finnikbot.ru <b>да</b>', doc);
  const [a, , mail, , b] = el.children;
  assert.equal(a.tag, 'a'); assert.equal(a.attrs.href, 'https://yoomoney.ru/p?x=1');
  assert.equal(a.attrs.target, '_blank'); assert.equal(a.attrs.rel, 'noopener noreferrer'); assert.equal(a.textContent, 'Оплатить');
  assert.equal(mail.attrs.href, 'mailto:hello@finnikbot.ru'); assert.equal(mail.attrs.target, undefined);
  assert.equal(b.tag, 'strong'); assert.equal(b.textContent, 'да');
});

test('подключение: пузыри бота (виджет и веб-чат) через appendRichText, пузыри пользователя — обычным текстом', () => {
  for (const f of ['public/cabinet/bot-widget.js', 'public/cabinet/bot.html']) {
    const s = read(f);
    assert.ok(s.includes("import { appendRichText } from './rich-text.js';"), f);
    assert.equal((s.match(/appendRichText\(bubble, text\)/g) || []).length, 1, f);
    assert.equal((s.match(/bubble\.textContent = text/g) || []).length, 1, `${f}: у пользователя текст остаётся текстом`);
  }
  assert.ok(!/innerHTML/.test(read('public/cabinet/rich-text.js').replace(/\/\/.*$/gm, '')), 'без innerHTML');
});
