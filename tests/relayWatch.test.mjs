// Внешний сторож на ретрансляторе (deploy/relay/finnik-watch.sh): тревога после двух сбоев подряд, без повторов, сообщение о восстановлении.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const SCRIPT = new URL('../deploy/relay/finnik-watch.sh', import.meta.url).pathname;
const TOKEN = '999:SECRET-watch-token';

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function setup() {
  const state = { siteStatus: 200, tgStatus: 200, messages: [] };
  const site = await listen((req, res) => { res.statusCode = state.siteStatus; res.end('x'); });
  const tg = await listen((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      if (state.tgStatus === 200) state.messages.push({ url: req.url, body: decodeURIComponent(b.replace(/\+/g, ' ')) });
      res.statusCode = state.tgStatus; res.end('{}');
    });
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
  const env = {
    ...process.env, WATCH_ENV_FILE: '/nonexistent', ALERT_BOT_TOKEN: TOKEN, ALERT_CHAT_ID: '42',
    WATCH_URL: `http://127.0.0.1:${site.address().port}/`, TG_API: `http://127.0.0.1:${tg.address().port}`, STATE_DIRECTORY: dir,
  };
  const run = (args = []) => new Promise((resolve) => {
    const p = spawn('bash', [SCRIPT, ...args], { env });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
  return { state, run, close: () => { site.close(); tg.close(); } };
}

test('сторож: один сбой молчит, второй подряд — тревога, дальше без повторов, потом сообщение о восстановлении', async () => {
  const w = await setup();
  try {
    await w.run(); assert.equal(w.state.messages.length, 0, 'сайт жив — тишина');
    w.state.siteStatus = 500;
    let r = await w.run(); assert.equal(w.state.messages.length, 0, 'первый сбой — тишина'); assert.match(r.out, /сбой 1 подряд/);
    r = await w.run(); assert.equal(w.state.messages.length, 1, 'второй сбой подряд — тревога');
    const m = w.state.messages[0];
    assert.equal(m.url, `/bot${TOKEN}/sendMessage`);
    assert.match(m.body, /chat_id=42/);
    assert.match(m.body, /Проект: Финник/);
    assert.match(m.body, /🔴 Сайт не отвечает снаружи/);
    assert.match(m.body, /код 500/);
    await w.run(); await w.run(); assert.equal(w.state.messages.length, 1, 'пока проблема держится — без повторов');
    w.state.siteStatus = 200;
    await w.run(); assert.equal(w.state.messages.length, 2);
    assert.match(w.state.messages[1].body, /🟢 Сайт снова отвечает/);
    await w.run(); assert.equal(w.state.messages.length, 2, 'после восстановления — тишина');
    assert.doesNotMatch(r.out, /SECRET/);
  } finally { w.close(); }
});

test('сторож: если Telegram не принял тревогу, она не считается отправленной и уходит в следующий раз', async () => {
  const w = await setup();
  try {
    w.state.siteStatus = 503; w.state.tgStatus = 500;
    await w.run(); const r = await w.run();
    assert.match(r.out, /Telegram не принял/);
    assert.equal(w.state.messages.length, 0);
    w.state.tgStatus = 200;
    await w.run(); assert.equal(w.state.messages.length, 1, 'повторная попытка дошла');
  } finally { w.close(); }
});

test('сторож: недоступный сайт (нет соединения) тоже считается сбоем; --test шлёт пробное сообщение; без настроек — понятная ошибка', async () => {
  const w = await setup();
  try {
    const down = await listen((q, s) => s.end()); const port = down.address().port; down.close();
    const env2 = { WATCH_URL: `http://127.0.0.1:${port}/` };
    // тот же скрипт с другим адресом сайта
    const run2 = () => new Promise((resolve) => {
      const p = spawn('bash', [SCRIPT], { env: { ...process.env, ...env2, WATCH_ENV_FILE: '/nonexistent', ALERT_BOT_TOKEN: TOKEN, ALERT_CHAT_ID: '42', TG_API: `http://127.0.0.1:${w.state.port ?? 1}`, STATE_DIRECTORY: fs.mkdtempSync(path.join(os.tmpdir(), 'w2-')) } });
      let out = ''; p.stdout.on('data', (d) => { out += d; }); p.on('close', () => resolve(out));
    });
    assert.match(await run2(), /сбой 1 подряд \(код 000\)/);
    const t = await w.run(['--test']);
    assert.equal(t.code, 0); assert.match(w.state.messages.at(-1).body, /Внешний сторож работает/);
  } finally { w.close(); }
  const none = await new Promise((resolve) => {
    const p = spawn('bash', [SCRIPT, '--test'], { env: { ...process.env, WATCH_ENV_FILE: '/nonexistent', ALERT_BOT_TOKEN: '', ALERT_CHAT_ID: '' } });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.on('close', (code) => resolve({ code, out }));
  });
  assert.equal(none.code, 1); assert.match(none.out, /не заданы ALERT_BOT_TOKEN/);
});

test('файлы для ретранслятора лежат в репозитории: сторож, таймер, копия настроек nginx и инструкция', () => {
  const dir = new URL('../deploy/relay/', import.meta.url);
  for (const f of ['finnik-watch.sh', 'finnik-watch.service', 'finnik-watch.timer', 'nginx-relay.conf', 'README.md']) assert.ok(fs.existsSync(new URL(f, dir)), f);
  const nginx = fs.readFileSync(new URL('nginx-relay.conf', dir), 'utf8');
  assert.match(nginx, /allow 129\.101\.119\.154;/); assert.match(nginx, /deny all;/);
  assert.doesNotMatch(nginx, /sk-|Bearer|bot\d+:/);       // секретов в копии нет
  assert.match(fs.readFileSync(new URL('README.md', dir), 'utf8'), /Быстрое восстановление/);
});
