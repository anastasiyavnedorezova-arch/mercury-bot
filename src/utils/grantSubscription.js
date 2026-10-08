import { supabase } from '../db.js';
import { computePeriod } from './plans.js';

// Добавляет оплаченный период. Всегда новая строка (в subscriptions нет
// уникального user_id); если доступ ещё действует — период идёт после него.
export async function grantSubscription(userId, months, { paymentId = null, amountRub = null } = {}) {
  const { data: last } = await supabase
    .from('subscriptions')
    .select('ends_at')
    .eq('user_id', userId)
    .in('status', ['trial', 'active'])
    .order('ends_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { startsAt, endsAt } = computePeriod(last?.ends_at, months);

  const { error } = await supabase.from('subscriptions').insert({
    user_id: userId,
    status: 'active',
    period_months: months,
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    payment_id: paymentId,
    amount_rub: amountRub,
  });
  if (error) throw new Error(`subscription insert failed: ${error.message}`);

  return { startsAt, endsAt };
}
