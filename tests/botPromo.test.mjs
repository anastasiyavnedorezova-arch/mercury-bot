import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { makeDb } from './helpers/testDb.mjs';
import { createPromo } from '../src/payments/promoAdmin.js';
import { recordRedemption, tooManyChecks } from '../src/payments/promo.js';
import { userStates } from '../src/state.js';
import { askPromo, continueWithoutPromo, handlePromoMessage, showPaymentLink, PLANS } from '../src/handlers/subscriptionPromo.js';

let ctx;
before(async () => { ctx = await makeDb(); });
after(async () => { await ctx?.close(); });
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

let n = 0;
async function newUser() {
  n += 1;
  const id = crypto.randomUUID();
  const { error } = await ctx.db.from('users').insert({ id, external_id: `bp${n}`, channel: 'telegram', email: `bp${n}@example.com` });
  assert.ifError(error);
  return { id, tg: 7000 + n, email: `bp${n}@example.com` };
}
let codeN = 0;
async function newPromo(over = {}) {
  const r = await createPromo(ctx.db, { code: over.code ?? `BOT${Date.now().toString(36).toUpperCase()}${++codeN}`, off: 300, ...over });
  assert.equal(r.ok, true, r.error);
  return r.promo.code;
}
// Подставной бот и подставная ЮKassa
function fakeBot() {
  const sent = [];
  return { sent, sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); return {}; } };
}
function fakeCreate(reason) {
  const calls = [];
  const fn = async (args) => { calls.push(args); return reason ? { ok: false, reason } : { ok: true, id: 'pay-1', url: 'https://pay.example/abc' }; };
  fn.calls = calls;
  return fn;
}
const msgOf = (u, text) => ({ from: { id: u.tg }, chat: { id: u.tg }, text });
const buttons = (m) => m.opts.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);

test('бот: после выбора тарифа спрашивает промокод; есть кнопки «Продолжить без промокода» и «Отмена»', async () => {
  const u = await newUser();
  const bot = fakeBot();
  await askPromo(bot, u.tg, u.tg, { planKey: 'buy_1month', userId: u.id, email: u.email });
  assert.match(bot.sent[0].text, /Есть промокод/);
  assert.deepEqual(buttons(bot.sent[0]), ['buy_nopromo', 'cancel_payment']);
  assert.equal(userStates.get(u.tg).awaitingPromo, true);
  assert.equal(userStates.get(u.tg).selectedPeriod, 'buy_1month');
});

test('бот: верный промокод — платёж создаётся со скидкой, в сообщении новая цена, ожидание закрывается', async () => {
  const code = await newPromo({ off: 300 });
  for (const [plan, price] of [['buy_1month', '99 ₽'], ['buy_6months', '1 695 ₽'], ['buy_12months', '3 690 ₽']]) {
    const u = await newUser();
    const bot = fakeBot(); const create = fakeCreate();
    await askPromo(bot, u.tg, u.tg, { planKey: plan, userId: u.id, email: u.email });
    const handled = await handlePromoMessage(bot, msgOf(u, `  ${code.toLowerCase()} `), { db: ctx.db, create });
    assert.equal(handled, true);
    assert.equal(create.calls.length, 1);
    assert.equal(create.calls[0].months, PLANS[plan].months);
    assert.deepEqual(create.calls[0].promo, { code, amountOff: 300 });
    assert.equal(create.calls[0].email, u.email);
    const last = bot.sent.at(-1);
    assert.match(last.text, new RegExp(`Оплатить .*— ${price}`), plan);
    assert.ok(last.text.includes('https://pay.example/abc'));
    assert.match(last.text, /Промокод .* применён: −300 ₽/);
    assert.equal(userStates.get(u.tg), undefined, 'состояние ожидания снято');
  }
});

