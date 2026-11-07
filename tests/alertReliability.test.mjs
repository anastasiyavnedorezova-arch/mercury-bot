import test from 'node:test';
import assert from 'node:assert/strict';
import { alertApiBases, sendTelegramAlert } from '../src/utils/alertTelegram.js';
import { healthAlertRecipients, dispatchHealthAlerts, sendHealthTestEmail } from '../src/utils/healthDelivery.js';
import { checkBackupRelay, runChecks, ALL_CHECKS } from '../src/utils/healthChecks.js';
import { evaluate } from '../src/utils/healthLogic.js';

const env = {
  ALERT_BOT_TOKEN: '123:SECRET', ALERT_CHAT_ID: '42',
  TELEGRAM_API_BASE_URL: 'https://hostkey.example/telegram',
  ALERT_TELEGRAM_API_BASE_URL: 'https://quicksrv.example/telegram',
  ALERT_TELEGRAM_FALLBACK_API_BASE_URL: 'https://hostkey.example/telegram',
  ADMIN_NOTIFY_EMAIL: 'hello@example.ru',
  HEALTH_ALERT_EMAILS: 'hello@example.ru,nastya@example.ru',
};
const response = (status = 200, body = { ok: true }) => ({ ok: status === 200, status, json: async () => body });
const down = [{ name: 'telegram', ok: false, detail: 'test failure' }];
const up = [{ name: 'telegram', ok: true }];

test('alerts use independent quicksrv even while application route Hostkey is down', async () => {
  const called = [];
  const result = await sendTelegramAlert('test', env, async (url) => {
    called.push(url);
    if (url.startsWith(env.TELEGRAM_API_BASE_URL)) throw new Error('Hostkey is down');
    return response();
  });
  assert.equal(result.ok, true);
  assert.equal(result.route, 'quicksrv.example');
  assert.deepEqual(called, [`${env.ALERT_TELEGRAM_API_BASE_URL}/bot${env.ALERT_BOT_TOKEN}/sendMessage`]);
});

test('quicksrv failure tries configured fallback once; identical routes are deduplicated', async () => {
  const called = [];
  const result = await sendTelegramAlert('test', env, async (url) => {
    called.push(url);
    return url.startsWith(env.ALERT_TELEGRAM_API_BASE_URL) ? response(502, {}) : response();
  });
  assert.equal(result.ok, true);
  assert.equal(result.route, 'hostkey.example');
  assert.equal(called.length, 2);
  assert.equal(alertApiBases({ ...env, ALERT_TELEGRAM_FALLBACK_API_BASE_URL: env.ALERT_TELEGRAM_API_BASE_URL + '/' }).length, 1);
});

test('both routes fail safely and secrets from remote descriptions/errors are never returned', async () => {
  let count = 0;
  const result = await sendTelegramAlert('test', env, async () => {
    if (++count === 1) throw new Error(`failure ${env.ALERT_BOT_TOKEN}`);
    return response(401, { description: env.ALERT_BOT_TOKEN });
  });
  assert.equal(result.ok, false);
  assert.equal(count, 2);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  const invalid = await sendTelegramAlert('x', { ...env, ALERT_TELEGRAM_API_BASE_URL: 'https://user:SECRET@bad.example' }, () => assert.fail('invalid route must not send'));
  assert.equal(invalid.ok, false);
  assert.doesNotMatch(JSON.stringify(invalid), /SECRET/);
});

test('health email list is isolated from customer/support mail, validated and deduplicated', () => {
  assert.deepEqual(healthAlertRecipients({ ...env, HEALTH_ALERT_EMAILS: 'HELLO@example.ru; nastya@example.ru,hello@example.ru' }), ['hello@example.ru', 'nastya@example.ru']);
  assert.deepEqual(healthAlertRecipients({ ADMIN_NOTIFY_EMAIL: 'old@example.ru' }), ['old@example.ru']);
  assert.deepEqual(healthAlertRecipients({ MAIL_FROM_EMAIL: 'sender@example.ru' }), ['sender@example.ru']);
  assert.throws(() => healthAlertRecipients({ HEALTH_ALERT_EMAILS: 'one@example.ru,broken' }), /configuration/);
});

test('failed second email retries independently, successful first email and Telegram do not repeat', async () => {
  const sent = [];
  let secondEmailWorks = false;
  const deps = {
    sendEmailImpl: async ({ to }) => { sent.push(to); return { ok: to === 'hello@example.ru' || secondEmailWorks }; },
    sendTelegramImpl: async () => { sent.push('telegram'); return { ok: true }; },
  };
  let r = await dispatchHealthAlerts({}, down, 0, env, deps);
  assert.equal(sent.length, 0); // first failure
  r = await dispatchHealthAlerts(r.state, down, 300000, env, deps);
  assert.deepEqual(sent.sort(), ['hello@example.ru', 'nastya@example.ru', 'telegram']);
  secondEmailWorks = true;
  sent.length = 0;
  r = await dispatchHealthAlerts(r.state, down, 600000, env, deps);
  assert.deepEqual(sent, ['nastya@example.ru']);
  sent.length = 0;
  r = await dispatchHealthAlerts(r.state, down, 900000, env, deps);
  assert.equal(sent.length, 0);
});

