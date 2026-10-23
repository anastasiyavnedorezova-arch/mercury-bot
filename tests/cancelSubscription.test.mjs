// «Отменить подписку»: кнопка на экране активной подписки, текст про письмо и возврат (23.10.2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SUPPORT_EMAIL } from '../src/emails/config.js';
import { parseRichText } from '../public/cabinet/rich-text.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('исходник: кнопка только на экране активной подписки, текст и маршрут', () => {
  const s = read('src/handlers/subscription.js');
  assert.ok(s.includes("import { SUPPORT_EMAIL } from '../emails/config.js'"));
  assert.ok(s.includes('письмо с темой «Отменить подписку»'));
  assert.ok(s.includes('e-mail или ник в Telegram, к которому привязан аккаунт'));
  assert.ok(s.includes('Деньги вернём за неиспользованные дни подписки'));
  assert.ok(s.includes('https://finnikbot.ru/legal/offer'));
  // кнопка одна, в блоке «Подписка активна»; у бесплатного и пробного тарифа её нет
  assert.equal((s.match(/callback_data: 'cancel_subscription'/g) || []).length, 1);
  assert.ok(s.indexOf("callback_data: 'cancel_subscription'") > s.indexOf('// access === \'active\''));
  assert.ok(read('src/handlers/callbackDispatcher.js').includes("action === 'cancel_subscription'"));
});

test('почта и ссылка в этом тексте кликабельны в виджете (и копируются в Telegram как обычный текст)', () => {
  const text = `Чтобы отменить подписку, напиши на ${SUPPORT_EMAIL} письмо с темой «Отменить подписку».\n\nУсловия возврата: https://finnikbot.ru/legal/offer`;
  const hrefs = parseRichText(text).filter((x) => x.type === 'link').map((x) => x.href);
  assert.deepEqual(hrefs, [`mailto:${SUPPORT_EMAIL}`, 'https://finnikbot.ru/legal/offer']);
});

test('условия в оферте совпадают с текстом бота: возврат за неиспользованный период на ту же почту', () => {
  const offer = read('public/legal/offer.html');
  assert.ok(offer.includes(`mailto:${SUPPORT_EMAIL}`) && offer.includes('неиспользованный период'));
});
