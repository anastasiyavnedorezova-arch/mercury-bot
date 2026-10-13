// Отправка одного письма цепочки пользователю: проверки → запись в журнал → отправка → результат в журнал.
// Журнал (email_log, unique по пользователь+письмо) не даёт отправить одно письмо дважды.
import { sendEmail as realSendEmail, maskEmail } from '../utils/email.js';
import { LETTERS, renderLetter, TESTIMONIALS_CONFIRMED } from './letters.js';
import * as config from './config.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 *  reason: unknown_letter | no_user | inactive | no_email | blocked | not_opted_in | testimonials_not_confirmed |
 *          already | not_configured | send_failed | db
 */
export async function sendLetter(db, userId, key, deps = {}) {
  const sendEmail = deps.sendEmail ?? realSendEmail;
  const testimonialsOk = deps.testimonialsConfirmed ?? config.TESTIMONIALS_CONFIRMED ?? TESTIMONIALS_CONFIRMED;
  const def = LETTERS[key];
  if (!def) return { ok: false, reason: 'unknown_letter' };
  if (def.requiresTestimonials && !testimonialsOk) return { ok: false, reason: 'testimonials_not_confirmed' };

  const { data: user, error: userErr } = await db
    .from('users')
    .select('id, email, status, email_letters_accepted, email_unsubscribed_at, email_blocked_at')
    .eq('id', userId)
    .maybeSingle();
  if (userErr) return { ok: false, reason: 'db' };
  if (!user) return { ok: false, reason: 'no_user' };
  if (['deleted', 'merged'].includes(user.status)) return { ok: false, reason: 'inactive' };
  const email = String(user.email ?? '').trim();
  if (!EMAIL_RE.test(email)) return { ok: false, reason: 'no_email' };
  if (user.email_blocked_at) return { ok: false, reason: 'blocked' };
  if (def.kind === 'marketing' && (user.email_letters_accepted !== true || user.email_unsubscribed_at)) {
    return { ok: false, reason: 'not_opted_in' };
  }

  // Бронируем письмо в журнале. Если уже есть: «failed» — пробуем снова, всё остальное — не повторяем.
  let logId;
  const ins = await db.from('email_log').insert({ user_id: userId, letter: key, status: 'sending' }).select('id').single();
  if (ins.error) {
    if (ins.error.code !== '23505') return { ok: false, reason: 'db' };
    const { data: prev } = await db.from('email_log').select('id, status, attempts').eq('user_id', userId).eq('letter', key).maybeSingle();
    if (!prev || prev.status !== 'failed') return { ok: false, reason: 'already' };
    const { error } = await db.from('email_log')
      .update({ status: 'sending', error: null, attempts: (prev.attempts ?? 1) + 1, attempted_at: new Date().toISOString() })
      .eq('id', prev.id);
    if (error) return { ok: false, reason: 'db' };
    logId = prev.id;
  } else {
    logId = ins.data.id;
  }

  const { subject, html, text } = renderLetter(key, { userId });
  const res = await sendEmail({ to: email, subject, html, text, idempotencyKey: `letter-${key}-${userId}` });

  if (res.ok) {
    await db.from('email_log').update({ status: 'sent', provider_uuid: res.uuid ?? null, sent_at: new Date().toISOString() }).eq('id', logId);
    console.log(`[letters] ${key} sent to ${maskEmail(email)}`);
    return { ok: true };
  }
  if (res.skipped) {
    // Почта не настроена (нет ключей): не считаем письмо отправленным, снимаем бронь
    await db.from('email_log').delete().eq('id', logId);
    return { ok: false, reason: 'not_configured' };
  }
  await db.from('email_log').update({ status: 'failed', error: String(res.error ?? res.status ?? 'error').slice(0, 200) }).eq('id', logId);
  return { ok: false, reason: 'send_failed' };
}