test('бот: неверный, просроченный, исчерпанный и уже использованный коды — понятный ответ, платёж не создаётся, можно повторить', async () => {
  const u = await newUser();
  const bot = fakeBot(); const create = fakeCreate();
  await askPromo(bot, u.tg, u.tg, { planKey: 'buy_1month', userId: u.id, email: u.email });

  await handlePromoMessage(bot, msgOf(u, 'НЕТТАКОГО'), { db: ctx.db, create });
  assert.match(bot.sent.at(-1).text, /Такого промокода нет/);
  assert.deepEqual(buttons(bot.sent.at(-1)), ['buy_nopromo', 'cancel_payment']);

  const off = await newPromo();
  await ctx.query('UPDATE public.promo_codes SET active = false WHERE code = $1', [off]);
  await handlePromoMessage(bot, msgOf(u, off), { db: ctx.db, create });
  assert.match(bot.sent.at(-1).text, /Такого промокода нет/, 'выключенный код — как несуществующий');

  const old = await newPromo();
  await ctx.query("UPDATE public.promo_codes SET expires_at = now() - interval '1 day' WHERE code = $1", [old]);
  await handlePromoMessage(bot, msgOf(u, old), { db: ctx.db, create });
  assert.match(bot.sent.at(-1).text, /Срок действия промокода закончился/);

  const full = await newPromo({ max: 1 });
  const other = await newUser();
  await recordRedemption(ctx.db, { code: full, userId: other.id, paymentId: `pay-${crypto.randomUUID()}`, amountOff: 300 });
  await handlePromoMessage(bot, msgOf(u, full), { db: ctx.db, create });
  assert.match(bot.sent.at(-1).text, /использовали максимальное число раз/);

  const mine = await newPromo({ max: 5, perUser: 1 });
  await recordRedemption(ctx.db, { code: mine, userId: u.id, paymentId: `pay-${crypto.randomUUID()}`, amountOff: 300 });
  await handlePromoMessage(bot, msgOf(u, mine), { db: ctx.db, create });
  assert.match(bot.sent.at(-1).text, /Ты уже использовал этот промокод/);

  assert.equal(create.calls.length, 0, 'ни разу не создали платёж');
  assert.equal(userStates.get(u.tg).awaitingPromo, true, 'ожидание сохранилось: можно прислать другой код');

  const good = await newPromo();
  await handlePromoMessage(bot, msgOf(u, good), { db: ctx.db, create });
  assert.equal(create.calls.length, 1, 'после верного кода платёж создан');
});

test('бот: скидка больше цены тарифа не принимается (минимальный платёж — 1 ₽)', async () => {
  // 399 ₽ минус 398 = 1 ₽ допустимо, а код на 399 ₽ создать нельзя: проверяем защиту на уровне ответа бота
  const code = await newPromo({ off: 398 });
  const u = await newUser();
  const bot = fakeBot(); const create = fakeCreate();
  await askPromo(bot, u.tg, u.tg, { planKey: 'buy_1month', userId: u.id, email: u.email });
  await handlePromoMessage(bot, msgOf(u, code), { db: ctx.db, create });
  assert.match(bot.sent.at(-1).text, /Оплатить 1 месяц — 1 ₽/);
  assert.equal(create.calls[0].promo.amountOff, 398);
});

test('бот: «Продолжить без промокода» создаёт платёж без скидки; без ожидания — просит выбрать тариф заново', async () => {
  const u = await newUser();
  const bot = fakeBot(); const create = fakeCreate();
  await askPromo(bot, u.tg, u.tg, { planKey: 'buy_6months', userId: u.id, email: u.email });
  await continueWithoutPromo(bot, u.tg, u.tg, { create });
  assert.equal(create.calls.length, 1);
  assert.equal(create.calls[0].months, 6);
  assert.equal('promo' in create.calls[0], false);
  assert.match(bot.sent.at(-1).text, /Оплатить 6 месяцев — 1 995 ₽/);
  assert.equal(userStates.get(u.tg), undefined);

  const bot2 = fakeBot(); const create2 = fakeCreate();
  await continueWithoutPromo(bot2, u.tg, u.tg, { create: create2 });
  assert.equal(create2.calls.length, 0, 'второе нажатие платёж не создаёт');
  assert.match(bot2.sent[0].text, /Выбери тариф заново/);
  assert.deepEqual(buttons(bot2.sent[0]), ['buy_subscription', 'menu:main']);
});

