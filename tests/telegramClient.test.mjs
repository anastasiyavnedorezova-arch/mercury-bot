// Тесты собственного клиента Telegram (патч 48): вместо настоящего Telegram — поддельный сервер на localhost.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { TelegramBot, TelegramError, FatalError, MESSAGE_TYPES } from '../src/telegram/botClient.js';

const TOKEN = '123456:SECRET-TOKEN-abc';
let server;
let port;
let calls;      // все запросы: { method, path, body }
let scripted;   // method -> очередь ответов: { status, body, delayMs, hang }

function script(method, ...replies) { scripted[method] = [...(scripted[method] ?? []), ...replies]; }
const ok = (result) => ({ status: 200, body: { ok: true, result } });

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const m = req.url.match(/\/bot[^/]+\/(\w+)$/);
      const method = m?.[1];
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = { _raw: raw }; }
      calls.push({ method, path: req.url, body, contentType: req.headers['content-type'], httpMethod: req.method });
      const reply = scripted[method]?.shift();
      const send = () => {
        if (!reply) {
          // getUpdates без сценария ведёт себя как настоящий длинный опрос: ждёт и отвечает пустым списком
          if (method === 'getUpdates') return setTimeout(() => { if (!res.writableEnded) { res.writeHead(200); res.end(JSON.stringify({ ok: true, result: [] })); } }, 60);
          res.writeHead(200); return res.end(JSON.stringify({ ok: true, result: true }));
        }
        if (reply.hang) return; // не отвечаем вообще
        res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
      };
      if (reply?.delayMs) setTimeout(send, reply.delayMs); else send();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });

function reset() { calls = []; scripted = {}; }
const makeBot = (extra = {}) => new TelegramBot(TOKEN, { baseApiUrl: `http://127.0.0.1:${port}`, ...extra });
const waitFor = async (cond, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('ждали слишком долго');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('sendMessage: POST, JSON-тело, путь с токеном, возвращает result', async () => {
  reset();
  script('sendMessage', ok({ message_id: 77 }));
  const bot = makeBot();
  const res = await bot.sendMessage(555, 'Привет', { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'Да', callback_data: 'y' }]] } });
  assert.deepEqual(res, { message_id: 77 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].httpMethod, 'POST');
  assert.equal(calls[0].path, `/bot${TOKEN}/sendMessage`);
  assert.match(calls[0].contentType, /application\/json/);
  assert.deepEqual(calls[0].body, {
    parse_mode: 'HTML', chat_id: 555, text: 'Привет',
    reply_markup: { inline_keyboard: [[{ text: 'Да', callback_data: 'y' }]] },
  });
});

test('sendMessage не меняет переданные параметры (общие клавиатуры остаются чистыми)', async () => {
  reset();
  const shared = Object.freeze({ reply_markup: Object.freeze({ keyboard: [['a']] }) });
  const bot = makeBot();
  await bot.sendMessage(1, 'один', shared);
  await bot.sendMessage(2, 'два', shared);
  assert.deepEqual(Object.keys(shared), ['reply_markup']);
  assert.equal(calls[0].body.chat_id, 1);
  assert.equal(calls[1].body.chat_id, 2);
  assert.equal(calls[1].body.text, 'два');
});

test('sendMessage без параметров и с undefined в параметрах', async () => {
  reset();
  const bot = makeBot();
  await bot.sendMessage(1, 'x');
  await bot.sendMessage(1, 'y', { parse_mode: undefined });
  assert.deepEqual(calls[0].body, { chat_id: 1, text: 'x' });
  assert.deepEqual(calls[1].body, { chat_id: 1, text: 'y' });
});

test('reply_markup, переданный JSON-строкой, разворачивается в объект', async () => {
  reset();
  const bot = makeBot();
  await bot.sendMessage(1, 'x', { reply_markup: JSON.stringify({ remove_keyboard: true }) });
  assert.deepEqual(calls[0].body.reply_markup, { remove_keyboard: true });
});

test('адрес relay с префиксом /telegram сохраняется в пути', async () => {
  reset();
  const bot = new TelegramBot(TOKEN, { baseApiUrl: `http://127.0.0.1:${port}/telegram/` });
  await bot.getMe();
  assert.equal(calls[0].path, `/telegram/bot${TOKEN}/getMe`);
});

