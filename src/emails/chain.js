// Цепочка писем: кому и какое письмо пора отправить.
//  decideLetter(facts)  — чистая функция: по фактам об одном пользователе выбирает ровно одно письмо (или ничего);
//  runChain(db, opts)   — собирает факты из базы и отправляет (или только показывает, что отправила бы).
// Режимы (LETTERS_MODE): off — ничего не делаем, dry — только пишем в лог, on — отправляем.
import { maskEmail } from '../utils/email.js';
import { pickSubscription, rowsHadTrial } from '../utils/trial.js';
import { needsPay } from './letters.js';
import { sendLetter } from './send.js';
import * as config from './config.js';

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

// ── Правила (все сроки в одном месте) ─────────────────────────────────────
export const RULES = {
  welcomeAfter: 5 * MIN,        // №1: через 5 минут после регистрации (cron раз в 5 минут → 5–10 минут)
  welcomeUntil: 24 * H,         // №1: если не успели за сутки — уже не шлём
  activationAfter: 48 * H,      // №2: через 48 часов после регистрации, если нет ни одной записи
  activationUntil: 10 * D,      //     …но не позже 10 дней после регистрации
  activation2After: 24 * H,     // №2.1: через 24 часа после №2
  helpAfter: 48 * H,            // №2.2: через 48 часов после №2.1
  featuresAfterReg: 5 * D,      // №3: не раньше чем через 5 дней после регистрации…
  featuresAfterLast: 5 * D,     //     …и через 5 дней после последнего письма цепочки
  featuresMinTrialLeft: 2 * D,  //     …и пока до конца пробного периода ≥ 2 дней
  marketingGap: 20 * H,         // между маркетинговым письмом и любым предыдущим — не меньше 20 часов
  trial5Max: 5 * D,             // №4.1: когда до конца пробного периода от 2 до 5 дней
  trial5Min: 2 * D,
  trial1Max: 1 * D,             // №4.2: когда до конца остались сутки или меньше
  trialoverMax: 3 * D,          // №5: после окончания, не позже чем через 3 дня
  sub5Max: 5 * D,               // оплаченная подписка: от 2 до 5 дней до конца
  sub5Min: 2 * D,
  sub1Max: 1 * D,               //   …и сутки или меньше
  subOverMax: 3 * D,            //   …и после окончания, не позже чем через 3 дня
  retryAfter: 1 * H,            // после сбоя отправки повторяем не раньше чем через час
  maxAttempts: 3,
  windowFrom: 10,               // окно отправки по Москве: с 10:00 до 20:00
  windowTo: 20,
};

export const mskHour = (d) => new Date(d.getTime() + 3 * H).getUTCHours();
export const inSendWindow = (now) => {
  const h = mskHour(now);
  return h >= RULES.windowFrom && h < RULES.windowTo;
};

// Письма, для которых важно знать, есть ли у человека хоть одна запись
export const NEEDS_TX_CHECK = new Set(['activation', 'activation2', 'help']);

// Можно ли (ещё раз) пробовать это письмо: ещё не отправлялось или прошлая попытка сорвалась давно
function canTry(entry, now) {
  if (!entry) return true;
  if (entry.status !== 'failed') return false;
  if ((entry.attempts ?? 1) >= RULES.maxAttempts) return false;
  return now - Date.parse(entry.attempted_at ?? entry.created_at) >= RULES.retryAfter;
}

/**
 * @param {object} f
 * @param {Date}   f.now
 * @param {object} f.user          строка users
 * @param {boolean} f.isNew        зарегистрирован после LETTERS_CHAIN_START
 * @param {object} f.sent          { ключ_письма: строка email_log }
 * @param {boolean} f.hasTransactions
 * @param {Array}  f.subs          строки subscriptions
 * @param {boolean} f.payReady     платёжные ссылки подключены
 * @param {boolean} [f.testimonialsOk]
 * @returns {{ key: string, logKey?: string, why: string } | null}
 *   logKey — ключ записи в журнале, если он отличается от key (письма про оплаченную подписку повторяются
 *   с каждым оплаченным периодом, поэтому в ключ входит дата окончания периода)
 */
