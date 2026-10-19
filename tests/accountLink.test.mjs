// Единый аккаунт бот + сайт: подключение Telegram по одноразовой ссылке, перенос данных, отключение.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { makeDb } from './helpers/testDb.mjs';
import { createLinkToken, peekLinkToken, linkTelegram, disconnectTelegram, botLinkUrl, LINK_TTL_MS, TOKEN_RE } from '../src/accounts/linkTelegram.js';
import { findUserIdByExternalId } from '../src/utils/findUser.js';
import { handleLinkStart, handleLinkCallback, LINK_TEXTS } from '../src/handlers/linkTelegram.js';

let ctx; let db; let SYS;
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const uid = () => crypto.randomUUID();
let seq = 0;

before(async () => {
  ctx = await makeDb();
  db = ctx.db;
  const g = uid();
  await db.from('category_groups').insert({ id: g, name: 'Еда', type: 'expense', sort_order: 1 });
  const c = uid();
  await db.from('categories').insert({ id: c, name: 'Продукты', type: 'expense', group_id: g, user_id: null, is_system: true, is_active: true });
  SYS = { group: g, food: c };
});
after(async () => { await ctx?.close(); });

// Аккаунт с сайта (вход по почте и паролю)
async function webUser(extra = {}) {
  seq += 1;
  const id = uid();
  const { error } = await db.from('users').insert({
    id, external_id: id, channel: 'web', email: `web${seq}-${id.slice(0, 6)}@t.ru`, password_hash: 'x', terms_accepted_at: new Date().toISOString(), ...extra,
  });
  assert.ifError(error);
  return id;
}
// Аккаунт, созданный в боте
async function tgUser(tg, extra = {}) {
  const id = uid();
  const { error } = await db.from('users').insert({ id, external_id: String(tg), channel: 'telegram', tg_username: 'u' + tg, ...extra });
  assert.ifError(error);
  return id;
}
const newTg = () => 900000 + (seq += 1) * 7;
async function addTx(userId, categoryId, amount = 100, extra = {}) {
  const { error } = await db.from('transactions').insert({ id: uid(), user_id: userId, category_id: categoryId, type: 'expense', amount, transaction_date: '2026-10-10', ...extra });
  assert.ifError(error);
}
async function addCat(userId, name) {
  const id = uid();
  const { error } = await db.from('categories').insert({ id, name, type: 'expense', group_id: SYS.group, user_id: userId, is_system: false, is_active: true });
  assert.ifError(error);
  return id;
}
async function addSub(userId, status, endsAt, extra = {}) {
  const { error } = await db.from('subscriptions').insert({ id: uid(), user_id: userId, status, starts_at: new Date().toISOString(), ends_at: endsAt, ...extra });
  assert.ifError(error);
}
const get = async (id) => (await db.from('users').select('*').eq('id', id).single()).data;
const count = async (table, userId) => (await db.from(table).select('id', { count: 'exact', head: true }).eq('user_id', userId)).count;
const days = (n) => new Date(Date.now() + n * 86400000).toISOString();

test('ссылка: создаётся для аккаунта с сайта, в базе только хеш, прежняя ссылка перестаёт работать', async () => {
  const x = await webUser();
  const a = await createLinkToken(db, x);
  assert.equal(a.ok, true);
  assert.match(a.token, TOKEN_RE);
  assert.ok(`start=${a.token}`.length <= 6 + 64, 'payload влезает в 64 символа');
  assert.ok(botLinkUrl(a.token).startsWith('https://t.me/'));
  const { data } = await db.from('telegram_link_tokens').select('*').eq('user_id', x);
  assert.equal(data.length, 1);
  assert.ok(!JSON.stringify(data).includes(a.token), 'токен в базе не хранится');
  const b = await createLinkToken(db, x);
  assert.notEqual(a.token, b.token);
  assert.equal((await peekLinkToken(db, a.token)).reason, 'invalid');
  assert.equal((await peekLinkToken(db, b.token)).ok, true);
  assert.equal(b.expiresAt.getTime() - Date.now() <= LINK_TTL_MS, true);
});

test('ссылка: для уже подключённого Telegram и для удалённого аккаунта не создаётся', async () => {
  const t = await tgUser(newTg());
  assert.equal((await createLinkToken(db, t)).reason, 'already_connected');
  const d = await webUser({ status: 'deleted' });
  assert.equal((await createLinkToken(db, d)).reason, 'no_user');
  assert.equal((await createLinkToken(db, uid())).reason, 'no_user');
});

