// Патч 57 (29.10.2026): демо на лендинге (разбор в браузере) и напоминание первого дня в боте.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { makeDb } from './helpers/testDb.mjs';
import { quickParse } from '../src/utils/quickParse.js';
import {
  demoReply, DEMO_NOTE, DEMO_UNKNOWN_TEXT, DEMO_NO_AMOUNT_TEXT, AUTH_LINKS, FLOW, GREETING_BUTTONS, replyFor,
} from '../public/js/landing-widget.js';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:1/test'; // db.js подключается лениво; боевой базы в тестах нет
const { checkFirstRecordNudge, inNudgeWindow, FIRST_RECORD_NUDGE_TEXT } = await import('../src/notifications/index.js');
const { SHARED_MODULES, addSharedModuleRoute } = await import('../src/sharedModules.js');
const { default: express } = await import('express');
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const uid = () => crypto.randomUUID();
const NOW = new Date('2026-10-29T10:00:00+03:00');
let ctx; let db;
before(async () => { ctx = await makeDb(); db = ctx.db; });
after(async () => { await ctx.close(); });

test('демо: «кофе 250» разбирается без ИИ, показывает карточку записи и зовёт создать аккаунт', () => {
  const r = demoReply('кофе 250', quickParse, NOW);
  const q = quickParse('кофе 250', [], '2026-10-29');
  assert.ok(q, 'справочник знает «кофе»');
  assert.match(r.text, /^Записал ✅\n💸 250\s₽ — /);
  assert.ok(r.text.includes(q.category));
  assert.ok(r.text.includes('📅 29 октября'));
  assert.ok(r.text.endsWith(DEMO_NOTE));
  assert.deepEqual(r.links, AUTH_LINKS);
  assert.deepEqual(r.buttons, []);
});

test('демо: доход, бренд и сумма в начале', () => {
  const inc = demoReply('зарплата 120000', quickParse, NOW);
  assert.match(inc.text, /^Ура, доход записан 🎉\n💰 \+120\s000\s₽ — /);
  const brand = quickParse('золотое яблоко 3400', [], '2026-10-29');
  assert.ok(brand?.comment, 'бренд даёт комментарий');
  assert.ok(demoReply('золотое яблоко 3400', quickParse, NOW).text.includes(`(${brand.comment})`));
  assert.ok(demoReply('400 такси', quickParse, NOW).text.includes('400'));
});

test('демо: сложная фраза, фраза без суммы и сбой разбора отвечают честно и без ошибок', () => {
  const hard = demoReply('заплатил за квартиру и интернет 7000', quickParse, NOW);
  assert.equal(hard.text, DEMO_UNKNOWN_TEXT);
  assert.deepEqual(hard.links, AUTH_LINKS);
  const none = demoReply('привет, как дела?', quickParse, NOW);
  assert.equal(none.text, DEMO_NO_AMOUNT_TEXT);
  assert.deepEqual(none.links, []);
  assert.equal(demoReply('кофе 250', null, NOW).text, DEMO_UNKNOWN_TEXT, 'модуль разбора не загрузился');
  assert.equal(demoReply('кофе 250', () => { throw new Error('x'); }, NOW).text, DEMO_UNKNOWN_TEXT);
  assert.equal(demoReply('кофе 99999999999', quickParse, NOW).text, DEMO_UNKNOWN_TEXT, 'нереальная сумма не записывается');
});

test('демо: кнопки приветствия ведут к демо, текст на «ты», сервер не нужен', () => {
  assert.equal(GREETING_BUTTONS[0].to, 'try');
  assert.equal(replyFor('try').text, FLOW.try.text);
  assert.match(FLOW.try.text, /Это демо: ничего не сохраняется/);
  for (const s of [DEMO_NOTE, DEMO_UNKNOWN_TEXT, DEMO_NO_AMOUNT_TEXT, FLOW.try.text]) assert.ok(!/\bвы\b|ите\b|ете\b/i.test(s), s);
  const js = read('public/js/landing-widget.js');
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon/.test(js));
  assert.ok(js.includes("import('/js/shared/quickParse.js')"));
});

test('сервер отдаёт в браузер только три чистых модуля, и они не тянут ничего серверного', () => {
  assert.deepEqual([...SHARED_MODULES].sort(), ['categoryHints.js', 'parseAmount.js', 'quickParse.js']);
  for (const f of SHARED_MODULES) {
    const src = read(`src/utils/${f}`);
    const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    for (const i of imports) assert.ok(i.startsWith('./') && SHARED_MODULES.has(i.slice(2)), `${f}: лишний импорт ${i}`);
    assert.ok(!/process\.|require\(|node:|\bfs\b|supabase/.test(src), `${f}: серверный код`);
  }
  const w = read('src/webhook.js');
  assert.ok(w.includes("addSharedModuleRoute(app, path.join(__dirname, 'utils'))"));
  assert.ok(w.indexOf('addSharedModuleRoute(app') < w.indexOf("express.static(path.join(__dirname, '../public'))"), 'маршрут раньше раздачи public');
});

test('маршрут /js/shared/: отдаёт три модуля как JavaScript и больше ничего из src/utils', async () => {
  const app = express();
  addSharedModuleRoute(app, path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/utils'));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const f of SHARED_MODULES) {
      const r = await fetch(`${base}/js/shared/${f}`);
      assert.equal(r.status, 200, f);
      assert.match(r.headers.get('content-type'), /javascript/);
      assert.equal(await r.text(), read(`src/utils/${f}`));
    }
    for (const f of ['paywall.js', 'access.js', 'botTexts.js', '..%2Fdb.js', '%2e%2e%2Fdb.js']) {
      assert.equal((await fetch(`${base}/js/shared/${f}`)).status, 404, f);
    }
  } finally { server.close(); }
});