test('остальные методы шлют правильные поля', async () => {
  reset();
  script('getFile', ok({ file_id: 'F', file_path: 'voice/file_1.oga' }));
  const bot = makeBot();
  await bot.answerCallbackQuery('cb1');
  await bot.answerCallbackQuery('cb2', { text: 'ок', show_alert: true });
  await bot.sendChatAction(9, 'typing');
  const file = await bot.getFile('F');
  await bot.setMyCommands([{ command: 'start', description: 'Начать' }]);
  await bot.setChatMenuButton({ menu_button: { type: 'commands' } });
  assert.deepEqual(file, { file_id: 'F', file_path: 'voice/file_1.oga' });
  assert.deepEqual(calls.map((c) => c.method), ['answerCallbackQuery', 'answerCallbackQuery', 'sendChatAction', 'getFile', 'setMyCommands', 'setChatMenuButton']);
  assert.deepEqual(calls[0].body, { callback_query_id: 'cb1' });
  assert.deepEqual(calls[1].body, { text: 'ок', show_alert: true, callback_query_id: 'cb2' });
  assert.deepEqual(calls[2].body, { chat_id: 9, action: 'typing' });
  assert.deepEqual(calls[3].body, { file_id: 'F' });
  assert.deepEqual(calls[4].body, { commands: [{ command: 'start', description: 'Начать' }] });
  assert.deepEqual(calls[5].body, { menu_button: { type: 'commands' } });
});

test('ошибка Telegram: ETELEGRAM, код, текст и ответ — как у старой библиотеки', async () => {
  reset();
  script('sendMessage', { status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } });
  const bot = makeBot();
  await assert.rejects(bot.sendMessage(1, 'x'), (err) => {
    assert.ok(err instanceof TelegramError);
    assert.equal(err.code, 'ETELEGRAM');
    assert.equal(err.message, 'ETELEGRAM: 403 Forbidden: bot was blocked by the user');
    assert.equal(err.response.statusCode, 403);
    assert.equal(err.response.body.description, 'Forbidden: bot was blocked by the user');
    return true;
  });
});

test('"query is too old" остаётся в тексте ошибки (на этом строится фильтр unhandledRejection)', async () => {
  reset();
  script('answerCallbackQuery', { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: query is too old and response timeout expired or query ID is invalid' } });
  const bot = makeBot();
  await assert.rejects(bot.answerCallbackQuery('x'), (err) => err.message.includes('query is too old'));
});

test('сеть недоступна: EFATAL, токена в тексте нет', async () => {
  reset();
  const bot = new TelegramBot(TOKEN, { baseApiUrl: 'http://127.0.0.1:1' });
  await assert.rejects(bot.sendMessage(1, 'x'), (err) => {
    assert.ok(err instanceof FatalError);
    assert.equal(err.code, 'EFATAL');
    assert.match(err.message, /^EFATAL: /);
    assert.ok(!err.message.includes('SECRET-TOKEN'));
    return true;
  });
});

test('токен вырезается из описания ошибки Telegram', async () => {
  reset();
  script('sendMessage', { status: 401, body: { ok: false, error_code: 401, description: `Unauthorized ${TOKEN}` } });
  await assert.rejects(makeBot().sendMessage(1, 'x'), (err) => !err.message.includes('SECRET-TOKEN') && err.message.includes('Unauthorized'));
});

test('ответ не JSON: ошибка EPARSE', async () => {
  reset();
  script('getMe', { status: 502, body: '<html>Bad gateway</html>' });
  await assert.rejects(makeBot().getMe(), (err) => err.code === 'EPARSE' && err.response.statusCode === 502);
});

test('Telegram молчит: запрос обрывается по таймауту', async () => {
  reset();
  script('getMe', { hang: true });
  const bot = makeBot({ requestTimeoutMs: 150 });
  const t0 = Date.now();
  await assert.rejects(bot.getMe(), (err) => err.code === 'EFATAL' && /нет ответа/.test(err.message));
  assert.ok(Date.now() - t0 < 2000);
});

test('нет токена: понятная ошибка вместо запроса в никуда', async () => {
  reset();
  const bot = new TelegramBot('', { baseApiUrl: `http://127.0.0.1:${port}` });
  await assert.rejects(bot.getMe(), (err) => err.code === 'EFATAL' && /Token/.test(err.message));
  assert.equal(calls.length, 0);
});

test('429 с короткой паузой: один повтор и успех', async () => {
  reset();
  script('sendMessage',
    { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } } },
    ok({ message_id: 5 }));
  const t0 = Date.now();
  const res = await makeBot().sendMessage(1, 'x');
  assert.equal(res.message_id, 5);
  assert.equal(calls.length, 2);
  assert.ok(Date.now() - t0 >= 1000);
});

