// Единый аккаунт: подключение Telegram к аккаунту с сайта и отключение.
// Подключение идёт по одноразовой ссылке на бота: профиль на сайте создаёт ссылку, человек нажимает «Старт»
// и подтверждает. Если у этого Telegram в боте уже есть свой аккаунт с данными, всё переносится в аккаунт с сайта.
// Весь перенос выполняется в одной транзакции: либо всё, либо ничего.
import crypto from 'node:crypto';
import { maskEmail } from '../utils/email.js';
import { baseUrl } from '../emails/config.js';

export const LINK_TTL_MS = 15 * 60 * 1000;
export const TOKEN_RE = /^link_[A-Za-z0-9_-]{16,59}$/;

const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const inactive = (status) => ['deleted', 'merged'].includes(status ?? 'active');
const fail = (reason) => ({ ok: false, reason });

/** Имя бота для ссылки: на stage — тестовый бот, на проде — боевой. Можно задать переменной TELEGRAM_BOT_USERNAME. */
export function botUsername() {
  if (process.env.TELEGRAM_BOT_USERNAME) return process.env.TELEGRAM_BOT_USERNAME.replace(/^@/, '');
  return /^https?:\/\/stage\./.test(baseUrl()) ? 'FinnikTestBot' : 'FinnikMoneyBot';
}
export const botLinkUrl = (token) => `https://t.me/${botUsername()}?start=${token}`;

/** Создаёт ссылку для подключения. Прежние неиспользованные ссылки этого человека перестают работать. */
export async function createLinkToken(db, userId, { now = new Date() } = {}) {
  const { data: user, error } = await db.from('users').select('id, channel, status').eq('id', userId).maybeSingle();
  if (error) return fail('db');
  if (!user || inactive(user.status)) return fail('no_user');
  if (user.channel === 'telegram') return fail('already_connected');

  await db.from('telegram_link_tokens').delete().eq('user_id', userId).is('used_at', null);
  const token = `link_${crypto.randomBytes(24).toString('base64url')}`;
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS);
  const ins = await db.from('telegram_link_tokens').insert({ user_id: userId, token_hash: hash(token), expires_at: expiresAt.toISOString() });
  if (ins.error) return fail('db');
  return { ok: true, token, expiresAt };
}

/** Смотрит ссылку, ничего не меняя: чей аккаунт, и есть ли у этого Telegram свои данные в боте. */
export async function peekLinkToken(db, token, { telegramId = null, now = new Date() } = {}) {
  if (!TOKEN_RE.test(String(token ?? ''))) return fail('invalid');
  const { data: row, error } = await db.from('telegram_link_tokens').select('id, user_id, expires_at, used_at').eq('token_hash', hash(token)).maybeSingle();
  if (error) return fail('db');
  if (!row) return fail('invalid');
  if (row.used_at) return fail('used');
  if (new Date(row.expires_at) <= now) return fail('expired');
  const { data: user } = await db.from('users').select('id, email, status, channel, external_id').eq('id', row.user_id).maybeSingle();
  if (!user || inactive(user.status)) return fail('no_user');

  let ownRecords = 0;
  if (telegramId !== null) {
    const { data: own } = await db.from('users').select('id, status').eq('external_id', String(telegramId)).eq('channel', 'telegram').maybeSingle();
    if (own && own.id !== user.id && !inactive(own.status)) {
      const { count } = await db.from('transactions').select('id', { count: 'exact', head: true }).eq('user_id', own.id);
      ownRecords = count ?? 0;
    }
  }
  return { ok: true, user, maskedEmail: maskEmail(user.email), ownRecords };
}

// Переносит данные аккаунта Telegram (Y) в аккаунт с сайта (X). Вызывается только внутри транзакции.
async function moveData(q, Y, X, now) {
  const nowIso = now.toISOString();
  const count = async (text, params) => (await q(`WITH m AS (${text} RETURNING 1) SELECT count(*)::int AS n FROM m`, params))[0].n;
  const paidEnd = async (id) => (await q("SELECT max(ends_at) AS e FROM public.subscriptions WHERE user_id = $1 AND status = 'active' AND ends_at > $2", [id, nowIso]))[0]?.e ?? null;

  const endX = await paidEnd(X);
  const endY = await paidEnd(Y);
  const moved = {};

  // Свои категории: одноимённые у X уже есть — записи переключаем на них, дубль удаляем; остальные переносим
  await q(
    `UPDATE public.transactions t SET category_id = x.id
       FROM public.categories y JOIN public.categories x ON x.user_id = $2 AND x.is_active AND x.type = y.type AND lower(x.name) = lower(y.name)
      WHERE t.category_id = y.id AND y.user_id = $1`,
    [Y, X]
  );
  await q(
    `DELETE FROM public.categories y WHERE y.user_id = $1
        AND EXISTS (SELECT 1 FROM public.categories x WHERE x.user_id = $2 AND x.is_active AND x.type = y.type AND lower(x.name) = lower(y.name))`,
    [Y, X]
  );
  moved.categories = await count('UPDATE public.categories SET user_id = $2 WHERE user_id = $1', [Y, X]);
  moved.transactions = await count('UPDATE public.transactions SET user_id = $2 WHERE user_id = $1', [Y, X]);
  moved.goals = await count('UPDATE public.goals SET user_id = $2 WHERE user_id = $1', [Y, X]);
  // Бюджет: на один месяц один бюджет. Если на месяц он уже есть у аккаунта с сайта, остаётся он
  await q('DELETE FROM public.budget b WHERE b.user_id = $1 AND EXISTS (SELECT 1 FROM public.budget x WHERE x.user_id = $2 AND x.month = b.month)', [Y, X]);
  moved.budget = await count('UPDATE public.budget SET user_id = $2 WHERE user_id = $1', [Y, X]);
  moved.subscriptions = await count('UPDATE public.subscriptions SET user_id = $2 WHERE user_id = $1', [Y, X]);
  await q('UPDATE public.notifications SET user_id = $2 WHERE user_id = $1', [Y, X]);
  await q('UPDATE public.feedback SET user_id = $2 WHERE user_id = $1', [Y, X]);
  await q('UPDATE public.promo_redemptions SET user_id = $2 WHERE user_id = $1', [Y, X]);

  // Оплаченные периоды складываются: период, который кончается раньше, добавляется к тому, что кончается позже
  if (endX && endY) {
    const a = new Date(endX).getTime();
    const b = new Date(endY).getTime();
    const later = Math.max(a, b);
    const extend = Math.min(a, b) - now.getTime();
    if (extend > 0) {
      await q(
        `UPDATE public.subscriptions SET ends_at = ends_at + ($3::bigint * interval '1 millisecond')
          WHERE id = (SELECT id FROM public.subscriptions WHERE user_id = $1 AND status = 'active' AND ends_at = $2 ORDER BY created_at DESC LIMIT 1)`,
        [X, new Date(later).toISOString(), String(extend)]
      );
    }
  }
  return moved;
}

