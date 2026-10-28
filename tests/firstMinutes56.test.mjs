// Патч 56 (28.10.2026): «Первые 5 минут» — приветствие, подсказка после первой записи, чат сам открывается в кабинете.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { makeDb } from './helpers/testDb.mjs';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:1/test'; // db.js подключается лениво; боевой базы в тестах нет
const { maybeShowFirstRecordTip } = await import('../src/handlers/onboarding.js');

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const uid = () => crypto.randomUUID();
const flat = (t) => t.replace(/\s+/g, ' ').trim();
let ctx; let db;
before(async () => { ctx = await makeDb(); db = ctx.db; });
after(async () => { await ctx.close(); });

const fakeBot = () => { const sent = []; return { sent, sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); } }; };

async function seedUser() {
  const groupId = uid(); const catId = uid(); const userId = uid();
  await db.from('category_groups').insert({ id: groupId, name: 'Тест', type: 'expense' });
  await db.from('categories').insert({ id: catId, group_id: groupId, name: 'Продукты', type: 'expense', is_system: false });
  await db.from('users').insert({ id: userId, external_id: String(Math.floor(Math.random() * 1e9)), channel: 'telegram' });
  const add = async () => {
    const id = uid();
    const { error } = await db.from('transactions').insert({ id, user_id: userId, category_id: catId, type: 'expense', amount: 100, transaction_date: '2026-10-28' });
    assert.ifError(error);
    return id;
  };
  return { userId, add };
}

test('после самой первой записи бот один раз предлагает цель и бюджет', async () => {
  const { add } = await seedUser();
  const bot = fakeBot();
  const first = await add();
  assert.equal(await maybeShowFirstRecordTip(bot, 77, first, db), true);
  assert.equal(bot.sent.length, 1);
  assert.match(bot.sent[0].text, /Вот и первая запись/);
  const cbs = bot.sent[0].opts.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(cbs, ['onboarding:start_goal', 'onboarding:start_budget']);
  const second = await add();
  assert.equal(await maybeShowFirstRecordTip(bot, 77, second, db), false);
  assert.equal(bot.sent.length, 1, 'на второй записи подсказки нет');
  assert.equal(await maybeShowFirstRecordTip(bot, 77, null, db), false);
});

test('тексты бота: «Я бот сервиса Финник Деньги», «Я дарю тебе», главная кнопка первая, без «ты/вы» ошибок', () => {
  const o = read('src/handlers/onboarding.js').replace(/`\s*\+\s*`/g, '');
  assert.ok(o.includes('Привет! Я бот сервиса Финник Деньги 👋'));
  assert.ok(!o.includes('Я Финник — твой') && !o.includes('Я включил тебе'));
  assert.ok(o.includes('Я дарю тебе 30 дней бесплатного доступа ко всем функциям'));
  assert.ok(o.includes('Категорию и сумму я определю сам, а ты поправишь, если нужно'));
  assert.ok(!o.includes('пара формальностей'));
  assert.ok(o.includes('Чтобы начать, нужно твоё согласие.'));
  // главное действие первым, четыре «расскажи» — под «Что ещё умею»
  assert.match(o, /STEP1_TRIAL_KEYBOARD = \{\s*reply_markup: \{\s*inline_keyboard: \[FIRST_RECORD_ROW, MORE_ROW\]/);
  assert.ok(o.includes("callback_data: 'onboarding:more'"));
  assert.ok(o.includes("action === 'onboarding:more'"));
  // юридическая часть согласия не изменилась
  assert.ok(o.includes('за пределами России (Нидерланды, США)'));
  assert.ok(o.includes('Имя и контакты при этом не передаются'));
  // в ответе про запись нет утверждения, что данные не передаются третьим лицам
  assert.ok(!flat(o).includes('не передаются третьим лицам'));
  assert.ok(o.includes('хранятся на защищённом сервере в России'));
  for (const s of [o, read('public/js/landing-widget.js')]) assert.ok(!/\bвы\b/i.test(s));
});

test('виджет на лендинге не говорит «не передаются третьим лицам»', () => {
  assert.ok(!flat(read('public/js/landing-widget.js').replace(/'\s*\+\s*'/g, '')).includes('не передаются третьим лицам'));
});

test('подсказка после первой записи подключена к подтверждению записи', () => {
  const m = read('src/handlers/message.js');
  assert.match(m, /await bot\.sendMessage\(chatId, buildConfirmationText\(parsed\), keyboard\);\s*\/\/[^\n]*\n\s*await maybeShowFirstRecordTip\(bot, chatId, txId\);/);
});

test('кабинет: дашборд сообщает, что записей нет, и при первом заходе открывает чат один раз на человека', () => {
  const r = read('src/cabinetRoutes.js');
  assert.ok(r.includes('no_records: (txTotal ?? 0) === 0'));
  const d = read('public/cabinet/dashboard.html');
  assert.ok(d.includes('if (d.no_records) autoOpenChatOnce(d.user && d.user.id);'));
  assert.ok(d.includes("'finnik_chat_autoopen_' + (userId || '')"));
  assert.match(d, /try \{\s*if \(localStorage\.getItem\(key\)\) return;\s*localStorage\.setItem\(key, '1'\);\s*\} catch \(e\) \{ return; \}/);
  assert.ok(d.includes('window.openBotWidget()'));
});

test('лендинг: шаги «Создай аккаунт → Сделай первую запись → Установи виджет»', () => {
  const h = read('public/index.html');
  const i1 = h.indexOf('Создай аккаунт на сайте');
  const i2 = h.indexOf('Сделай свою первую запись: просто напиши в чате');
  const i3 = h.indexOf('Установи виджет бота на экран телефона, чтобы чат был под рукой');
  assert.ok(i1 > 0 && i2 > i1 && i3 > i2);
  assert.ok(!h.includes('Сделай свою первую запись!'));
});
