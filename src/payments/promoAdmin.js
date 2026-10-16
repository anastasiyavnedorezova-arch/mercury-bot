// Управление промокодами (запускается командой на сервере: tools/promo.mjs). Без веб-админки.
import { PRICES } from '../utils/plans.js';
import { CODE_RE, normalizeCode } from './promo.js';

const MAX_OFF = PRICES[1] - 1; // чтобы скидка подходила к любому тарифу и платёж был не меньше 1 ₽

/** Конец указанного дня по Москве: '2026-12-31' → 2026-12-31 23:59:59 МСК. */
export function endOfDayMsk(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return null;
  const d = new Date(`${dateStr}T23:59:59+03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {object} opts { code, off, max?, perUser?, until?, note? }
 * @returns {Promise<{ ok: true, promo: object } | { ok: false, error: string }>}
 */
export async function createPromo(db, opts) {
  const code = normalizeCode(opts.code);
  if (!CODE_RE.test(code)) return { ok: false, error: 'Код: 3–32 символа, только латинские буквы, цифры, дефис и подчёркивание.' };
  const off = Number(opts.off);
  if (!Number.isInteger(off) || off < 1 || off > MAX_OFF) return { ok: false, error: `Скидка (--off) — целое число рублей от 1 до ${MAX_OFF}.` };
  const max = opts.max === undefined || opts.max === null ? null : Number(opts.max);
  if (max !== null && (!Number.isInteger(max) || max < 1)) return { ok: false, error: 'Лимит использований (--max) — целое число от 1.' };
  const perUser = opts.perUser === undefined || opts.perUser === null ? 1 : Number(opts.perUser);
  if (!Number.isInteger(perUser) || perUser < 1) return { ok: false, error: 'Лимит на одного пользователя (--per-user) — целое число от 1.' };
  let expiresAt = null;
  if (opts.until) {
    const d = endOfDayMsk(opts.until);
    if (!d) return { ok: false, error: 'Дата окончания (--until) — в формате ГГГГ-ММ-ДД, например 2026-12-31.' };
    expiresAt = d.toISOString();
  }
  const { data, error } = await db.from('promo_codes').insert({
    code, amount_off_rub: off, max_uses: max, per_user_limit: perUser, expires_at: expiresAt, active: true, note: opts.note || null,
  }).select().single();
  if (error) return { ok: false, error: error.code === '23505' ? `Код ${code} уже существует.` : `Не удалось создать: ${error.message}` };
  return { ok: true, promo: data };
}

export async function setPromoActive(db, rawCode, active) {
  const code = normalizeCode(rawCode);
  const { data, error } = await db.from('promo_codes').update({ active }).eq('code', code).select();
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: `Код ${code} не найден.` };
  return { ok: true, promo: data[0] };
}

/** Список кодов с числом использований. */
export async function listPromos(db) {
  const { data: codes, error } = await db.from('promo_codes').select('*').order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  const { data: reds } = await db.from('promo_redemptions').select('code');
  const counts = new Map();
  for (const r of reds ?? []) counts.set(r.code, (counts.get(r.code) ?? 0) + 1);
  return (codes ?? []).map((c) => ({ ...c, used: counts.get(c.code) ?? 0 }));
}

export function describePromo(p, now = new Date()) {
  const expired = p.expires_at && new Date(p.expires_at) <= now;
  const status = !p.active ? 'выключен' : expired ? 'срок истёк' : (p.max_uses != null && p.used >= p.max_uses) ? 'лимит исчерпан' : 'действует';
  const until = p.expires_at ? new Date(p.expires_at).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' }) : 'без срока';
  return { code: p.code, off: `−${p.amount_off_rub} ₽`, used: `${p.used ?? 0}/${p.max_uses ?? '∞'}`, perUser: String(p.per_user_limit), until, status, note: p.note || '' };
}