test('подключение без аккаунта в боте: Telegram привязывается, ссылка гасится, повтор не работает', async () => {
  const x = await webUser();
  const tg = newTg();
  const { token } = await createLinkToken(db, x);
  const r = await linkTelegram(db, { token, telegramId: tg, tgUsername: 'ann' });
  assert.deepEqual({ ok: r.ok, merged: r.merged, userId: r.userId }, { ok: true, merged: false, userId: x });
  const u = await get(x);
  assert.equal(u.channel, 'telegram'); assert.equal(u.external_id, String(tg)); assert.equal(u.tg_username, 'ann');
  assert.ok(u.password_hash, 'вход по почте остался');
  assert.equal(await findUserIdByExternalId(db, tg), x);
  assert.equal((await linkTelegram(db, { token, telegramId: tg })).reason, 'used');
});

test('подключение: просроченная, чужого вида и пустая ссылки, плохой telegram id', async () => {
  const x = await webUser();
  const { token } = await createLinkToken(db, x);
  const late = new Date(Date.now() + LINK_TTL_MS + 1000);
  assert.equal((await linkTelegram(db, { token, telegramId: newTg(), now: late })).reason, 'expired');
  assert.equal((await peekLinkToken(db, token, { now: late })).reason, 'expired');
  assert.equal((await linkTelegram(db, { token: 'link_' + 'a'.repeat(32), telegramId: newTg() })).reason, 'invalid');
  assert.equal((await linkTelegram(db, { token: 'нет', telegramId: newTg() })).reason, 'invalid');
  assert.equal((await linkTelegram(db, { token: undefined, telegramId: newTg() })).reason, 'invalid');
  assert.equal((await linkTelegram(db, { token, telegramId: 'abc' })).reason, 'bad_telegram_id');
  assert.equal((await get(x)).channel, 'web', 'ничего не изменилось');
});

test('объединение: данные бота переходят в аккаунт сайта, одноимённые категории склеиваются, бюджет и цели переносятся', async () => {
  const x = await webUser();
  const tg = newTg();
  const y = await tgUser(tg, { terms_accepted_at: new Date().toISOString() });
  // у X: своя категория «Кошка» и бюджет на октябрь
  const xCat = await addCat(x, 'Кошка');
  await addTx(x, xCat, 50);
  await db.from('budget').insert({ user_id: x, month: '2026-10-01', amount: 70000 });
  // у Y: такая же «кошка», ещё одна «Кафе», цель, бюджет на октябрь и ноябрь, записи
  const yCat = await addCat(y, 'кошка');
  const yCafe = await addCat(y, 'Кафе');
  await addTx(y, yCat, 11); await addTx(y, yCafe, 22); await addTx(y, SYS.food, 33);
  const goalId = uid();
  await db.from('goals').insert({ id: goalId, user_id: y, name: 'Отпуск', target_amount: 100000, future_value: 110000, monthly_payment: 9000, target_date: '2027-10-01' });
  await addTx(y, SYS.food, 44, { type: 'goal', goal_id: goalId });
  await db.from('budget').insert([{ user_id: y, month: '2026-10-01', amount: 10 }, { user_id: y, month: '2026-11-01', amount: 80000 }]);
  await db.from('notifications').insert({ user_id: y, type: 'budget_reminder' });

  const { token } = await createLinkToken(db, x);
  const peek = await peekLinkToken(db, token, { telegramId: tg });
  assert.equal(peek.ownRecords, 4);

  const r = await linkTelegram(db, { token, telegramId: tg, tgUsername: 'ann' });
  assert.equal(r.ok, true); assert.equal(r.merged, true);
  assert.equal(r.moved.transactions, 4); assert.equal(r.moved.goals, 1);

  assert.equal(await count('transactions', x), 5);
  assert.equal(await count('transactions', y), 0);
  assert.equal(await count('goals', x), 1);
  // одноимённая категория склеена: Y-вариант удалён, записи смотрят на категорию X
  const cats = (await db.from('categories').select('id, name').eq('user_id', x)).data.map((c) => c.name.toLowerCase()).sort();
  assert.deepEqual(cats, ['кафе', 'кошка']);
  const txs = (await db.from('transactions').select('category_id').eq('user_id', x)).data;
  assert.equal(txs.filter((t) => t.category_id === xCat).length, 2);
  assert.equal((await db.from('categories').select('id').eq('id', yCat)).data.length, 0);
  // бюджет: октябрь остался от X (70000), ноябрь пришёл от Y
  const bud = (await db.from('budget').select('month, amount').eq('user_id', x)).data;
  const byMonth = Object.fromEntries(bud.map((b) => [String(b.month).slice(0, 10), Number(b.amount)]));
  assert.deepEqual(byMonth, { '2026-10-01': 70000, '2026-11-01': 80000 });
  assert.equal(await count('notifications', x), 1);

  const yy = await get(y);
  assert.equal(yy.status, 'merged'); assert.equal(yy.merged_into, x); assert.equal(yy.channel, 'merged');
  const xx = await get(x);
  assert.equal(xx.channel, 'telegram'); assert.equal(xx.external_id, String(tg));
  assert.equal(await findUserIdByExternalId(db, tg), x, 'бот теперь находит аккаунт с сайта');
});

