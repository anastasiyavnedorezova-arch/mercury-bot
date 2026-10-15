// Правка поля «Сколько накоплено» у цели. Вынесено из handlers/goal.js, чтобы проверять тестами на настоящей базе.
import { calculateMonthlyPayment, futureValueOf } from './goalCalc.js';

// Диалог «жду сумму» (создание или правка цели) живёт не дольше 30 минут: иначе забытый вопрос бота
// съест любое следующее сообщение пользователя.
export const GOAL_STATE_TTL_MS = 30 * 60 * 1000;

export function isGoalStateExpired(state, now = Date.now()) {
  return Boolean(state?.createdAt) && now - state.createdAt > GOAL_STATE_TTL_MS;
}

/**
 * Записывает новую накопленную сумму и пересчитывает взнос.
 * Возвращает:
 *  { status: 'ok', calc }        — взнос пересчитан
 *  { status: 'enough', futureValue } — накопленного уже хватает (с учётом доходности): сумма сохранена, взнос 0
 *  { status: 'notfound' }        — цели нет
 */
export async function applyGoalSaved(db, goalId, saved) {
  const { data: goal } = await db.from('goals').select('*').eq('id', goalId).maybeSingle();
  if (!goal) return { status: 'notfound' };

  const now = new Date().toISOString();
  let calc;
  try {
    calc = calculateMonthlyPayment({
      targetAmount: goal.target_amount,
      initialSaved: saved,
      targetDate: goal.target_date,
      yieldRate: goal.yield_rate ?? null,
    });
  } catch (e) {
    if (!/накоплено достаточно/i.test(e.message)) throw e;
    const futureValue = futureValueOf({ targetAmount: goal.target_amount, targetDate: goal.target_date });
    const { error } = await db
      .from('goals')
      .update({ initial_saved: saved, future_value: futureValue, monthly_payment: 0, last_recalculated_at: now })
      .eq('id', goalId);
    if (error) throw error;
    return { status: 'enough', futureValue };
  }

  const { error } = await db
    .from('goals')
    .update({ initial_saved: saved, future_value: calc.futureValue, monthly_payment: calc.monthlyPayment, last_recalculated_at: now })
    .eq('id', goalId);
  if (error) throw error;
  return { status: 'ok', calc };
}
