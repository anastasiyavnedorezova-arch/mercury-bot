import { supabase } from '../db.js';

export async function getUserAccess(userId) {
  const { data } = await supabase
    .from('subscriptions')
    .select('status')
    .eq('user_id', userId)
    .in('status', ['trial', 'active'])
    .gt('ends_at', new Date().toISOString())
    .order('ends_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.status ?? 'free';
}