test('429 с длинной паузой или повторный 429: ошибка, без бесконечных повторов', async () => {
  reset();
  script('sendMessage', { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 60 } } });
  await assert.rejects(makeBot().sendMessage(1, 'x'), (err) => err.message.startsWith('ETELEGRAM: 429'));
  assert.equal(calls.length, 1);
  reset();
  const tooMany = { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1 } } };
  script('sendMessage', tooMany, tooMany);
  await assert.rejects(makeBot().sendMessage(1, 'x'), (err) => err.message.startsWith('ETELEGRAM: 429'));
  assert.equal(calls.length, 2);
});

// ── Обновления ─────────────────────────────────────────────────────────────

const upd = (id, extra) => ({ update_id: id, ...extra });
const textMsg = (text) => ({ message_id: 1, chat: { id: 7 }, from: { id: 7 }, text });

test('processUpdate: message, затем событие типа; onText вызывает ВСЕ подходящие выражения', () => {
  reset();
  const bot = makeBot();
  const log = [];
  bot.on('message', (m, meta) => log.push(['message', m.text, meta.type]));
  bot.on('text', (m) => log.push(['text', m.text]));
  bot.on('voice', (m) => log.push(['voice', m.voice.file_id]));
  bot.on('photo', (m) => log.push(['photo', m.photo.length]));
  bot.on('document', (m) => log.push(['document', m.document.file_id]));
  bot.on('callback_query', (q) => log.push(['callback_query', q.data]));
  bot.onText(/^\/start$/, (m, match) => log.push(['onText:start', match[0]]));
  bot.onText(/^\/st/, () => log.push(['onText:st']));
  bot.onText(/\/broadcast (.+)/s, (m, match) => log.push(['onText:broadcast', match[1]]));
  bot.onText(/^\/stats(?:@\w+)?(?:\s+\d{1,3})?\s*$/, (m, match) => log.push(['onText:stats', match[0]]));

  bot.processUpdate(upd(1, { message: textMsg('/start') }));
  bot.processUpdate(upd(2, { message: textMsg('/stats@FinnikBot 30') }));
  bot.processUpdate(upd(3, { message: textMsg('/broadcast строка 1\nстрока 2') }));
  bot.processUpdate(upd(4, { message: { ...textMsg(undefined), text: undefined, voice: { file_id: 'V1' } } }));
  bot.processUpdate(upd(5, { message: { ...textMsg(undefined), text: undefined, photo: [{ file_id: 'a' }, { file_id: 'b' }] } }));
  bot.processUpdate(upd(6, { message: { ...textMsg(undefined), text: undefined, document: { file_id: 'D1' } } }));
  bot.processUpdate(upd(7, { callback_query: { id: 'c', data: 'menu:main', from: { id: 7 } } }));

  assert.deepEqual(log, [
    ['message', '/start', 'text'], ['text', '/start'], ['onText:start', '/start'], ['onText:st'],
    ['message', '/stats@FinnikBot 30', 'text'], ['text', '/stats@FinnikBot 30'], ['onText:st'], ['onText:stats', '/stats@FinnikBot 30'],
    ['message', '/broadcast строка 1\nстрока 2', 'text'], ['text', '/broadcast строка 1\nстрока 2'], ['onText:broadcast', 'строка 1\nстрока 2'],
    ['message', undefined, 'voice'], ['voice', 'V1'],
    ['message', undefined, 'photo'], ['photo', 2],
    ['message', undefined, 'document'], ['document', 'D1'],
    ['callback_query', 'menu:main'],
  ]);
});

test('список типов сообщений начинается как у библиотеки, текст — первый', () => {
  assert.equal(MESSAGE_TYPES[0], 'text');
  for (const t of ['voice', 'photo', 'document']) assert.ok(MESSAGE_TYPES.includes(t));
});

