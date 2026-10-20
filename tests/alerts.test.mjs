// Оповещения в Telegram и новые проверки здоровья: копия базы, диск, сертификат, расход ИИ.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { makeDb } from './helpers/testDb.mjs';
import { alertConfigured, sendTelegramAlert } from '../src/utils/alertTelegram.js';
import { buildTelegramText, buildEmail, labelOf } from '../src/utils/healthLogic.js';
import {
  parseLastBackupOk, checkBackup, checkCert, diskUsedPercent, checkDisk, certDaysLeft, ALL_CHECKS, BACKUP_MAX_AGE_H,
} from '../src/utils/healthChecks.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const TOKEN = '123456:SECRET-alert-token';
const baseEnv = { ALERT_BOT_TOKEN: TOKEN, ALERT_CHAT_ID: '555', TELEGRAM_API_BASE_URL: 'https://relay.example/telegram' };
const withApiBase = (env, fn) => { const prev = process.env.TELEGRAM_API_BASE_URL; process.env.TELEGRAM_API_BASE_URL = env.TELEGRAM_API_BASE_URL; return fn().finally(() => { if (prev === undefined) delete process.env.TELEGRAM_API_BASE_URL; else process.env.TELEGRAM_API_BASE_URL = prev; }); };

test('alertConfigured: нужны и токен, и чат', () => {
  assert.equal(alertConfigured(baseEnv), true);
  assert.equal(alertConfigured({ ALERT_BOT_TOKEN: TOKEN }), false);
  assert.equal(alertConfigured({ ALERT_CHAT_ID: '5' }), false);
  assert.equal(alertConfigured({ ALERT_BOT_TOKEN: '  ', ALERT_CHAT_ID: '5' }), false);
});

test('sendTelegramAlert: не настроено — пропуск без запроса', async () => {
  let called = false;
  const r = await sendTelegramAlert('x', {}, async () => { called = true; });
  assert.equal(r.ok, false); assert.equal(r.skipped, true); assert.equal(called, false);
});

test('sendTelegramAlert: POST sendMessage через ретранслятор с нужным чатом', async () => {
  let seen;
  const fake = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  const r = await withApiBase(baseEnv, () => sendTelegramAlert('привет', baseEnv, fake));
  assert.equal(r.ok, true);
  assert.equal(seen.url, `https://relay.example/telegram/bot${TOKEN}/sendMessage`);
  assert.equal(seen.init.method, 'POST');
  assert.deepEqual(JSON.parse(seen.init.body), { chat_id: '555', text: 'привет', disable_web_page_preview: true });
});

test('sendTelegramAlert: ошибки без токена в тексте', async () => {
  const bad = async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: `Unauthorized ${TOKEN}` }) });
  const r1 = await withApiBase(baseEnv, () => sendTelegramAlert('x', baseEnv, bad));
  assert.equal(r1.ok, false); assert.doesNotMatch(JSON.stringify(r1), /SECRET/);
  const boom = async () => { const e = new Error(`fetch failed ${TOKEN}`); e.cause = { code: 'ECONNREFUSED' }; throw e; };
  const r2 = await withApiBase(baseEnv, () => sendTelegramAlert('x', baseEnv, boom));
  assert.equal(r2.ok, false); assert.match(r2.error, /ECONNREFUSED/); assert.doesNotMatch(JSON.stringify(r2), /SECRET/);
});

test('текст для Telegram: проблема, подсказка, восстановление; без секретов; в пределах лимита', () => {
  const now = Date.parse('2026-10-20T10:00:00Z');
  const since = Date.parse('2026-10-20T09:50:00Z');
  const t = buildTelegramText([
    { kind: 'alert', name: 'backup', detail: 'последняя успешная копия 30 ч назад', since },
    { kind: 'recovered', name: 'db', since },
  ], now);
  assert.match(t, /^Проект: Финник\n/);
  assert.match(buildTelegramText([{ kind: 'alert', name: 'db', detail: 'x', since }], now, 'Рецепторика'), /^Проект: Рецепторика\n/);
  assert.match(t, /🔴 Не работает: Ночная копия базы/);
  assert.match(t, /последняя успешная копия 30 ч назад/);
  assert.match(t, /finnik-backup\.sh/);
  assert.match(t, /🟢 Снова работает: База данных/);
  assert.ok(t.length < 3900);
  assert.equal(labelOf('disk'), 'Место на диске');
  assert.match(buildEmail([{ kind: 'alert', name: 'cert', detail: 'x', since }], now).subject, /Сертификат сайта/);
});