export function decideLetter(f) {
  const now = f.now.getTime();
  const created = Date.parse(f.user.created_at);
  const age = now - created;
  const win = inSendWindow(f.now);
  const sent = f.sent ?? {};
  const subs = f.subs ?? [];
  const payOk = (key) => !needsPay(key) || f.payReady;
  const ok = (key) => canTry(sent[key], now) && payOk(key);
  const sentAt = (key) => (sent[key]?.status === 'sent' && sent[key].sent_at ? Date.parse(sent[key].sent_at) : null);
  const lastLetterAt = Math.max(
    -Infinity,
    ...Object.values(sent).filter((e) => e.status === 'sent' && e.sent_at).map((e) => Date.parse(e.sent_at))
  );

  // 1. Письма про срок пробного периода (всем, кто остался без оплаченной подписки)
  const sub = pickSubscription(subs, f.now);
  const endsAt = sub.ends_at ? Date.parse(sub.ends_at) : null;
  const left = endsAt === null ? null : endsAt - now;
  if (win && sub.status === 'trial' && left !== null && left > 0) {
    if (left <= RULES.trial1Max && ok('trial1')) return { key: 'trial1', why: 'до конца пробного ≤ 1 дня' };
    if (left > RULES.trial5Min && left <= RULES.trial5Max && ok('trial5')) return { key: 'trial5', why: 'до конца пробного 2–5 дней' };
  }
  const live = (sub.status === 'trial' || sub.status === 'active') && left !== null && left > 0;
  const paidEver = subs.some((r) => r.payment_id || r.status === 'active');
  if (win && !live && !paidEver && rowsHadTrial(subs) && endsAt !== null && endsAt <= now && now - endsAt <= RULES.trialoverMax && ok('trialover')) {
    return { key: 'trialover', why: 'пробный закончился не больше 3 дней назад' };
  }

  // 2. Письма про оплаченную подписку: 5 дней, 1 день, закончилась.
  //    Один раз на каждый оплаченный период (в журнале ключ с датой окончания). Продлил — период сдвинулся,
  //    письма «про конец» не уходят; продлил после окончания — у человека снова есть доступ, письмо не нужно.
  const period = endsAt === null ? null : new Date(endsAt).toISOString().slice(0, 10);
  if (win && sub.status === 'active' && left !== null && left > 0) {
    const k1 = `sub1:${period}`;
    const k5 = `sub5:${period}`;
    if (left <= RULES.sub1Max && canTry(sent[k1], now) && payOk('sub1')) return { key: 'sub1', logKey: k1, why: 'до конца подписки ≤ 1 дня' };
    if (left > RULES.sub5Min && left <= RULES.sub5Max && canTry(sent[k5], now) && payOk('sub5')) return { key: 'sub5', logKey: k5, why: 'до конца подписки 2–5 дней' };
  }
  const paidEnds = subs.filter((r) => (r.payment_id || r.status === 'active') && r.ends_at).map((r) => Date.parse(r.ends_at));
  const lastPaidEnd = paidEnds.length ? Math.max(...paidEnds) : null;
  if (win && !live && lastPaidEnd !== null && lastPaidEnd <= now && now - lastPaidEnd <= RULES.subOverMax) {
    const k = `subover:${new Date(lastPaidEnd).toISOString().slice(0, 10)}`;
    if (canTry(sent[k], now) && payOk('subover')) return { key: 'subover', logKey: k, why: 'оплаченная подписка закончилась не больше 3 дней назад' };
  }

  // Дальше — только для «новых» аккаунтов (старые получают лишь письма про срок)
  if (!f.isNew) return null;

  // 2. Приветствие (вне окна отправки — человек только что зарегистрировался)
  if (age >= RULES.welcomeAfter && age <= RULES.welcomeUntil && ok('welcome')) {
    return { key: 'welcome', why: 'регистрация' };
  }

  // 3. Маркетинговые письма: согласие, окно, пауза после предыдущего письма
  const optedIn = f.user.email_letters_accepted === true && !f.user.email_unsubscribed_at;
  const gapOk = lastLetterAt === -Infinity || now - lastLetterAt >= RULES.marketingGap;
  if (!optedIn || !win || !gapOk) return null;

  if (!f.hasTransactions) {
    const a2 = sentAt('activation2');
    if (a2 !== null && now - a2 >= RULES.helpAfter && f.testimonialsOk !== false && ok('help')) {
      return { key: 'help', why: '48 ч после №2.1, записей нет' };
    }
    const a1 = sentAt('activation');
    if (a1 !== null && now - a1 >= RULES.activation2After && ok('activation2')) {
      return { key: 'activation2', why: '24 ч после №2, записей нет' };
    }
    if (age >= RULES.activationAfter && age <= RULES.activationUntil && ok('activation')) {
      return { key: 'activation', why: '48 ч после регистрации, записей нет' };
    }
  }

  const trialLeft = sub.status === 'trial' ? left : null;
  if (
    age >= RULES.featuresAfterReg &&
    (lastLetterAt === -Infinity || now - lastLetterAt >= RULES.featuresAfterLast) &&
    trialLeft !== null && trialLeft >= RULES.featuresMinTrialLeft &&
    ok('features')
  ) {
    return { key: 'features', why: '5 дней с регистрации и с последнего письма' };
  }
  return null;
}

