// Цели и тариф. Платный тариф и пробный период: до 3 целей, все рабочие.
// Free: рабочая цель одна. Если целей больше одной, человек выбирает рабочую сам, и выбор ОДНОРАЗОВЫЙ:
// пока нет подписки, переключаться между целями нельзя (иначе все цели можно вести бесплатно по очереди).
// Сменить выбор можно только удалив выбранную цель; с подпиской все цели снова рабочие.
// Пока выбора нет (целей больше одной), все цели закрыты, надо выбрать рабочую.
// Данные у закрытых целей не пропадают.

export const FREE_GOAL_LIMIT = 1;
export const PAID_GOAL_LIMIT = 3;
export const maxGoals = (access) => (access === 'free' ? FREE_GOAL_LIMIT : PAID_GOAL_LIMIT);

export const GOAL_LOCKED_NOTE = '🔒 Доступно в подписке: пока подписки нет, рабочая цель одна. Эту можно смотреть и удалять, а с подпиской вернутся пополнение и правка.';
export const GOAL_CHOOSE_NOTE = '🔒 Пока подписки нет, рабочая цель одна. Выбери её: пополнение и правка будут доступны только у неё. Выбор делается один раз, остальные цели можно смотреть и удалять, а с подпиской они снова заработают.';
export const GOAL_LOCKED_SHORT = 'Эта цель доступна в подписке. Пока подписки нет, рабочая цель одна, и её выбор уже сделан 💛';
export const GOAL_CHOOSE_SHORT = 'Сначала выбери рабочую цель в разделе «Моя цель». Пока подписки нет, рабочая цель одна 💛';
export const GOAL_LOCKED_MESSAGE = 'Цель доступна в подписке. Пока подписки нет, рабочая цель одна';
export const GOAL_CHOOSE_MESSAGE = 'Сначала выбери рабочую цель. Пока подписки нет, рабочая цель одна';
export const GOAL_CHOSEN_MESSAGE = 'Рабочая цель уже выбрана. Сменить её можно с подпиской или после удаления выбранной цели';

// usable — рабочие цели, locked — закрытые, working — рабочая цель free, needsChoice — надо выбрать
export function splitGoals(goals, access, workingGoalId) {
  if (access !== 'free') return { usable: [...goals], locked: [], working: null, needsChoice: false };
  if (goals.length === 0) return { usable: [], locked: [], working: null, needsChoice: false };
  const chosen = goals.find((g) => g.id === workingGoalId) ?? null;
  const working = chosen ?? (goals.length === 1 ? goals[0] : null);
  return {
    usable: working ? [working] : [],
    locked: goals.filter((g) => g.id !== working?.id),
    working,
    needsChoice: !working,
  };
}

export async function getWorkingGoalId(db, userId) {
  const { data } = await db.from('users').select('working_goal_id').eq('id', userId).maybeSingle();
  return data?.working_goal_id ?? null;
}

async function activeGoals(db, userId) {
  const { data } = await db
    .from('goals')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  return data ?? [];
}

// Все активные цели человека, разложенные по тарифу
export async function getGoalsByAccess(db, userId, access) {
  const goals = await activeGoals(db, userId);
  if (access !== 'free') return { goals, ...splitGoals(goals, access, null) };
  return { goals, ...splitGoals(goals, access, await getWorkingGoalId(db, userId)) };
}

// Только рабочие цели: сюда идут взносы, пополнение и правка
export async function getUsableGoals(db, userId, access) {
  return (await getGoalsByAccess(db, userId, access)).usable;
}

// Выбор рабочей цели (только на free и только один раз).
// Возвращает { ok:true, goal } или { ok:false, status, reason: 'notfound' | 'chosen' | 'paid' }
export async function setWorkingGoal(db, userId, goalId, access) {
  if (access !== 'free') return { ok: false, status: 409, reason: 'paid' };
  const { goals, working, needsChoice } = await getGoalsByAccess(db, userId, access);
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) return { ok: false, status: 404, reason: 'notfound' };
  if (!needsChoice) {
    // рабочая уже есть: та же цель — всё в порядке, другая — нельзя
    return working.id === goal.id ? { ok: true, goal } : { ok: false, status: 409, reason: 'chosen' };
  }
  const { error } = await db.from('users').update({ working_goal_id: goal.id }).eq('id', userId);
  if (error) throw error;
  return { ok: true, goal };
}
