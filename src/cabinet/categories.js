// Логика API категорий кабинета. Вынесена из cabinetRoutes.js, чтобы её можно было проверить тестами на настоящей базе.
// Каждая функция возвращает { status, json } — маршрут просто отправляет это клиенту.

export const NAME_MAX = 40;
export const HINT_MAX = 120;
const ICON_MAX_UNITS = 16; // эмодзи с модификаторами занимают несколько символов UTF-16
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

const fail = (status, message) => ({ status, json: { error: message, message } });

// «дача, огород; теплица» → ['дача','огород','теплица']
export function hintToSynonyms(hint) {
  if (typeof hint !== 'string') return [];
  const seen = new Set();
  const out = [];
  for (const part of hint.split(/[,;\n]/)) {
    const w = part.trim().slice(0, 40);
    const k = w.toLowerCase();
    if (w && !seen.has(k)) {
      seen.add(k);
      out.push(w);
    }
    if (out.length >= 20) break;
  }
  return out;
}

export function synonymsToHint(syn) {
  return Array.isArray(syn) ? syn.join(', ') : '';
}

function cleanIcon(v) {
  if (v === undefined) return { ok: true, value: undefined };
  if (v === null) return { ok: true, value: null };
  if (typeof v !== 'string') return { ok: false };
  const t = v.trim();
  if (t.length > ICON_MAX_UNITS) return { ok: false };
  return { ok: true, value: t || null };
}

export async function listGroups(db) {
  const { data, error } = await db
    .from('category_groups')
    .select('id, name, type, sort_order')
    .order('type', { ascending: true })
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data || [];
}

// Группа для новой категории: выбранная (должна совпадать по типу) или подходящая по умолчанию («Другое», «Прочее»…)
async function resolveGroup(db, type, groupId) {
  const groups = (await listGroups(db)).filter((g) => g.type === type);
  if (groupId) {
    const g = groups.find((x) => x.id === groupId);
    return g ? { id: g.id } : { error: 'Выбери группу, которая подходит к типу операции' };
  }
  if (!groups.length) return { error: 'Не нашла группы для этого типа' };
  const other = groups.find((x) => /друг|проч|остальн/i.test(x.name));
  return { id: (other ?? groups[0]).id };
}

// Название не должно повторять ни системную, ни свою активную категорию (бот ищет категории по названию)
async function nameTaken(db, userId, name, exceptId = null) {
  const { data, error } = await db
    .from('categories')
    .select('id, name')
    .eq('is_active', true)
    .or(`user_id.is.null,user_id.eq.${userId}`);
  if (error) throw error;
  const low = name.toLowerCase();
  return (data || []).some((c) => c.id !== exceptId && String(c.name).trim().toLowerCase() === low);
}

export async function createUserCategory(db, userId, body = {}) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const type = body.type;
  if (!name || !type) return fail(400, 'Укажи название и тип категории');
  if (!['income', 'expense'].includes(type)) return fail(400, 'Неверный тип категории');
  if (name.length > NAME_MAX) return fail(400, `Название не длиннее ${NAME_MAX} символов`);
  const icon = cleanIcon(body.icon);
  if (!icon.ok) return fail(400, 'Иконка слишком длинная');
  if (typeof body.hint === 'string' && body.hint.length > HINT_MAX) return fail(400, `Подсказка не длиннее ${HINT_MAX} символов`);

  const group = await resolveGroup(db, type, body.group_id);
  if (group.error) return fail(400, group.error);
  if (await nameTaken(db, userId, name)) return fail(409, 'Такая категория уже есть. Придумай другое название');

  const { data, error } = await db
    .from('categories')
    .insert({
      group_id: group.id,
      user_id: userId,
      name,
      type,
      is_system: false,
      is_active: true,
      synonyms: hintToSynonyms(body.hint),
      icon: icon.value ?? null,
    })
    .select('id, name, type, user_id, group_id, icon')
    .single();
  if (error) throw error;
  return { status: 201, json: { data } };
}

export async function updateUserCategory(db, userId, id, body = {}) {
  if (!isUuid(id)) return fail(404, 'Категория не найдена');
  const { data: cur, error: curErr } = await db
    .from('categories')
    .select('id, name, type, group_id')
    .eq('id', id)
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle();
  if (curErr) throw curErr;
  if (!cur) return fail(404, 'Категория не найдена');

  const update = {};

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return fail(400, 'Название не может быть пустым');
    if (name.length > NAME_MAX) return fail(400, `Название не длиннее ${NAME_MAX} символов`);
    if (name !== cur.name && (await nameTaken(db, userId, name, id))) return fail(409, 'Такая категория уже есть. Придумай другое название');
    update.name = name;
  }

  const type = body.type !== undefined ? body.type : cur.type;
  if (!['income', 'expense'].includes(type)) return fail(400, 'Неверный тип категории');
  if (type !== cur.type) update.type = type;

  if (body.group_id !== undefined || type !== cur.type) {
    const group = await resolveGroup(db, type, body.group_id ?? (type === cur.type ? cur.group_id : undefined));
    if (group.error) return fail(400, group.error);
    if (group.id !== cur.group_id) update.group_id = group.id;
  }

  if (body.icon !== undefined) {
    const icon = cleanIcon(body.icon);
    if (!icon.ok) return fail(400, 'Иконка слишком длинная');
    update.icon = icon.value;
  }

  if (body.hint !== undefined) {
    if (typeof body.hint === 'string' && body.hint.length > HINT_MAX) return fail(400, `Подсказка не длиннее ${HINT_MAX} символов`);
    update.synonyms = hintToSynonyms(body.hint);
  }

  if (!Object.keys(update).length) return { status: 200, json: { ok: true } };

  const { data, error } = await db.from('categories').update(update).eq('id', id).eq('user_id', userId).select('id');
  if (error) throw error;
  if (!data?.length) return fail(404, 'Категория не найдена');
  return { status: 200, json: { ok: true } };
}

// Список для кабинета: системные + свои активные. Поля icon и hint нужны окну «Редактировать категорию».
export function mapCategoryRow(c) {
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    user_id: c.user_id,
    group_id: c.group_id ?? null,
    group_name: c.category_groups?.name ?? null,
    icon: c.icon ?? null,
    hint: synonymsToHint(c.synonyms),
  };
}