const USER_COLS = 'id, email, status, created_at, email_letters_accepted, email_unsubscribed_at, email_blocked_at';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const groupBy = (rows, col) => {
  const m = new Map();
  for (const r of rows ?? []) {
    if (!m.has(r[col])) m.set(r[col], []);
    m.get(r[col]).push(r);
  }
  return m;
};

/**
 * Один проход по пользователям.
 * @returns {Promise<{ mode: string, users: number, planned: Array, sent: number, failed: number }>}
 */
export async function runChain(db, o = {}) {
  const now = o.now ?? new Date();
  const mode = o.mode ?? config.lettersMode();
  const limit = o.limit ?? 40;
  const sender = o.sender ?? sendLetter;
  const only = o.only === undefined ? config.lettersOnlyTo() : o.only;
  const start = o.chainStart === undefined ? config.chainStart() : o.chainStart;
  const payReady = o.payReady ?? config.paymentsReady();
  const testimonialsOk = o.testimonialsOk ?? config.TESTIMONIALS_CONFIRMED;
  const out = { mode, users: 0, planned: [], sent: 0, failed: 0 };
  if (mode === 'off') return out;

  const { data: usersAll, error } = await db.from('users').select(USER_COLS).not('email', 'is', null).is('email_blocked_at', null);
  if (error) { console.error('[letters] users query failed:', error.message); return out; }
  const users = (usersAll ?? [])
    .filter((u) => !['deleted', 'merged'].includes(u.status))
    .filter((u) => !only || only.has(String(u.email).trim().toLowerCase()))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  out.users = users.length;
  if (!users.length) return out;

  const ids = users.map((u) => u.id);
  const [subsRes, logRes] = await Promise.all([
    db.from('subscriptions').select('user_id, status, ends_at, payment_id').in('user_id', ids),
    db.from('email_log').select('user_id, letter, status, sent_at, created_at, attempted_at, attempts').in('user_id', ids),
  ]);
  if (subsRes.error || logRes.error) { console.error('[letters] query failed:', (subsRes.error || logRes.error).message); return out; }
  const subsBy = groupBy(subsRes.data, 'user_id');
  const logBy = groupBy(logRes.data, 'user_id');

  const hasTx = async (userId) => {
    const { data } = await db.from('transactions').select('id').eq('user_id', userId).limit(1);
    return !!data?.length;
  };

  for (const user of users) {
    if (out.planned.length >= limit) break;
    const sent = {};
    for (const e of logBy.get(user.id) ?? []) sent[e.letter] = e;
    const facts = {
      now, user, sent, payReady, testimonialsOk,
      subs: subsBy.get(user.id) ?? [],
      isNew: !!start && Date.parse(user.created_at) >= start.getTime(),
      hasTransactions: false,
    };
    let d = decideLetter(facts);
    if (d && NEEDS_TX_CHECK.has(d.key) && (await hasTx(user.id))) {
      d = decideLetter({ ...facts, hasTransactions: true });
    }
    if (d) out.planned.push({ userId: user.id, email: maskEmail(user.email), key: d.key, logKey: d.logKey, why: d.why });
  }

  for (const p of out.planned) {
    if (mode === 'dry') {
      console.log(`[letters][dry] ${p.key} → ${p.email} (${p.why})`);
      continue;
    }
    const r = await sender(db, p.userId, p.key, p.logKey ? { logKey: p.logKey } : undefined);
    if (r.ok) out.sent += 1; else { out.failed += 1; p.result = r.reason; }
    await sleep(o.pauseMs ?? 300);
  }
  if (out.planned.length) console.log(`[letters] mode=${mode} planned=${out.planned.length} sent=${out.sent} failed=${out.failed}`);
  return out;
}

let running = false;
// Для планировщика: не даёт запустить второй проход, пока идёт первый
export async function runChainOnce(db, o) {
  if (running) return null;
  running = true;
  try {
    return await runChain(db, o);
  } catch (e) {
    console.error('[letters] run error:', e.message);
    return null;
  } finally {
    running = false;
  }
}