test('бот: обычные сообщения и команды не принимаются за промокод, когда ожидания нет', async () => {
  const u = await newUser();
  const bot = fakeBot(); const create = fakeCreate();
  assert.equal(await handlePromoMessage(bot, msgOf(u, 'кофе 200'), { db: ctx.db, create }), false, 'нет ожидания — не наше сообщение');
  await askPromo(bot, u.tg, u.tg, { planKey: 'buy_1month', userId: u.id, email: u.email });
  assert.equal(await handlePromoMessage(bot, msgOf(u, '/start'), { db: ctx.db, create }), false, 'команда не считается промокодом');
  assert.equal(await handlePromoMessage(bot, { from: { id: u.tg }, chat: { id: u.tg } }, { db: ctx.db, create }), false, 'фото и голос — не промокод');
  assert.equal(userStates.get(u.tg).awaitingPromo, true);
  userStates.delete(u.tg);
});

test('бот: не больше 10 проверок кода в минуту (защита от перебора), счётчик общий с кабинетом', async () => {
  const u = await newUser();
  const bot = fakeBot(); const create = fakeCreate();
  await askPromo(bot, u.tg, u.tg, { planKey: 'buy_1month', userId: u.id, email: u.email });
  for (let i = 0; i < 10; i += 1) await handlePromoMessage(bot, msgOf(u, `XXX${i}XXX`), { db: ctx.db, create });
  assert.match(bot.sent.at(-1).text, /Такого промокода нет/);
  await handlePromoMessage(bot, msgOf(u, 'XXX99XXX'), { db: ctx.db, create });
  assert.match(bot.sent.at(-1).text, /Слишком много попыток/);
  assert.equal(tooManyChecks(u.id), true, 'тот же счётчик, что у /api/promo/check');
  userStates.delete(u.tg);
});

test('бот: сбой проверки (база недоступна) — человеку понятное сообщение, ожидание не теряется', async () => {
  const u = await newUser();
  const bot = fakeBot(); const create = fakeCreate();
  await askPromo(bot, u.tg, u.tg, { planKey: 'buy_1month', userId: u.id, email: u.email });
  const brokenDb = { from: () => { throw new Error('db down'); } };
  const handled = await handlePromoMessage(bot, msgOf(u, 'ANYCODE'), { db: brokenDb, create });
  assert.equal(handled, true);
  assert.match(bot.sent.at(-1).text, /Не получилось проверить промокод/);
  assert.equal(create.calls.length, 0);
  assert.equal(userStates.get(u.tg).awaitingPromo, true);
  userStates.delete(u.tg);
});

test('бот: подчёркивание в коде не ломает разметку сообщения; сбой ЮKassa и «оплата недоступна» обрабатываются', async () => {
  const u = await newUser();
  const bot = fakeBot();
  await showPaymentLink(bot, u.tg, 'buy_1month', u.id, u.email, { promo: { code: 'MY_CODE_1', amountOff: 200 }, create: fakeCreate() });
  assert.ok(bot.sent[0].text.includes('MY\\_CODE\\_1'));
  assert.equal(bot.sent[0].opts.parse_mode, 'Markdown');

  for (const [reason, re] of [['not_configured', /Оплата временно недоступна/], ['yookassa_error', /Не получилось создать платёж/], ['promo_not_applicable', /не подходит для этого тарифа/]]) {
    const b = fakeBot();
    await showPaymentLink(b, u.tg, 'buy_1month', u.id, u.email, { create: fakeCreate(reason) });
    assert.match(b.sent[0].text, re, reason);
  }
});

test('подключение: тарифные кнопки ведут на шаг промокода, сообщение обрабатывается до записи трат, кнопка проходит через диспетчер', () => {
  const sub = read('src/handlers/subscription.js');
  assert.ok(sub.includes('askPromo('), 'после тарифа и email спрашиваем промокод');
  assert.equal((sub.match(/askPromo\(/g) || []).length >= 2, true, 'и когда email известен, и когда его только что ввели');
  assert.ok(sub.includes("action === 'buy_nopromo'"));
  const msg = read('src/handlers/message.js');
  const at = (name) => msg.indexOf(`if (await ${name}(bot, msg)) return;`);
  assert.ok(at('handleSubscriptionPromoState') > at('handleSubscriptionEmailState'));
  assert.ok(at('handleSubscriptionPromoState') > 0 && at('handleSubscriptionPromoState') < at('handleManualAmountState'));
  assert.match(read('src/handlers/callbackDispatcher.js'), /action\.startsWith\('buy_'\)/, 'buy_nopromo доходит до обработчика подписки');
  assert.doesNotMatch(read('src/handlers/subscriptionPromo.js'), /from '\.\.\/db\.js'/, 'модуль не зависит от боевой базы');
});
