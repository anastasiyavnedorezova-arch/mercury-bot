// Цели и тариф. Платный тариф и пробный период: до 3 целей, все рабочие.
// Free: одна рабочая цель (её выбирает человек, по умолчанию самая старая), остальные только смотреть и удалять.
// Данные у закрытых целей не пропадают: с подпиской они снова рабочие.

export const FREE_GOAL_LIMIT = 1;
export const PAID_GOAL_LIMIT = 3;
export const maxGoals = (access) => (access === 'free' ? FREE_GOAL_LIMIT : PAID_GOAL_LIMIT);

export const GOAL_LOCKED_NOTE = '🔒 Доступно в подписке: пока подписки нет, рабочая цель одна. Эту можно смотреть и удалять, а с подпиской вернутся пополнение и правка.';
export const GOAL_LOCKED_SHORT = 'Эта цель доступна в подписке. Пока рабочая цель одна, выбери её кнопкой «Сделать рабочей» 💛';
export const GOAL_LOCKED_MESSAGE = 'Цель доступна в подписке. Пока подписки нет, рабочая цель одна';

const byAge = (a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));

// Рабочая цель free: выбранная, если она среди активных; иначе самая старая
export function pickWorkingGoal(goals, workingGoalId) {
  if (!goals?.length) return null;
  return goals.find((g) => g.id === workingGoalId) ?? [...goals].sort(byAge)[0];
}

// usable — рабочие цели, locked — закрытые тарифом
export function splitGoals(goals, access, workingGoalId) {
  if (access !== 'free') return { usable: [...goals], locked: [], working: null };
  const working = pickWorkingGoal(goals, workingGoalId);
  return {
    usable: working ? [working] : [],
    locked: goals.filter((g) => g.id !== working?.id),
    working,
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

// Выбор рабочей цели. Возвращает { ok, goal } или { ok:false, status }
export async function setWorkingGoal(db, userId, goalId) {
  const goals = await activeGoals(db, userId);
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) return { ok: false, status: 404 };
  const { error } = await db.from('users').update({ working_goal_id: goal.id }).eq('id', userId);
  if (error) throw error;
  return { ok: true, goal };
}
