// Дневной лимит запросов к ИИ (OpenAI): на человека и общий предохранитель на всех.
// Сутки считаются по Москве. Счётчики лежат в базе (таблица ai_usage), поэтому перезапуск бота их не обнуляет.
// «Вес» запроса: обычная запись и вопрос — 1, голосовое — 2 (распознавание + разбор), выписка по фото — 5 (дорогая модель).
// Лимит резервируется одной транзакцией: либо оба счётчика (человек и общий) выросли, либо ни один.
// Если база недоступна, пользователя не блокируем (бот и так не сохранит запись без базы), а пишем ошибку в лог.
//   AI_DAILY_LIMIT=50          запросов (весов) на человека в сутки
//   AI_GLOBAL_DAILY_LIMIT=3000 всего в сутки на всех
//   AI_LIMITS=off              выключить проверку (аварийный рычаг)

export const AI_WEIGHTS = { text: 1, faq: 1, correction: 1, voice: 2, statement: 5 };
export const GLOBAL_SUBJECT = '*';

const UPSERT = `
INSERT INTO public.ai_usage (subject, day, requests)
SELECT $1::text, (now() AT TIME ZONE 'Europe/Moscow')::date, $2::int WHERE $2::int <= $3::int
ON CONFLICT (subject, day) DO UPDATE
  SET requests = public.ai_usage.requests + EXCLUDED.requests, updated_at = now()
  WHERE public.ai_usage.requests + EXCLUDED.requests <= $3::int
RETURNING requests`;

function envInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function aiLimitsConfig(env = process.env) {
  return {
    off: String(env.AI_LIMITS || '').toLowerCase() === 'off',
    perUser: envInt(env.AI_DAILY_LIMIT, 50),
    global: envInt(env.AI_GLOBAL_DAILY_LIMIT, 3000),
  };
}

class Blocked extends Error {}

// → { ok: true, used } | { ok: false, reason: 'user' | 'global', limit }
export async function reserveAi(db, subject, kind = 'text', { env = process.env, logger = console } = {}) {
  const cfg = aiLimitsConfig(env);
  if (cfg.off) return { ok: true, skipped: true };
  const weight = AI_WEIGHTS[kind] ?? 1;
  const key = String(subject ?? 'unknown');
  let blocked = null;
  let used = null;
  try {
    await db.transaction(async (tx) => {
      const u = await tx.query(UPSERT, [key, weight, cfg.perUser]);
      if (!u.rows.length) { blocked = { reason: 'user', limit: cfg.perUser }; throw new Blocked(); }
      const g = await tx.query(UPSERT, [GLOBAL_SUBJECT, weight, cfg.global]);
      if (!g.rows.length) { blocked = { reason: 'global', limit: cfg.global }; throw new Blocked(); }
      used = u.rows[0].requests;
    });
  } catch (err) {
    if (err instanceof Blocked && blocked) {
      logger.warn(`[ai-limit] ${blocked.reason === 'user' ? `человек …${key.slice(-4)}` : 'ОБЩИЙ ПРЕДЕЛ'} достиг ${blocked.limit} в сутки (${kind})`);
      return { ok: false, ...blocked };
    }
    logger.error('[ai-limit] не удалось проверить лимит, пропускаю:', err.message);
    return { ok: true, failOpen: true };
  }
  return { ok: true, used };
}

export function aiLimitText(gate) {
  if (gate?.reason === 'global') {
    return 'Сейчас у меня очень много запросов, я немного перегружен 😔 Попробуй, пожалуйста, через пару часов. Записать трату без ИИ можно кнопкой «✏️ Добавить запись вручную» в главном меню.';
  }
  return `На сегодня лимит запросов ко мне исчерпан (${gate?.limit ?? 50} в сутки) 🙏 Он обновится в полночь по Москве. А пока можно записать трату без ИИ: кнопка «✏️ Добавить запись вручную» в главном меню.`;
}

const MANUAL_KEYBOARD = {
  reply_markup: { inline_keyboard: [[{ text: '✏️ Добавить запись вручную', callback_data: 'manual:start' }]] },
};

// Единый ответ, когда лимит исчерпан
export async function denyAi(bot, chatId, gate) {
  await bot.sendMessage(chatId, aiLimitText(gate), MANUAL_KEYBOARD);
}