test('объединение: оплаченные периоды складываются, пробный период переносится, промокод остаётся за аккаунтом', async () => {
  const x = await webUser();
  const tg = newTg();
  const y = await tgUser(tg);
  await addSub(x, 'active', days(30), { payment_id: 'px-' + uid(), period_months: 1 });
  await addSub(y, 'active', days(10), { payment_id: 'py-' + uid(), period_months: 1 });
  await addSub(y, 'trial', days(5));
  await db.from('promo_codes').insert({ code: 'LINK' + seq + 'A', amount_off_rub: 100 });
  await db.from('promo_redemptions').insert({ code: 'LINK' + seq + 'A', user_id: y, payment_id: 'py-r-' + uid(), amount_off_rub: 100 });

  const { token } = await createLinkToken(db, x);
  const r = await linkTelegram(db, { token, telegramId: tg });
  assert.equal(r.ok, true);
  assert.equal(await count('subscriptions', x), 3);
  assert.equal(await count('promo_redemptions', x), 1);
  const act = (await db.from('subscriptions').select('ends_at, payment_id').eq('user_id', x).eq('status', 'active')).data
    .map((s) => Date.parse(s.ends_at)).sort((a, b) => b - a);
  const expected = Date.now() + 40 * 86400000;
  assert.ok(Math.abs(act[0] - expected) < 60000, `самая поздняя дата ≈ через 40 дней, а не ${(act[0] - Date.now()) / 86400000}`);
});

test('объединение не трогает аккаунт Telegram, у которого свой вход по почте: ничего не меняется, ссылка не сгорает', async () => {
  const x = await webUser();
  const tg = newTg();
  const y = await tgUser(tg, { password_hash: 'z', email: `ywith${seq}@t.ru` });
  await addTx(y, SYS.food, 5);
  const { token } = await createLinkToken(db, x);
  const r = await linkTelegram(db, { token, telegramId: tg });
  assert.deepEqual(r, { ok: false, reason: 'telegram_has_login' });
  assert.equal(await count('transactions', y), 1);
  assert.equal((await get(y)).status ?? 'active', 'active');
  assert.equal((await get(x)).channel, 'web');
  assert.equal((await peekLinkToken(db, token)).ok, true);
});

test('перенос атомарный: сбой посреди переноса откатывает всё, данные остаются на месте', async () => {
  const x = await webUser();
  const tg = newTg();
  const y = await tgUser(tg);
  await addTx(y, SYS.food, 9);
  await db.from('goals').insert({ user_id: y, name: 'Г', target_amount: 1, future_value: 1, monthly_payment: 1, target_date: '2027-01-01' });
  const { token } = await createLinkToken(db, x);
  const broken = { ...db, from: db.from.bind(db), transaction: (fn) => db.transaction((tx) => fn({ query: (t, p) => { if (t.includes('UPDATE public.goals')) throw new Error('boom'); return tx.query(t, p); } })) };
  const r = await linkTelegram(broken, { token, telegramId: tg });
  assert.deepEqual(r, { ok: false, reason: 'db' });
  assert.equal(await count('transactions', y), 1, 'записи не уехали');
  assert.equal(await count('transactions', x), 0);
  assert.equal((await get(y)).channel, 'telegram');
  assert.equal((await get(x)).channel, 'web');
  assert.equal((await peekLinkToken(db, token)).ok, true, 'ссылка осталась рабочей');
  // и с нормальной базой всё получается
  assert.equal((await linkTelegram(db, { token, telegramId: tg })).ok, true);
  assert.equal(await count('transactions', x), 1);
});

