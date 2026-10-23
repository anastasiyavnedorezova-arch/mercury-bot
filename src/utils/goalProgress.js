// Взносы на цели: к какой цели относится взнос и сколько накоплено по каждой цели.
// Раньше «накоплено» считали как initial_saved + сумма ВСЕХ записей категории «Цель», поэтому
// при двух целях один взнос прибавлялся к обеим. Теперь у взноса есть goal_id, считаем по нему.

export const GOAL_CATEGORY = 'Цель';

export const isGoalItem = (item) => item?.type === 'goal' || item?.category === GOAL_CATEGORY;

// Модель иногда отвечает type=expense при категории «Цель» (или наоборот): приводим к одному виду.
export function normalizeGoalItem(item) {
  if (!isGoalItem(item)) return item;
  item.type = 'goal';
  item.category = GOAL_CATEGORY;
  return item;
}

export async function getActiveGoals(db, userId) {
  const { data } = await db
    .from('goals')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  return data ?? [];
}

// Map: goalId -> сумма взносов на эту цель (без учёта initial_saved)
export async function getContributions(db, userId) {
  const { data, error } = await db
    .from('transactions')
    .select('goal_id, amount')
    .eq('user_id', userId)
    .not('goal_id', 'is', null);
  if (error) throw new Error(`getContributions: ${error.message}`);
  const map = new Map();
  for (const row of data ?? []) {
    map.set(row.goal_id, (map.get(row.goal_id) ?? 0) + (Number(row.amount) || 0));
  }
  return map;
}

export const goalTarget = (goal) => Number(goal?.future_value) || Number(goal?.target_amount) || 0;

export function goalSaved(goal, contributions) {
  return (Number(goal?.initial_saved) || 0) + (contributions?.get(goal.id) ?? 0);
}

export function goalProgress(goal, contributions) {
  const saved = goalSaved(goal, contributions);
  const target = goalTarget(goal);
  const percent = target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0;
  return { saved, target, percent, remaining: Math.max(0, target - saved) };
}

// ── Какая цель имелась в виду ────────────────────────────────────────────────

const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

const STOP_WORDS = new Set(['цель', 'цели', 'целью', 'целей', 'взнос', 'копилка', 'копилку', 'откладываю', 'отложил', 'отложила', 'накопил', 'накопила']);

function stem(word) {
  if (word.length >= 7) return word.slice(0, -2);
  if (word.length >= 4) return word.slice(0, -1);
  return word;
}

// Название цели есть в тексте сообщения («на цель отпуск 6000» → «Отпуск»).
// Ровно одно совпадение — это она; ноль или несколько — не угадываем, надо спросить.
export function matchGoalByText(goals, ...texts) {
  const hay = norm(texts.filter(Boolean).join(' '));
  if (!hay) return null;
  const words = hay.split(' ');

  const strong = goals.filter((g) => {
    const n = norm(g.name);
    return n.length >= 3 && !STOP_WORDS.has(n) && ` ${hay} `.includes(` ${n} `);
  });
  if (strong.length === 1) return strong[0];
  if (strong.length > 1) return null;

  const weak = goals.filter((g) => {
    const nameWords = norm(g.name).split(' ').filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
    return nameWords.some((nw) => {
      const st = stem(nw);
      return st.length >= 3 && words.some((w) => w.startsWith(st));
    });
  });
  return weak.length === 1 ? weak[0] : null;
}

// Раскладывает записи из одного сообщения:
//  toSave  — сохраняем сразу ({ item, goalId }, goalId=null для обычных трат);
//  pending — взносы, для которых нужно спросить цель (целей несколько и название не названо);
//  dropped — взносы, которые некуда записать (целей нет).
export function planGoalContributions(goals, items, rawMessage) {
  const toSave = [];
  const pending = [];
  let dropped = 0;
  for (const raw of items) {
    const item = normalizeGoalItem(raw);
    if (!isGoalItem(item)) { toSave.push({ item, goalId: null }); continue; }
    if (goals.length === 0) { dropped++; continue; }
    if (goals.length === 1) { toSave.push({ item, goalId: goals[0].id }); continue; }
    const hit = matchGoalByText(goals, rawMessage, item.comment);
    if (hit) toSave.push({ item, goalId: hit.id });
    else pending.push(item);
  }
  return { toSave, pending, dropped };
}

// Добавляет в запись сведения о цели для текста подтверждения.
export function attachGoalInfo(item, goal, contributions) {
  const p = goalProgress(goal, contributions);
  item.goal = { id: goal.id, name: goal.name, saved: p.saved, target: p.target, percent: p.percent };
  return item;
}

// ── Правка записи: связь с целью должна совпадать с категорией ───────────────

// После смены категории: «Цель» → привязываем к цели (если цель одна), иначе спрашиваем;
// другая категория → привязку снимаем. Возвращает { status, goals?, userId? }.
export async function syncTxGoalLink(db, txId) {
  const { data: tx } = await db
    .from('transactions')
    .select('id, user_id, type, goal_id, categories(name)')
    .eq('id', txId)
    .maybeSingle();
  if (!tx) return { status: 'none' };

  if (tx.categories?.name !== GOAL_CATEGORY) {
    const patch = {};
    if (tx.goal_id) patch.goal_id = null;
    if (tx.type === 'goal') patch.type = 'expense';
    if (Object.keys(patch).length) await db.from('transactions').update(patch).eq('id', txId);
    return { status: 'unlinked' };
  }

  if (tx.type !== 'goal') await db.from('transactions').update({ type: 'goal' }).eq('id', txId);
  const goals = await getActiveGoals(db, tx.user_id);
  if (goals.length === 0) return { status: 'no_goals', userId: tx.user_id };
  if (goals.length === 1) {
    await db.from('transactions').update({ goal_id: goals[0].id }).eq('id', txId);
    return { status: 'linked', userId: tx.user_id };
  }
  if (tx.goal_id && goals.some((g) => g.id === tx.goal_id)) return { status: 'linked', userId: tx.user_id };
  return { status: 'needs_pick', userId: tx.user_id, goals };
}