test('recovery failure is retried only for that destination and does not resend other recoveries', async () => {
  let failRecovery = false;
  const sent = [];
  const deps = {
    sendEmailImpl: async ({ to, subject }) => {
      sent.push([to, subject]);
      return { ok: !(failRecovery && to === 'nastya@example.ru') };
    },
    sendTelegramImpl: async () => ({ ok: true }),
  };
  let { state } = await dispatchHealthAlerts({}, down, 0, env, deps);
  ({ state } = await dispatchHealthAlerts(state, down, 300000, env, deps));
  sent.length = 0;
  failRecovery = true;
  ({ state } = await dispatchHealthAlerts(state, up, 600000, env, deps));
  assert.equal(sent.length, 2);
  assert.ok(sent.every(([, subject]) => subject.includes('восстановлено')));
  sent.length = 0;
  failRecovery = false;
  ({ state } = await dispatchHealthAlerts(state, up, 900000, env, deps));
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'nastya@example.ru');
});

test('exception in one sender does not cancel the second email or Telegram', async () => {
  const sent = [];
  const deps = {
    sendEmailImpl: async ({ to }) => { sent.push(to); if (to === 'hello@example.ru') throw new Error('failed'); return { ok: true }; },
    sendTelegramImpl: async () => { sent.push('telegram'); return { ok: true }; },
  };
  const initial = (await dispatchHealthAlerts({}, down, 0, env, deps)).state;
  const r = await dispatchHealthAlerts(initial, down, 300000, env, deps);
  assert.equal(sent.length, 3);
  assert.equal(r.outcomes.find((x) => x.destination === 'Telegram').ok, true);
  assert.equal(r.state.deliveries['email:hello@example.ru'].checks.telegram.alerted, false);
});

test('migration preserves old incident state but newly added email independently receives ongoing failure', async () => {
  let legacy = evaluate({}, down, 0).state;
  legacy = evaluate(legacy, down, 300000).state;
  const sent = [];
  const deps = { sendEmailImpl: async ({ to }) => { sent.push(to); return { ok: true }; }, sendTelegramImpl: async () => assert.fail('already delivered') };
  let r = await dispatchHealthAlerts(legacy, down, 600000, env, deps);
  assert.deepEqual(sent, []);
  r = await dispatchHealthAlerts(r.state, down, 900000, env, deps);
  assert.deepEqual(sent, ['nastya@example.ru']);
});

test('test email attempts both recipients despite one error', async () => {
  const calls = [];
  const r = await sendHealthTestEmail(env, async ({ to }) => { calls.push(to); if (calls.length === 1) throw new Error('x'); return { ok: true }; });
  assert.equal(calls.length, 2);
  assert.deepEqual(r.map((x) => x.ok), [false, true]);
});

test('backup check validates both APIs with credentials and the backup certificate, not main relay', async () => {
  const calls = [];
  let certEnv;
  const result = await checkBackupRelay({ ...env, BACKUP_RELAY_BASE_URL: 'https://backup.example', TELEGRAM_BOT_TOKEN: 'BOT-SECRET', OPENAI_API_KEY: 'KEY-SECRET' }, 1000, {
    fetchImpl: async (url, options) => { calls.push([url, options]); return response(); },
    checkCertImpl: async (args, now) => { certEnv = args; assert.equal(now, 1000); return { ok: true }; },
  });
  assert.deepEqual(result, { name: 'relay_backup', ok: true });
  assert.equal(calls[0][0], 'https://backup.example/telegram/botBOT-SECRET/getMe');
  assert.equal(calls[1][0], 'https://backup.example/openai/v1/models');
  assert.equal(calls[1][1].headers.Authorization, 'Bearer KEY-SECRET');
  assert.equal(certEnv.HEALTH_CERT_HOST, 'backup.example');
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test('backup check reports API failure and certificate expiry without leaking credentials', async () => {
  const r = await checkBackupRelay({ BACKUP_RELAY_BASE_URL: 'https://backup.example', TELEGRAM_BOT_TOKEN: 'BOT-SECRET', OPENAI_API_KEY: 'KEY-SECRET' }, 0, {
    fetchImpl: async () => response(502, { description: 'BOT-SECRET' }),
    checkCertImpl: async () => ({ ok: false, detail: 'сертификат backup.example истекает через 3 дн.' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /Telegram: HTTP 502/);
  assert.match(r.detail, /OpenAI: HTTP 502/);
  assert.match(r.detail, /истекает/);
  assert.doesNotMatch(JSON.stringify(r), /SECRET/);
});

test('backup check is opt-in for old installations and can be force-failed for isolated simulation', async () => {
  const skip = Object.keys(ALL_CHECKS).filter((n) => n !== 'relay_backup').join(',');
  assert.deepEqual(await runChecks({ HEALTHCHECK_SKIP: skip }), []);
  const forced = await runChecks({ HEALTHCHECK_SKIP: skip, HEALTHCHECK_FORCE_FAIL: 'relay_backup' });
  assert.deepEqual(forced, [{ name: 'relay_backup', ok: false, detail: 'тестовая имитация поломки' }]);
});
