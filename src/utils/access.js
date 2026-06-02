import { queryOne } from '../db.js';

export async function getUserAccess(userId) {
  const { data } = await queryOne(
    `SELECT status FROM subscriptions
     WHERE user_id = $1
       AND status IN ('trial', 'active')
       AND ends_at > NOW()
     ORDER BY ends_at DESC
     LIMIT 1`,
    [userId]
  );
  return data?.status ?? 'free';
}
