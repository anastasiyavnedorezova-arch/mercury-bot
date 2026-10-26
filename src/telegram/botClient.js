// Собственный тонкий клиент Telegram Bot API вместо библиотеки node-telegram-bot-api (патч 48, 26.10.2026).
// Библиотека тянула устаревший пакет `request` с 8 уязвимостями, исправить которые без полной замены нельзя.
// Клиент повторяет то, чем бот реально пользуется: те же методы (sendMessage, answerCallbackQuery, sendChatAction,
// getFile, setMyCommands, setChatMenuButton, getMe), те же события (message, voice, photo, document, callback_query,
// polling_error) и onText, поэтому остальной код бота не меняется. Зависимостей нет: только встроенный fetch.
//
// Отличия от библиотеки (в лучшую сторону):
//  — запросы уходят JSON-ом, переданные параметры не изменяются (раньше sendMessage дописывал chat_id и text в общий объект опций);
//  — у каждого запроса есть таймаут (раньше мог висеть бесконечно);
//  — после ошибки опроса пауза растёт (1, 2, 4 … до 30 секунд), а не бьёт Telegram каждые 300 мс;
//  — ошибка в обработчике одного обновления не мешает обработать остальные в той же пачке;
//  — токен вырезается из текстов ошибок.
import { EventEmitter } from 'node:events';

const DEFAULT_API = 'https://api.telegram.org';

// Как у библиотеки: порядок важен, тип сообщения — первое совпавшее поле
export const MESSAGE_TYPES = [
  'text', 'animation', 'audio', 'channel_chat_created', 'contact', 'delete_chat_photo', 'dice', 'document', 'game',
  'group_chat_created', 'invoice', 'left_chat_member', 'location', 'migrate_from_chat_id', 'migrate_to_chat_id',
  'new_chat_members', 'new_chat_photo', 'new_chat_title', 'passport_data', 'photo', 'pinned_message', 'poll', 'sticker',
  'successful_payment', 'supergroup_chat_created', 'video', 'video_note', 'voice', 'video_chat_started', 'video_chat_ended',
  'video_chat_participants_invited', 'video_chat_scheduled', 'message_auto_delete_timer_changed', 'chat_invite_link',
  'chat_member_updated', 'web_app_data', 'message_reaction',
];

// Параметры, которые Telegram ждёт объектом. Если кто-то передал их JSON-строкой (так делала библиотека), разворачиваем.
const JSON_FIELDS = ['reply_markup', 'entities', 'caption_entities', 'reply_parameters', 'commands', 'scope', 'menu_button', 'allowed_updates', 'link_preview_options'];

export class TelegramError extends Error {
  constructor(message, response) {
    super(`ETELEGRAM: ${message}`);
    this.name = 'TelegramError';
    this.code = 'ETELEGRAM';
    this.response = response;
  }
}