test('окно напоминания: с 9:00 до 21:00 по Москве', () => {
  assert.equal(inNudgeWindow(new Date('2026-10-29T08:59:00+03:00')), false);
  assert.equal(inNudgeWindow(new Date('2026-10-29T09:00:00+03:00')), true);
  assert.equal(inNudgeWindow(new Date('2026-10-29T20:59:00+03:00')), true);
  assert.equal(inNudgeWindow(new Date('2026-10-29T21:00:00+03:00')), false);
  assert.equal(inNudgeWindow(new Date('2026-10-29T00:30:00+03:00')), false);
});

const ago = (h, now = NOW) => new Date(now.getTime() - h * 3_600_000).toISOString();
async function tgUser(termsHoursAgo) {
  const id = uid();
  const { error } = await db.from('users').insert({
    id, external_id: String(Math.floor(Math.random() * 1e12)), channel: 'telegram',
    terms_accepted_at: termsHoursAgo === null ? null : ago(termsHoursAgo),
  });
  assert.ifError(error);
  return id;
}
const fakeBot = () => { const sent = []; return { sent, sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); } }; };

test('напоминание первого дня: через 3–24 часа после согласия, без записей, один раз', async () => {
  const fresh = await tgUser(2);        // ещё рано
  const target = await tgUser(4);       // подходит
  const old = await tgUser(25);         // уже поздно
  const noTerms = await tgUser(null);   // согласия нет
  const withTx = await tgUser(5);       // запись есть
  const { data: cats } = await db.from('category_groups').insert({ id: uid(), name: 'Тест57', type: 'expense' }).select();
  const catId = uid();
  await db.from('categories').insert({ id: catId, group_id: cats[0].id, name: 'Продукты57', type: 'expense', is_system: false });
  await db.from('transactions').insert({ id: uid(), user_id: withTx, category_id: catId, type: 'expense', amount: 10, transaction_date: '2026-10-29' });
  const web = uid();
  await db.from('users').insert({ id: web, external_id: 'w' + Math.random(), channel: 'web', terms_accepted_at: ago(4) });

  const { data: targetRow } = await db.from('users').select('external_id').eq('id', target).single();
  const bot = fakeBot();
  assert.equal(await checkFirstRecordNudge(bot, db, NOW), 1);
  assert.equal(bot.sent.length, 1);
  assert.equal(bot.sent[0].chatId, targetRow.external_id);
  assert.equal(bot.sent[0].text, FIRST_RECORD_NUDGE_TEXT);
  assert.match(bot.sent[0].text, /Первой записи пока нет\. Начни с самого простого: напиши, на что ушли деньги сегодня, например «кофе 250»/);
  assert.deepEqual(bot.sent[0].opts.reply_markup.inline_keyboard.flat().map((b) => b.callback_data), ['onboarding:start_transaction']);
  assert.ok(!/потратил/i.test(bot.sent[0].text), 'без угадывания пола');
  // второй проход не пишет повторно
  assert.equal(await checkFirstRecordNudge(bot, db, new Date(NOW.getTime() + 15 * 60_000)), 0);
  assert.equal(bot.sent.length, 1);
  const { data: log } = await db.from('notifications').select('user_id').eq('type', 'first_record_nudge');
  assert.deepEqual(log.map((r) => r.user_id), [target]);
  for (const u of [fresh, old, noTerms, withTx, web]) assert.ok(!log.some((r) => r.user_id === u));
});

test('напоминание ночью не уходит, а утром доходит (если ещё в пределах суток)', async () => {
  const night = new Date('2026-10-30T02:00:00+03:00');
  const u = await tgUser(5);
  await db.from('users').update({ terms_accepted_at: ago(5, night) }).eq('id', u);
  const bot = fakeBot();
  assert.equal(await checkFirstRecordNudge(bot, db, night), 0);
  assert.equal(bot.sent.length, 0);
  const morning = new Date('2026-10-30T09:15:00+03:00'); // с согласия прошло 12 ч 15 мин
  const before = bot.sent.length;
  await checkFirstRecordNudge(bot, db, morning);
  assert.ok(bot.sent.length >= before + 1);
});

test('планировщик: проход каждые 15 минут; письмо-активация через 24 часа', () => {
  const s = read('src/notifications/scheduler.js');
  assert.match(s, /cron\.schedule\('\*\/15 \* \* \* \*', \(\) => \{\s*checkFirstRecordNudge\(bot\)/);
  assert.ok(read('src/emails/chain.js').includes('activationAfter: 24 * H'));
});
