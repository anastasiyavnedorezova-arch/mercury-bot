// Пробный период и «какая подписка сейчас действует». Функции получают базу (db) параметром —
// так их можно проверять тестами на настоящем PostgreSQL без боевых настроек.
export const TRIAL_DAYS = 30;

// Был ли у пользователя пробный период: любая запись-триал, в том числе уже закончившаяся
// (закончившийся триал имеет статус expired и не имеет платежа).
export function rowsHadTrial(rows) {
  return (rows ?? []).some((r) => r.status === 'trial' || (r.status === 'expired' && !r.payment_id));
}

export async function hadTrial(db, userId) {
  const { data } = await db.from('subscriptions').select('status, payment_id').eq('user_id', userId);
  return rowsHadTrial(data);
}

// Какая запись описывает пользователя сейчас:
// действующий доступ (trial/active, ends_at в будущем) с самой поздней датой окончания;
// иначе самая свежая запись; иначе «free».
export function pickSubscription(rows, now = new Date()) {
  const list = rows ?? [];
  const ts = (r) => (r.ends_at ? new Date(r.ends_at).getTime() : -Infinity);
  const live = list
    .filter((r) => (r.status === 'trial' || r.status === 'active') && ts(r) > now.getTime())
    .sort((a, b) => ts(b) - ts(a));
  if (live.length) return live[0];
  const latest = [...list].sort((a, b) => ts(b) - ts(a))[0];
  return latest ?? { status: 'free', ends_at: null };
}

// Включает пробный период на 30 дней.
// По умолчанию — только если у пользователя вообще нет записей подписки (новый пользователь).
// Никогда не бросает исключение. Возвращает { ok, endsAt } или { ok:false, reason }.
export async function startTrial(db, userId, { onlyIfNoSubscriptions = true, days = TRIAL_DAYS, now = new Date() } = {}) {
  try {
    if (onlyIfNoSubscriptions) {
      const { data, error } = await db.from('subscriptions').select('id').eq('user_id', userId).limit(1);
      if (error) return { ok: false, reason: 'db' };
      if (data?.length) return { ok: false, reason: 'exists' };
    }
    const endsAt = new Date(now);
    endsAt.setDate(endsAt.getDate() + days);
    const { error } = await db.from('subscriptions').insert({
      user_id: userId,
      status: 'trial',
      starts_at: now.toISOString(),
      ends_at: endsAt.toISOString(),
      period_months: null,
      payment_id: null,
      amount_rub: null,
    });
    if (error) return { ok: false, reason: 'db' };
    return { ok: true, endsAt };
  } catch {
    return { ok: false, reason: 'db' };
  }
}

// Закрывает ОДНУ запись подписки (раньше закрывались все записи пользователя, в том числе оплаченные).
export async function expireRow(db, id) {
  return db.from('subscriptions').update({ status: 'expired' }).eq('id', id);
}

// Есть ли у пользователя другая запись trial/active, которая действует дольше указанной даты
// (например, оплатил подписку во время пробного периода или продлил заранее).
export async function hasLaterAccess(db, userId, afterIso) {
  const { data } = await db
    .from('subscriptions')
    .select('id')
    .eq('user_id', userId)
    .in('status', ['trial', 'active'])
    .gt('ends_at', afterIso)
    .limit(1);
  return !!data?.length;
}