/**
 * Подключает Telegram к аккаунту, чья ссылка. telegramId — тот, кто нажал «Подключить» в боте.
 * @returns {Promise<{ ok: true, merged: boolean, moved?: object, already?: boolean, userId: string } | { ok: false, reason: string }>}
 *  reason: invalid | used | expired | no_user | other_connected | telegram_has_login | bad_telegram_id | db
 */
export async function linkTelegram(db, { token, telegramId, tgUsername = null, now = new Date() }) {
  const T = String(telegramId ?? '');
  if (!/^\d{1,20}$/.test(T)) return fail('bad_telegram_id');
  if (!TOKEN_RE.test(String(token ?? ''))) return fail('invalid');
  try {
    return await db.transaction(async (tx) => {
      const q = async (text, params) => (await tx.query(text, params)).rows;

      const [tok] = await q('SELECT id, user_id, expires_at, used_at FROM public.telegram_link_tokens WHERE token_hash = $1 FOR UPDATE', [hash(token)]);
      if (!tok) return fail('invalid');
      if (tok.used_at) return fail('used');
      if (new Date(tok.expires_at) <= now) return fail('expired');

      const [X] = await q('SELECT id, status, channel, external_id FROM public.users WHERE id = $1 FOR UPDATE', [tok.user_id]);
      if (!X || inactive(X.status)) return fail('no_user');
      const markUsed = () => q('UPDATE public.telegram_link_tokens SET used_at = $2 WHERE id = $1', [tok.id, now.toISOString()]);
      if (X.channel === 'telegram') {
        if (X.external_id === T) {
          await markUsed();
          return { ok: true, merged: false, already: true, userId: X.id };
        }
        return fail('other_connected');
      }

      const [Y] = await q("SELECT id, status, password_hash, terms_accepted_at FROM public.users WHERE external_id = $1 AND channel = 'telegram' AND id <> $2 FOR UPDATE", [T, X.id]);
      let moved = null;
      let termsFromY = null;
      if (Y) {
        if (inactive(Y.status)) {
          // Старая удалённая или объединённая запись держит этот telegram_id: освобождаем его
          await q("UPDATE public.users SET external_id = 'freed_' || id::text, channel = 'freed' WHERE id = $1", [Y.id]);
        } else {
          // Другой аккаунт со своим входом по почте: автоматически не объединяем, чтобы никого не лишить входа
          if (Y.password_hash) return fail('telegram_has_login');
          moved = await moveData(q, Y.id, X.id, now);
          termsFromY = Y.terms_accepted_at;
          await q("UPDATE public.users SET status = 'merged', merged_into = $2, external_id = 'merged_' || id::text, channel = 'merged', tg_username = NULL WHERE id = $1", [Y.id, X.id]);
        }
      }

      await q(
        `UPDATE public.users SET external_id = $2, channel = 'telegram', tg_username = COALESCE($3::text, tg_username),
                terms_accepted_at = COALESCE(terms_accepted_at, $4::timestamptz), last_active_at = now()
          WHERE id = $1`,
        [X.id, T, tgUsername, termsFromY]
      );
      await markUsed();
      return { ok: true, merged: !!moved, moved, userId: X.id };
    });
  } catch (e) {
    console.error('[link] telegram link failed:', e.message);
    return fail('db');
  }
}

/**
 * Отключает Telegram. Аккаунт остаётся аккаунтом сайта со всеми данными; новый /start в боте создаст новую пустую запись.
 * Аккаунт, созданный только в Telegram (без входа по почте и паролю), отключить нельзя: человек потерял бы доступ.
 * @returns {Promise<{ ok: true, already?: boolean } | { ok: false, reason: 'no_user' | 'no_login' | 'db' }>}
 */
export async function disconnectTelegram(db, userId) {
  const { data: user, error } = await db.from('users').select('id, channel, status, password_hash').eq('id', userId).maybeSingle();
  if (error) return fail('db');
  if (!user || inactive(user.status)) return fail('no_user');
  if (user.channel !== 'telegram') return { ok: true, already: true };
  if (!user.password_hash) return fail('no_login');
  const upd = await db.from('users').update({ external_id: user.id, channel: 'web', tg_username: null }).eq('id', userId);
  if (upd.error) return fail('db');
  return { ok: true };
}