test('старая удалённая запись с этим telegram id не мешает подключению', async () => {
  const tg = newTg();
  const old = await tgUser(tg, { status: 'deleted' });
  const x = await webUser();
  const { token } = await createLinkToken(db, x);
  const r = await linkTelegram(db, { token, telegramId: tg });
  assert.equal(r.ok, true); assert.equal(r.merged, false);
  assert.equal((await get(x)).external_id, String(tg));
  assert.notEqual((await get(old)).external_id, String(tg));
});

test('к аккаунту с другим Telegram подключить второй нельзя; тот же Telegram повторно — «уже подключён»', async () => {
  const tg = newTg();
  const x = await webUser();
  let { token } = await createLinkToken(db, x);
  await linkTelegram(db, { token, telegramId: tg });
  // новую ссылку для подключённого аккаунта создать нельзя, а старую подсунуть можно только если токен жив:
  await db.from('telegram_link_tokens').insert({ user_id: x, token_hash: crypto.createHash('sha256').update('link_' + 'b'.repeat(32)).digest('hex'), expires_at: days(1) });
  assert.equal((await linkTelegram(db, { token: 'link_' + 'b'.repeat(32), telegramId: newTg() })).reason, 'other_connected');
  await db.from('telegram_link_tokens').insert({ user_id: x, token_hash: crypto.createHash('sha256').update('link_' + 'c'.repeat(32)).digest('hex'), expires_at: days(1) });
  const again = await linkTelegram(db, { token: 'link_' + 'c'.repeat(32), telegramId: tg });
  assert.equal(again.ok, true); assert.equal(again.already, true); assert.equal(again.merged, false);
});

test('отключение: аккаунт становится аккаунтом сайта со всеми данными, Telegram освобождается и подключается снова', async () => {
  const tg = newTg();
  const x = await webUser();
  const { token } = await createLinkToken(db, x);
  await linkTelegram(db, { token, telegramId: tg });
  await addTx(x, SYS.food, 1);
  assert.deepEqual(await disconnectTelegram(db, x), { ok: true });
  const u = await get(x);
  assert.equal(u.channel, 'web'); assert.equal(u.external_id, x); assert.equal(u.tg_username, null);
  assert.equal(await count('transactions', x), 1);
  assert.equal(await findUserIdByExternalId(db, tg), null, 'Telegram больше не связан');
  assert.deepEqual(await disconnectTelegram(db, x), { ok: true, already: true });
  // в боте этот человек начинает с нуля и может снова подключиться, данные при этом объединятся
  const y = await tgUser(tg);
  await addTx(y, SYS.food, 2);
  const t2 = await createLinkToken(db, x);
  const r = await linkTelegram(db, { token: t2.token, telegramId: tg });
  assert.equal(r.ok, true); assert.equal(r.merged, true);
  assert.equal(await count('transactions', x), 2);
});

test('отключение: аккаунт только из Telegram (без входа по почте) отключить нельзя, данные целы', async () => {
  const tg = newTg();
  const y = await tgUser(tg);
  assert.deepEqual(await disconnectTelegram(db, y), { ok: false, reason: 'no_login' });
  assert.equal((await get(y)).channel, 'telegram');
  assert.deepEqual(await disconnectTelegram(db, uid()), { ok: false, reason: 'no_user' });
});

test('поиск аккаунта в боте: не падает от нескольких строк, пропускает объединённые и удалённые, не находит чужого', async () => {
  const tg = newTg();
  assert.equal(await findUserIdByExternalId(db, tg), null);
  await tgUser(tg, { status: 'deleted' });
  assert.equal(await findUserIdByExternalId(db, tg), null);
  const ext = 'dup-' + tg;
  const a = uid(); const b = uid();
  await db.from('users').insert([{ id: a, external_id: ext, channel: 'web' }, { id: b, external_id: ext, channel: 'telegram' }]);
  assert.equal(await findUserIdByExternalId(db, ext), b, 'при двух активных выбирается telegram');
  assert.equal(await findUserIdByExternalId(db, undefined), null);
});

// ── Бот ──
const menu = { showConsentScreen: async () => {}, showMainMenu: async () => {} };
const fakeBot = () => {
  const sent = [];
  return { sent, sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); return {}; }, answerCallbackQuery: async () => {} };
};
const buttons = (m) => m.opts.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);

test('бот: ссылка показывает, к какому аккаунту подключаем (почта скрыта), кнопки укладываются в 64 байта', async () => {
  const x = await webUser();
  const tg = newTg();
  const { token } = await createLinkToken(db, x);
  const bot = fakeBot();
  const handled = await handleLinkStart(bot, { chat: { id: tg }, from: { id: tg } }, token, { db });
  assert.equal(handled, true);
  assert.match(bot.sent[0].text, /Подключить этот Telegram к аккаунту \w\*\*\*@/);
  const cb = buttons(bot.sent[0]);
  assert.deepEqual(cb, [`link:ok:${token}`, 'link:cancel']);
  assert.ok(cb.every((c) => Buffer.byteLength(c) <= 64));
  assert.ok(!bot.sent[0].text.includes((await get(x)).email), 'полная почта не показывается');
});

