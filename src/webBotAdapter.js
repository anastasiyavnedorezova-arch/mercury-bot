import { EventEmitter } from 'events';

// Очередь сообщений для каждого веб-чата (по chatId = external_id пользователя)
const webChatQueues = new Map(); // chatId -> [{text, opts, timestamp}]
const webChatEmitters = new Map(); // chatId -> EventEmitter

function getEmitter(chatId) {
  if (!webChatEmitters.has(chatId)) {
    webChatEmitters.set(chatId, new EventEmitter());
  }
  return webChatEmitters.get(chatId);
}

export function getWebChatQueue(chatId) {
  if (!webChatQueues.has(chatId)) {
    webChatQueues.set(chatId, []);
  }
  return webChatQueues.get(chatId);
}

export function clearWebChatQueue(chatId) {
  webChatQueues.set(chatId, []);
}

// Адаптер, имитирующий интерфейс node-telegram-bot-api для веб-канала
export function createWebBotAdapter() {
  return {
    sendMessage: async (chatId, text, opts = {}) => {
      const queue = getWebChatQueue(chatId);
      queue.push({ type: 'message', text, opts, timestamp: Date.now() });
      getEmitter(chatId).emit('new_message');
      return { message_id: Date.now(), chat: { id: chatId }, text };
    },
    editMessageText: async (text, opts = {}) => {
      const chatId = opts.chat_id;
      const queue = getWebChatQueue(chatId);
      queue.push({ type: 'edit', text, opts, timestamp: Date.now() });
      getEmitter(chatId).emit('new_message');
      return true;
    },
    answerCallbackQuery: async () => true,
    sendChatAction: async () => true,
  };
}

export function waitForNewMessage(chatId, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const emitter = getEmitter(chatId);
    const timer = setTimeout(() => {
      emitter.removeListener('new_message', onMsg);
      resolve(false);
    }, timeoutMs);
    function onMsg() {
      clearTimeout(timer);
      resolve(true);
    }
    emitter.once('new_message', onMsg);
  });
}