export class FatalError extends Error {
  constructor(message, cause) {
    super(`EFATAL: ${message}`);
    this.name = 'FatalError';
    this.code = 'EFATAL';
    if (cause) this.cause = cause;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class TelegramBot extends EventEmitter {
  /**
   * @param {string} token
   * @param {{ baseApiUrl?: string, polling?: boolean | { interval?: number, params?: { timeout?: number } },
   *           fetchImpl?: typeof fetch, requestTimeoutMs?: number, maxBackoffMs?: number, retry429?: boolean }} [options]
   */
  constructor(token, options = {}) {
    super();
    this.token = token;
    this.options = options;
    this._base = String(options.baseApiUrl || DEFAULT_API).replace(/\/+$/, '');
    this._fetch = options.fetchImpl || ((...a) => fetch(...a));
    this._textCallbacks = [];
    this._polling = false;
    this._abort = null;
    this._offset = undefined;
    const p = typeof options.polling === 'object' && options.polling ? options.polling : {};
    this._pollInterval = Number.isFinite(p.interval) ? p.interval : 300;
    this._pollTimeout = Number.isFinite(p.params?.timeout) ? p.params.timeout : 10;
    this._maxBackoff = Number.isFinite(options.maxBackoffMs) ? options.maxBackoffMs : 30_000;
    if (options.polling) this.startPolling();
  }

  // ── Запросы к API ──────────────────────────────────────────────────────────

  _clean(text) {
    const t = String(text ?? '');
    return this.token ? t.split(String(this.token)).join('***') : t;
  }

  _prepare(params) {
    const out = {};
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined) continue;
      if (typeof v === 'string' && JSON_FIELDS.includes(k) && /^[[{]/.test(v.trim())) {
        try { out[k] = JSON.parse(v); continue; } catch { /* оставляем строкой */ }
      }
      out[k] = v;
    }
    return out;
  }

  async _request(method, params = {}, { timeoutMs, signal, retried = false } = {}) {
    if (!this.token) throw new FatalError('Telegram Bot Token not provided!');
    const url = `${this._base}/bot${this.token}/${method}`;
    const limit = timeoutMs ?? this.options.requestTimeoutMs ?? 30_000;
    const signals = [AbortSignal.timeout(limit)];
    if (signal) signals.push(signal);
    let res;
    let text;
    try {
      res = await this._fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this._prepare(params)),
        signal: AbortSignal.any(signals),
      });
      text = await res.text();
    } catch (err) {
      if (err?.name === 'TimeoutError') throw new FatalError(`нет ответа Telegram за ${Math.round(limit / 1000)} с (${method})`, err);
      if (err?.name === 'AbortError') throw err;
      throw new FatalError(this._clean(err?.cause?.code ? `${err.message} (${err.cause.code})` : err?.message), err);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const e = new FatalError(`Error parsing response: ${this._clean(text).slice(0, 200)}`);
      e.code = 'EPARSE';
      e.response = { statusCode: res.status, body: text };
      throw e;
    }
    if (data?.ok) return data.result;
    // Telegram просит подождать: один повтор, если ждать недолго
    const wait = data?.parameters?.retry_after;
    if (res.status === 429 && !retried && this.options.retry429 !== false && Number.isFinite(wait) && wait <= 10) {
      await sleep(wait * 1000 + 100);
      return this._request(method, params, { timeoutMs, signal, retried: true });
    }
    throw new TelegramError(`${data?.error_code ?? res.status} ${this._clean(data?.description ?? '')}`, { statusCode: res.status, body: data });
  }

  // ── Методы, которыми пользуется бот ────────────────────────────────────────

  getMe() { return this._request('getMe'); }
  getUpdates(params = {}, opts) { return this._request('getUpdates', params, opts); }
  sendMessage(chatId, text, form = {}) { return this._request('sendMessage', { ...form, chat_id: chatId, text }); }
  sendChatAction(chatId, action, form = {}) { return this._request('sendChatAction', { ...form, chat_id: chatId, action }); }
  getFile(fileId, form = {}) { return this._request('getFile', { ...form, file_id: fileId }); }
  setMyCommands(commands, form = {}) { return this._request('setMyCommands', { ...form, commands }); }
  setChatMenuButton(form = {}) { return this._request('setChatMenuButton', form); }
  deleteWebHook(form = {}) { return this._request('deleteWebhook', form); }
  answerCallbackQuery(callbackQueryId, form = {}) {
    return this._request('answerCallbackQuery', { ...form, callback_query_id: callbackQueryId });
  }

  // ── Входящие обновления ────────────────────────────────────────────────────

  // Как в библиотеке: подходящими считаются ВСЕ зарегистрированные выражения, не только первое
  onText(regexp, callback) {
    this._textCallbacks.push({ regexp, callback });
  }

  processUpdate(update) {
    const message = update.message;
    if (message) {
      const metadata = { type: MESSAGE_TYPES.find((t) => message[t]) };
      this.emit('message', message, metadata);
      if (metadata.type) this.emit(metadata.type, message, metadata);
      if (message.text) {
        for (const reg of this._textCallbacks) {
          const re = reg.regexp instanceof RegExp ? reg.regexp : new RegExp(reg.regexp);
          const result = re.exec(message.text);
          re.lastIndex = 0;
          if (result) reg.callback(message, result);
        }
      }
      return;
    }
    for (const [key, value] of Object.entries(update)) {
      if (key === 'update_id') continue;
      this.emit(key, value);
      if (key === 'edited_message' && value?.text) this.emit('edited_message_text', value);
      break;
    }
  }

  // ── Опрос Telegram (long polling) ──────────────────────────────────────────

  isPolling() { return this._polling; }

  startPolling() {
    if (this._polling) return Promise.resolve();
    this._polling = true;
    this._loop = this._pollLoop();
    return Promise.resolve();
  }

  async stopPolling() {
    this._polling = false;
    this._abort?.abort();
    await this._loop?.catch(() => {});
    this._loop = null;
  }

  async _fetchUpdates() {
    const params = { timeout: this._pollTimeout };
    if (this._offset !== undefined) params.offset = this._offset;
    try {
      return await this.getUpdates(params, { timeoutMs: (this._pollTimeout + 15) * 1000, signal: this._abort.signal });
    } catch (err) {
      // 409: на боте висит webhook, опросу он мешает — снимаем и пробуем снова (как делала библиотека)
      if (err?.response?.statusCode === 409 && /webhook/i.test(String(err.response?.body?.description ?? ''))) {
        await this.deleteWebHook();
        return this.getUpdates(params, { timeoutMs: (this._pollTimeout + 15) * 1000, signal: this._abort.signal });
      }
      throw err;
    }
  }

  async _pollLoop() {
    let failures = 0;
    while (this._polling) {
      this._abort = new AbortController();
      try {
        const updates = await this._fetchUpdates();
        failures = 0;
        for (const update of updates ?? []) {
          this._offset = update.update_id + 1;
          try {
            this.processUpdate(update);
          } catch (err) {
            this.emit('polling_error', err); // обработчик упал: остальные обновления пачки всё равно обрабатываем
          }
        }
      } catch (err) {
        if (!this._polling) break; // остановили сами
        this.emit('polling_error', err);
        failures += 1;
        await sleep(Math.min(this._maxBackoff, 1000 * 2 ** (failures - 1)));
        continue;
      }
      if (this._polling) await sleep(this._pollInterval);
    }
  }
}

export default TelegramBot;