test('бот: если в боте уже есть записи, об этом сказано; плохая ссылка — понятный текст, не «не нашёл аккаунт»', async () => {
  const x = await webUser(); const tg = newTg(); const y = await tgUser(tg);
  await addTx(y, SYS.food, 1); await addTx(y, SYS.food, 2);
  const { token } = await createLinkToken(db, x);
  const bot = fakeBot();
  await handleLinkStart(bot, { chat: { id: tg }, from: { id: tg } }, token, { db });
  assert.match(bot.sent[0].text, /уже есть записи \(2\)/);
  const bot2 = fakeBot();
  await handleLinkStart(bot2, { chat: { id: tg }, from: { id: tg } }, 'link_' + 'z'.repeat(30), { db });
  assert.equal(bot2.sent[0].text, LINK_TEXTS.invalid);
  assert.equal(await handleLinkStart(bot2, { chat: { id: tg }, from: { id: tg } }, 'ref_abc', { db }), false, 'чужой payload не обрабатывается');
});

test('бот: «Подключить» переносит данные и сообщает итог; «Отмена» ничего не меняет', async () => {
  const x = await webUser(); const tg = newTg(); const y = await tgUser(tg, { terms_accepted_at: new Date().toISOString() });
  await addTx(y, SYS.food, 1);
  const { token } = await createLinkToken(db, x);
  const cancelBot = fakeBot();
  await handleLinkCallback(cancelBot, { id: 'q', data: 'link:cancel', from: { id: tg }, message: { chat: { id: tg } } }, { db, ...menu });
  assert.equal((await get(x)).channel, 'web');
  const bot = fakeBot();
  await handleLinkCallback(bot, { id: 'q', data: `link:ok:${token}`, from: { id: tg, username: 'ann' }, message: { chat: { id: tg } } }, { db, ...menu });
  assert.match(bot.sent[0].text, /Telegram подключён/);
  assert.match(bot.sent[0].text, /1 запись/);
  assert.equal((await get(x)).external_id, String(tg));
  // повторное нажатие на ту же кнопку: честное «уже использована»
  const bot2 = fakeBot();
  await handleLinkCallback(bot2, { id: 'q', data: `link:ok:${token}`, from: { id: tg }, message: { chat: { id: tg } } }, { db, ...menu });
  assert.equal(bot2.sent[0].text, LINK_TEXTS.used);
});

// ── Подключение кода ──
test('проводка: /start с link_ и кнопки link: обрабатываются до проверки согласия; кабинет использует новые функции', () => {
  const start = read('src/handlers/start.js');
  assert.ok(start.indexOf('handleLinkStart(bot, msg, payload') > 0 && start.indexOf('handleLinkStart(bot, msg, payload') < start.indexOf('.from(\'users\')'), 'ссылка разбирается до создания пустого аккаунта');
  const d = read('src/handlers/callbackDispatcher.js');
  assert.ok(d.indexOf("action.startsWith('link:')") > 0 && d.indexOf("action.startsWith('link:')") < d.indexOf('requireTerms(bot'), 'link: до requireTerms');
  const routes = read('src/cabinetRoutes.js');
  assert.ok(routes.includes("'/api/profile/telegram-link'") && routes.includes('createLinkToken') && routes.includes('disconnectTelegram'));
  assert.ok(!routes.includes('merge-telegram'), 'сломанный merge-telegram удалён');
  assert.ok(!/external_id: null, channel: null/.test(routes), 'отключение больше не пишет NULL в обязательные поля');
  const html = read('public/cabinet/profile.html');
  assert.ok(html.includes('/api/profile/telegram-link') && html.includes('tgDisconnectError') && !html.includes('отправить ему любое сообщение'));
});

test('в обработчиках бота нет собственных поисков аккаунта через .single() без статуса', () => {
  for (const f of ['budget', 'categories', 'message', 'subscription', 'onboarding', 'analytics', 'goal']) {
    const s = read(`src/handlers/${f}.js`);
    assert.ok(s.includes('findUserIdByExternalId'), f);
    assert.ok(!/async function getUserId/.test(s), f);
  }
});
