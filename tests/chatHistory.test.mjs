// Чат с ботом сохраняется между страницами кабинета до выхода из аккаунта.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createChatHistory, userIdFromToken, compactKeyboard, CHAT_HISTORY_KEY, CHAT_HISTORY_MAX,
} from '../public/cabinet/chat-history.js';

function memStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    _m: m,
  };
}
function jwt(payload) {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`;
}

test('userIdFromToken: берёт userId из JWT, мусор даёт null', () => {
  assert.equal(userIdFromToken(jwt({ userId: 'u-1' })), 'u-1');
  assert.equal(userIdFromToken(jwt({ sub: 42 })), '42');
  assert.equal(userIdFromToken(jwt({ foo: 1 })), null);
  assert.equal(userIdFromToken('не-токен'), null);
  assert.equal(userIdFromToken(null), null);
});

test('compactKeyboard оставляет текст и callback_data, пустое выбрасывает', () => {
  assert.deepEqual(compactKeyboard([[{ text: 'A', callback_data: 'a' }, { text: '' }], []]), [[['A', 'a']]]);
  assert.deepEqual(compactKeyboard(undefined), []);
  // повторное сжатие уже сжатой клавиатуры ничего не теряет
  const once = compactKeyboard([[{ text: 'A', callback_data: 'a' }, { text: 'B', callback_data: 'b' }]]);
  assert.deepEqual(compactKeyboard(once), once);
  assert.deepEqual(compactKeyboard([[{ text: 'Ссылка' }]]), [['Ссылка', '']].map(r => [r]));
});

test('история сохраняется и читается в порядке сообщений, кнопки сохраняются', () => {
  const storage = memStorage();
  const h = createChatHistory({ storage, getUserId: () => 'u-1' });
  assert.deepEqual(h.load(), []);
  h.addBot('Привет!', [[{ text: 'Меню', callback_data: 'menu:main' }]]);
  h.addUser('500 кофе');
  h.addBot('Записал', undefined);
  // «другая страница» — новый экземпляр на том же хранилище
  const h2 = createChatHistory({ storage, getUserId: () => 'u-1' });
  assert.deepEqual(h2.load(), [
    { r: 'b', t: 'Привет!', k: [[['Меню', 'menu:main']]] },
    { r: 'u', t: '500 кофе' },
    { r: 'b', t: 'Записал' },
  ]);
});

test('другой пользователь не видит чужую историю и затирает её своей', () => {
  const storage = memStorage();
  createChatHistory({ storage, getUserId: () => 'u-1' }).addUser('секрет первого');
  const h2 = createChatHistory({ storage, getUserId: () => 'u-2' });
  assert.deepEqual(h2.load(), []);
  h2.addUser('мой текст');
  assert.deepEqual(createChatHistory({ storage, getUserId: () => 'u-2' }).load(), [{ r: 'u', t: 'мой текст' }]);
  assert.deepEqual(createChatHistory({ storage, getUserId: () => 'u-1' }).load(), []);
});

test('clear() и выход из аккаунта удаляют чат', () => {
  const storage = memStorage();
  const h = createChatHistory({ storage, getUserId: () => 'u-1' });
  h.addUser('привет');
  assert.ok(storage.getItem(CHAT_HISTORY_KEY));
  h.clear();
  assert.equal(storage.getItem(CHAT_HISTORY_KEY), null);
  assert.deepEqual(h.load(), []);
});

test('хранится не больше max последних записей', () => {
  const storage = memStorage();
  const h = createChatHistory({ storage, getUserId: () => 'u-1' });
  for (let i = 0; i < CHAT_HISTORY_MAX + 20; i++) h.addUser('m' + i);
  const items = h.load();
  assert.equal(items.length, CHAT_HISTORY_MAX);
  assert.equal(items[0].t, 'm20');
  assert.equal(items.at(-1).t, 'm' + (CHAT_HISTORY_MAX + 19));
});

test('без userId или без хранилища — тихо ничего не сохраняет, не падает', () => {
  const storage = memStorage();
  const noUser = createChatHistory({ storage, getUserId: () => null });
  noUser.addUser('x');
  assert.equal(storage._m.size, 0);
  assert.deepEqual(noUser.load(), []);
  const noStore = createChatHistory({ storage: null, getUserId: () => 'u-1' });
  noStore.addUser('x');
  assert.deepEqual(noStore.load(), []);
  const broken = createChatHistory({
    storage: { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => {} },
    getUserId: () => 'u-1',
  });
  broken.addUser('x');
  assert.deepEqual(broken.load(), []);
});

test('испорченный JSON в хранилище не ломает чат', () => {
  const storage = memStorage();
  storage.setItem(CHAT_HISTORY_KEY, '{не json');
  const h = createChatHistory({ storage, getUserId: () => 'u-1' });
  assert.deepEqual(h.load(), []);
  h.addUser('ok');
  assert.deepEqual(h.load(), [{ r: 'u', t: 'ok' }]);
});

test('подключено: виджет и страница чата используют историю, выход очищает её', () => {
  const widget = fs.readFileSync('public/cabinet/bot-widget.js', 'utf8');
  const bot = fs.readFileSync('public/cabinet/bot.html', 'utf8');
  const layout = fs.readFileSync('public/cabinet/layout.js', 'utf8');
  for (const src of [widget, bot]) {
    assert.match(src, /from '\.\/chat-history\.js'/);
    assert.match(src, /restoreHistory\(\)/);
    assert.match(src, /history\.addUser\(/);
    assert.match(src, /history\.addBot\(/);
  }
  assert.match(layout, /clearChatHistory\(\);/);
  assert.match(fs.readFileSync('public/cabinet/profile.html', 'utf8'), /removeItem\('finnik_chat_v1'\)/);
  assert.match(fs.readFileSync('public/cabinet/login.html', 'utf8'), /removeItem\('finnik_chat_v1'\)/);
  // ключ в браузере и в модуле совпадают
  assert.equal(CHAT_HISTORY_KEY, 'finnik_chat_v1');
});