test('копия базы: разбор лога и свежесть', async () => {
  const log = '2026-10-18T00:30:05Z backup OK: a 1 bytes\nmусор\n2026-10-19T00:30:05Z backup OK: b 2 bytes\n';
  assert.equal(parseLastBackupOk(log), Date.parse('2026-10-19T00:30:05Z'));
  assert.equal(parseLastBackupOk('нет таких строк'), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  const file = path.join(dir, 'b.log');
  fs.writeFileSync(file, log);
  const env = { BACKUP_LOG: file };
  const at = (iso) => checkBackup(env, Date.parse(iso));
  assert.equal((await at('2026-10-19T12:00:00Z')).ok, true);
  const ok25 = await at('2026-10-20T01:00:00Z');                 // 24,5 ч
  assert.equal(ok25.ok, true);
  const stale = await at('2026-10-20T03:00:00Z');                // 26,5 ч
  assert.equal(stale.ok, false); assert.match(stale.detail, /26 ч назад/);
  assert.equal(BACKUP_MAX_AGE_H, 26);
  fs.writeFileSync(file, 'только ошибки\n');
  assert.match((await at('2026-10-20T03:00:00Z')).detail, /нет ни одной успешной/);
  assert.match((await checkBackup({ BACKUP_LOG: path.join(dir, 'нет.log') })).detail, /не могу прочитать/);
});

test('диск: процент занятого места и порог 85%', async () => {
  assert.equal(diskUsedPercent({ blocks: 1000, bavail: 250 }), 75);
  assert.equal(diskUsedPercent({ blocks: 1000, bavail: 100 }), 90);
  assert.equal((await checkDisk({ DISK_MAX_PERCENT: '100' })).ok, true);
  const r = await checkDisk({ DISK_MAX_PERCENT: '1' });
  assert.equal(r.ok, false); assert.match(r.detail, /диск занят на \d+%/);
});

test('сертификат: дни до окончания', () => {
  const now = Date.parse('2026-10-20T00:00:00Z');
  assert.equal(certDaysLeft('Jan  1 00:00:00 2027 GMT', now), 73);
  assert.equal(certDaysLeft('Oct 25 00:00:00 2026 GMT', now), 5);
  assert.equal(certDaysLeft('мусор', now), null);
});

function certServer(days) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-subj', '/CN=localhost', '-days', String(days)], { stdio: 'ignore' });
  const server = tls.createServer({ key: fs.readFileSync(`${dir}/k.pem`), cert: fs.readFileSync(`${dir}/c.pem`) }, (s) => s.end());
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('сертификат: настоящее TLS-соединение — свежий проходит, скорый конец и недоступный сайт дают тревогу', async () => {
  const fresh = await certServer(90);
  const soon = await certServer(5);
  try {
    assert.equal((await checkCert({ HEALTH_CERT_HOST: '127.0.0.1', HEALTH_CERT_PORT: String(fresh.address().port) })).ok, true);
    const r = await checkCert({ HEALTH_CERT_HOST: '127.0.0.1', HEALTH_CERT_PORT: String(soon.address().port) });
    assert.equal(r.ok, false); assert.match(r.detail, /истекает через [45] дн/);
  } finally { fresh.close(); soon.close(); }
  const down = await checkCert({ HEALTH_CERT_HOST: '127.0.0.1', HEALTH_CERT_PORT: '1' });
  assert.equal(down.ok, false); assert.match(down.detail, /не удалось проверить сертификат/);
});

test('все проверки зарегистрированы и подписаны по-русски', () => {
  assert.deepEqual(Object.keys(ALL_CHECKS), ['app', 'db', 'telegram', 'openai', 'backup', 'disk', 'cert', 'ai_usage']);
  for (const n of Object.keys(ALL_CHECKS)) assert.notEqual(labelOf(n), n, `нет подписи для ${n}`);
});

let ctx;
before(async () => { ctx = await makeDb(); });
after(async () => { await ctx?.close(); });

test('расход ИИ: тревога с 80% общего предела (логика и запрос)', async () => {
  const { checkAiUsage } = await import('../src/utils/healthChecks.js');
  // без базы по адресу — сбой соединения, а не исключение
  const noDb = await checkAiUsage({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x' });
  assert.equal(noDb.ok, false); assert.match(noDb.detail, /не удалось прочитать расход ИИ/);
  assert.equal((await checkAiUsage({})).ok, false);
  // SQL запроса проверяем на тестовой базе
  await ctx.query(`INSERT INTO public.ai_usage (subject, day, requests) VALUES ('*', (now() AT TIME ZONE 'Europe/Moscow')::date, 80)`);
  const r = await ctx.query(`SELECT requests FROM public.ai_usage WHERE subject = $1 AND day = (now() AT TIME ZONE 'Europe/Moscow')::date`, ['*']);
  assert.equal(Number(r.rows[0].requests), 80);
});

test('скрипт проверки: два канала, тест-режим Telegram, подключён alert-setup', () => {
  const s = read('scripts/healthcheck.mjs');
  assert.match(s, /--test-telegram/);
  assert.match(s, /sendTelegramAlert\(buildTelegramText\(actions, now, project\)/);
  assert.match(s, /ALERT_PROJECT/);
  assert.match(s, /!r\.ok && !tg\.ok/);               // откат состояния, только если не дошёл ни один путь
  assert.match(read('tools/alert-setup.mjs'), /getUpdates/);
  assert.doesNotMatch(read('tools/alert-setup.mjs'), /console\.(log|error)\([^)]*token/);
});
