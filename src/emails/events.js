// События от RuSender (вебхук): доставлено, открыто, переход, отказ, жалоба, отписка.
//  POST /webhook/rusender/<RUSENDER_WEBHOOK_SECRET>
// Подписи у вебхуков RuSender нет, поэтому секрет — часть адреса.
// Формат события: { eventId, trigger: 'external_mail.delivered', occurredAt, payload: { email, taskId, linkUrl } }.
// Названия для отказов/жалоб/отписки мы пока не видели, поэтому разбираются «мягко», а каждое событие
// сохраняется целиком (email_events.raw).
// Действуем только когда уверены: постоянный отказ / жалоба → больше не пишем на этот адрес; отписка → маркетинг выключаем.
import crypto from 'crypto';
import express from 'express';
import { maskEmail } from '../utils/email.js';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function secretOk(given) {
  const want = process.env.RUSENDER_WEBHOOK_SECRET;
  if (!want || want.length < 16 || typeof given !== 'string') return false;
  return crypto.timingSafeEqual(sha(want), sha(given));
}

const NESTED = ['data', 'mail', 'message', 'payload', 'event_data', 'eventData'];
function pick(raw, keys) {
  const levels = [raw, ...NESTED.map((n) => raw?.[n]).filter((x) => x && typeof x === 'object')];
  for (const lvl of levels) {
    for (const k of keys) {
      const v = lvl[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (v && typeof v === 'object' && typeof v.email === 'string') return v.email.trim();
    }
  }
  return null;
}

// Приводит название события (на любом языке/написании) к нашему списку
export function classify(name) {
  const s = String(name ?? '').toLowerCase();
  if (!s) return 'unknown';
  if (/spam|complain|abuse|жалоб/.test(s)) return 'complaint';
  if (/unsub|отпис/.test(s)) return 'unsubscribed';
  if (/permanent|hard|not.?exist|non.?exist|no.?such|invalid|постоянн|не существует|несуществ/.test(s)) return 'hard_bounce';
  if (/temporar|soft|overflow|full|unavailab|временн|переполн|недоступ/.test(s)) return 'soft_bounce';
  if (/fail|bounce|error|reject|undeliver|not.?deliver|отказ|ошибк/.test(s)) return 'error';
  if (/click|клик|переход/.test(s)) return 'clicked';
  if (/open|открыт/.test(s)) return 'opened';
  if (/deliver|достав/.test(s)) return 'delivered';
  return 'unknown';
}

export function normalizeEvent(raw) {
  const name = pick(raw, ['trigger', 'event', 'type', 'event_type', 'eventType', 'status', 'name', 'action']);
  return {
    event: classify(name),
    name,
    providerUuid: pick(raw, ['taskId', 'task_id', 'uuid', 'mail_uuid', 'mailUuid', 'message_uuid', 'messageUuid', 'message_id', 'messageId']),
    email: pick(raw, ['email', 'to', 'recipient', 'rcpt', 'address']),
  };
}

export function extractEvents(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : [body];
  return list.filter((x) => x !== undefined && x !== null).slice(0, 200).map((x) => (typeof x === 'object' && !Array.isArray(x) ? x : { value: x }));
}

async function findUser(db, ev) {
  if (ev.providerUuid) {
    const { data } = await db.from('email_log').select('user_id, letter').eq('provider_uuid', ev.providerUuid).limit(1);
    if (data?.[0]) return { userId: data[0].user_id, letter: data[0].letter };
  }
  if (ev.email && ev.email.includes('@')) {
    const { data } = await db.from('users').select('id').eq('email', ev.email.toLowerCase()).limit(1);
    if (data?.[0]) return { userId: data[0].id, letter: null };
  }
  return { userId: null, letter: null };
}

async function applyEffect(db, ev, userId) {
  const now = new Date().toISOString();
  if (ev.event === 'hard_bounce' || ev.event === 'complaint') {
    const reason = ev.event === 'complaint' ? 'spam_complaint' : 'hard_bounce';
    await db.from('users').update({ email_blocked_at: now, email_block_reason: reason }).eq('id', userId).is('email_blocked_at', null);
    return reason;
  }
  if (ev.event === 'unsubscribed') {
    await db.from('users').update({ email_letters_accepted: false }).eq('id', userId);
    await db.from('users').update({ email_unsubscribed_at: now }).eq('id', userId).is('email_unsubscribed_at', null);
    return 'unsubscribed';
  }
  return null;
}

export async function handleEvents(db, body) {
  const result = { received: 0, stored: 0, acted: 0 };
  for (const raw of extractEvents(body)) {
    result.received += 1;
    const ev = normalizeEvent(raw);
    const { userId, letter } = await findUser(db, ev);
    const ins = await db.from('email_events').insert({
      event: ev.event, provider_uuid: ev.providerUuid, user_id: userId, letter, raw,
    });
    if (ins.error) { console.error('[rusender] store failed:', ins.error.message); continue; }
    result.stored += 1;
    let acted = null;
    if (userId) acted = await applyEffect(db, ev, userId);
    if (acted) result.acted += 1;
    console.log(`[rusender] event=${ev.event}${ev.event === 'unknown' ? ` name=${String(ev.name).slice(0, 40)} keys=${Object.keys(raw).slice(0, 12).join(',')}` : ''}` +
      ` user=${userId ? 'found' : 'none'}${ev.email ? ` to=${maskEmail(ev.email)}` : ''}${acted ? ` action=${acted}` : ''}`);
  }
  return result;
}

export function createRusenderRouter({ db }) {
  const router = express.Router();
  router.post('/webhook/rusender/:secret', async (req, res) => {
    if (!secretOk(req.params.secret)) return res.status(404).send('Not found');
    try {
      const r = await handleEvents(db, req.body);
      res.json({ ok: true, ...r });
    } catch (e) {
      console.error('[rusender] error:', e.message);
      res.status(500).json({ ok: false });
    }
  });
  return router;
}
