// ── История чата с ботом в браузере ──────────────────────────────────────────
// Чат хранится в localStorage и привязан к пользователю (userId из токена), поэтому
// переход между страницами кабинета не сбрасывает переписку. Очищается при выходе
// из аккаунта (clearChatHistory) и сам сбрасывается, если зашёл другой пользователь.
//
// Формат записи: { r: 'b' | 'u', t: 'текст', k?: [[ ['Кнопка', 'callback_data'], … ], … ] }

export const CHAT_HISTORY_KEY = 'finnik_chat_v1';
export const CHAT_HISTORY_MAX = 150;
const MAX_TEXT = 4000;

// userId из JWT (payload.userId). Токен в localStorage бывает строкой или JSON { access_token }.
export function userIdFromToken(token) {
  try {
    if (!token) return null;
    const part = String(token).split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(b64).split('').map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    );
    const p = JSON.parse(json);
    const id = p.userId ?? p.sub ?? null;
    return id == null ? null : String(id);
  } catch {
    return null;
  }
}

// Из inline_keyboard бота оставляем только текст и callback_data.
// Принимает и формат бота ({ text, callback_data }), и уже сжатый ([текст, callback_data]) —
// повторный вызов ничего не теряет.
export function compactKeyboard(inlineKeyboard) {
  if (!Array.isArray(inlineKeyboard)) return [];
  return inlineKeyboard
    .map(row => (Array.isArray(row) ? row : [])
      .map(b => (Array.isArray(b)
        ? [b[0], b[1]]
        : (b ? [b.text, b.callback_data] : [])))
      .filter(([label]) => label)
      .map(([label, data]) => [String(label), String(data || '')]))
    .filter(row => row.length > 0);
}

export function createChatHistory({ storage, getUserId, key = CHAT_HISTORY_KEY, max = CHAT_HISTORY_MAX } = {}) {
  function read() {
    try {
      const uid = getUserId();
      if (!uid || !storage) return null;
      const raw = storage.getItem(key);
      if (!raw) return { uid, items: [] };
      let data = null;
      try { data = JSON.parse(raw); } catch { /* испорченная запись — начинаем чат заново */ }
      // Чужая история (другой аккаунт на этом браузере) — выбрасываем
      if (!data || data.uid !== uid || !Array.isArray(data.items)) return { uid, items: [] };
      return { uid, items: data.items };
    } catch {
      return null;
    }
  }

  function write(state) {
    try {
      const items = state.items.slice(-max);
      storage.setItem(key, JSON.stringify({ uid: state.uid, items }));
    } catch { /* хранилище недоступно или переполнено — чат работает без истории */ }
  }

  function add(item) {
    const state = read();
    if (!state) return;
    state.items.push(item);
    write(state);
  }

  return {
    load() {
      const state = read();
      return state ? state.items : [];
    },
    addBot(text, keyboard) {
      const item = { r: 'b', t: String(text || '').slice(0, MAX_TEXT) };
      const k = compactKeyboard(keyboard);
      if (k.length) item.k = k;
      add(item);
    },
    addUser(text) {
      add({ r: 'u', t: String(text || '').slice(0, MAX_TEXT) });
    },
    clear() {
      try { storage && storage.removeItem(key); } catch { /* ignore */ }
    },
  };
}

// Очистка при выходе из аккаунта — вызывается там, где удаляется токен
export function clearChatHistory() {
  try { localStorage.removeItem(CHAT_HISTORY_KEY); } catch { /* ignore */ }
}
