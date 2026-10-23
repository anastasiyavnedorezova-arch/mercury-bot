// «Пополнить» цель из кабинета: записывает взнос так же, как бот («на цель 5000»), только сразу на выбранную цель.
import { isUuid } from './categories.js';
import { GOAL_CATEGORY, getContributions, goalProgress } from '../utils/goalProgress.js';
import { todayStr } from '../utils/dateTz.js';

const fail = (status, message) => ({ status, json: { error: message, message } });

export async function addGoalContribution(db, userId, goalId, body = {}, today = todayStr()) {
  if (!isUuid(goalId)) return fail(404, 'Цель не найдена');

  const sum = Number(body?.amount);
  if (!Number.isFinite(sum) || sum <= 0) return fail(400, 'Сумма должна быть больше нуля');
  if (sum >= 1e10) return fail(400, 'Слишком большая сумма');
  const amount = Math.round(sum * 100) / 100;

  const { data: goal, error: goalErr } = await db
    .from('goals')
    .select('*')
    .eq('id', goalId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  if (goalErr) throw goalErr;
  if (!goal) return fail(404, 'Цель не найдена');

  const { data: cat, error: catErr } = await db
    .from('categories')
    .select('id')
    .eq('name', GOAL_CATEGORY)
    .is('user_id', null)
    .limit(1)
    .maybeSingle();
  if (catErr) throw catErr;
  if (!cat) throw new Error('system category «Цель» not found');

  // comment = название цели: в истории видно, на какую цель ушёл взнос
  const { error } = await db.from('transactions').insert({
    user_id: userId,
    type: 'goal',
    amount,
    category_id: cat.id,
    goal_id: goal.id,
    comment: goal.name,
    transaction_date: today,
    raw_message: `пополнение цели ${goal.name}`,
  });
  if (error) throw error;

  const p = goalProgress(goal, await getContributions(db, userId));
  return { status: 200, json: { ok: true, saved: p.saved, target: p.target, percent: p.percent } };
}