test('onText с регулярным выражением /g не ломается на повторных сообщениях', () => {
  const bot = makeBot();
  let n = 0;
  bot.onText(/abc/g, () => { n += 1; });
  bot.processUpdate(upd(1, { message: textMsg('abc') }));
  bot.processUpdate(upd(2, { message: textMsg('abc') }));
  assert.equal(n, 2);
});

test('опрос: получает обновления, двигает offset, доставляет события по порядку', async () => {
  reset();
  script('getUpdates',
    ok([upd(100, { message: textMsg('привет') }), upd(101, { callback_query: { id: 'c1', data: 'x', from: { id: 7 } } })]),
    ok([upd(102, { message: textMsg('пока') })]));
  const bot = makeBot();
  const got = [];
  bot.on('message', (m) => got.push(m.text));
  bot.on('callback_query', (q) => got.push('cb:' + q.data));
  bot.startPolling({});
  await waitFor(() => got.length === 3 && calls.filter((c) => c.method === 'getUpdates').length >= 3);
  await bot.stopPolling();
  assert.deepEqual(got, ['привет', 'cb:x', 'пока']);
  const polls = calls.filter((c) => c.method === 'getUpdates');
  assert.equal(polls[0].body.offset, undefined);
  assert.equal(polls[1].body.offset, 102);
  assert.equal(polls[2].body.offset, 103);
  assert.equal(polls[0].body.timeout, 10);
  assert.equal(bot.isPolling(), false);
});

test('polling: true в конструкторе сразу запускает опрос; свои interval и timeout учитываются', async () => {
  reset();
  const bot = makeBot({ polling: { interval: 5, params: { timeout: 1 } } });
  await waitFor(() => calls.some((c) => c.method === 'getUpdates'));
  assert.equal(bot.isPolling(), true);
  assert.equal(calls.find((c) => c.method === 'getUpdates').body.timeout, 1);
  await bot.stopPolling();
});

test('ошибка в обработчике одного сообщения не мешает остальным из той же пачки', async () => {
  reset();
  script('getUpdates', ok([upd(1, { message: textMsg('плохое') }), upd(2, { message: textMsg('хорошее') })]));
  const bot = makeBot({ polling: { interval: 5, params: { timeout: 1 } } });
  const seen = [];
  const errors = [];
  bot.on('message', (m) => { if (m.text === 'плохое') throw new Error('бум'); seen.push(m.text); });
  bot.on('polling_error', (e) => errors.push(e.message));
  await waitFor(() => seen.length === 1);
  await bot.stopPolling();
  assert.deepEqual(seen, ['хорошее']);
  assert.deepEqual(errors, ['бум']);
});

test('сбой сети при опросе: polling_error, пауза и продолжение без падения', async () => {
  reset();
  script('getUpdates',
    { status: 502, body: 'bad gateway' },
    ok([upd(5, { message: textMsg('после сбоя') })]));
  const bot = makeBot({ polling: { interval: 5, params: { timeout: 1 } }, maxBackoffMs: 30 });
  const errors = [];
  const seen = [];
  bot.on('polling_error', (e) => errors.push(e.code));
  bot.on('message', (m) => seen.push(m.text));
  await waitFor(() => seen.length === 1);
  await bot.stopPolling();
  assert.deepEqual(errors, ['EPARSE']);
  assert.deepEqual(seen, ['после сбоя']);
});

test('409 «активен webhook»: webhook снимается и опрос продолжается', async () => {
  reset();
  script('getUpdates',
    { status: 409, body: { ok: false, error_code: 409, description: 'Conflict: can\'t use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first' } },
    ok([upd(9, { message: textMsg('живой') })]));
  const bot = makeBot({ polling: { interval: 5, params: { timeout: 1 } } });
  const seen = [];
  bot.on('message', (m) => seen.push(m.text));
  await waitFor(() => seen.length === 1);
  await bot.stopPolling();
  const order = calls.map((c) => c.method).slice(0, 3);
  assert.deepEqual(order, ['getUpdates', 'deleteWebhook', 'getUpdates']);
});

test('stopPolling быстро прерывает ожидающий длинный запрос', async () => {
  reset();
  script('getUpdates', { hang: true });
  const bot = makeBot({ polling: { interval: 5, params: { timeout: 30 } } });
  await waitFor(() => calls.some((c) => c.method === 'getUpdates'));
  const t0 = Date.now();
  await bot.stopPolling();
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(bot.isPolling(), false);
});
