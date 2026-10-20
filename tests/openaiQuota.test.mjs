// Закончились деньги на счёте OpenAI: людям вежливый ответ, администратору тревога (не чаще раза в 6 часов).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isQuotaError, notifyQuotaExhausted, replyIfQuota, resetQuotaNotifyForTests, QUOTA_NOTIFY_COOLDOWN_MS, QUOTA_ALERT_TEXT } from '../src/utils/openaiErrors.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const quiet = { error() {}, warn() {}, log() {} };

test('isQuotaError: нет денег — да; обычное ограничение частоты, сеть и мусор — нет', () => {
  assert.equal(isQuotaError({ status: 429, code: 'insufficient_quota' }), true);
  assert.equal(isQuotaError({ status: 429, error: { code: 'insufficient_quota' } }), true);
  assert.equal(isQuotaError({ error: { error: { code: 'billing_hard_limit_reached' } } }), true);
  assert.equal(isQuotaError({ status: 429, code: 'rate_limit_exceeded' }), false);
  assert.equal(isQuotaError(new Error('fetch failed')), false);
  assert.equal(isQuotaError(null), false);
  assert.equal(isQuotaError(undefined), false);
});

test('тревога: Telegram и письмо, повторно не чаще раза в 6 часов, потом снова', async () => {
  resetQuotaNotifyForTests();
  const tgCalls = []; const mailCalls = [];
  const deps = (now) => ({ now, logger: quiet, env: { ADMIN_NOTIFY_EMAIL: 'hello@example.ru' }, tg: async (t) => { tgCalls.push(t); return { ok: true }; }, mail: async (m) => { mailCalls.push(m); return { ok: true }; } });
  assert.equal(await notifyQuotaExhausted(deps(1_000_000)), true);
  assert.equal(tgCalls.length, 1); assert.equal(mailCalls.length, 1);
  assert.match(tgCalls[0], /Проект: Финник/); assert.match(tgCalls[0], /Buy credits/);
  assert.equal(mailCalls[0].to, 'hello@example.ru'); assert.match(mailCalls[0].subject, /закончились деньги/);
  assert.equal(await notifyQuotaExhausted(deps(1_000_000 + 60_000)), false, 'через минуту — тишина');
  assert.equal(tgCalls.length, 1);
  assert.equal(await notifyQuotaExhausted(deps(1_000_000 + QUOTA_NOTIFY_COOLDOWN_MS + 1)), true, 'через 6 часов — снова');
  assert.equal(tgCalls.length, 2);
  assert.ok(QUOTA_ALERT_TEXT.length < 3900);
});

test('сбой отправки тревоги не ломает ответ человеку', async () => {
  resetQuotaNotifyForTests();
  const sent = [];
  const bot = { sendMessage: async (...a) => sent.push(a) };
  const boom = async () => { throw new Error('нет связи'); };
  const handled = await replyIfQuota({ code: 'insufficient_quota' }, bot, 9, { now: 5, logger: quiet, env: {}, tg: boom, mail: boom });
  assert.equal(handled, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 9);
  assert.equal(sent[0][1], 'Ой, мне надо немного отдохнуть 😔 Пока я перезагружаюсь, добавь запись вручную, пожалуйста 🙏');
  assert.equal(sent[0][2].reply_markup.inline_keyboard[0][0].callback_data, 'manual:start');
});

test('другая ошибка не перехватывается: обработчик показывает обычный ответ', async () => {
  const sent = [];
  assert.equal(await replyIfQuota(new Error('timeout'), { sendMessage: async (...a) => sent.push(a) }, 1, { logger: quiet }), false);
  assert.equal(sent.length, 0);
});

test('подключено во всех местах, где бот зовёт ИИ', () => {
  for (const [file, n] of [['src/handlers/message.js', 2], ['src/handlers/voice.js', 1], ['src/handlers/fileUpload.js', 2]]) {
    assert.equal((read(file).match(/replyIfQuota\(err, bot, chatId\)/g) || []).length, n, file);
  }
});

test('таймер сторожа стартует и на уже работающем сервере', () => {
  assert.match(read('deploy/relay/finnik-watch.timer'), /OnActiveSec=1min/);
});
