// Свои категории и тариф. На тарифе free (пробный период закончился, подписки нет) свои категории
// остаются в аккаунте, но записи в них не пишутся: запись уходит в системную категорию «Остальное».
// Все места, где запись получает категорию (бот, чат в кабинете, «История» кабинета), берут правила отсюда.

export const FALLBACK_CATEGORY = 'Остальное';

export const CUSTOM_LOCKED_NOTE =
  'ℹ️ Свои категории доступны в подписке, поэтому запись попала в «Остальное». Категорию можно исправить кнопкой ниже.';

export const CUSTOM_CREATE_LOCKED_TEXT =
  'Свои категории доступны на пробном периоде и в подписке 💛\n' +
  'Уже созданные категории сохранены: с подпиской в них снова можно будет записывать траты.';

export const CUSTOM_MY_LOCKED_TEXT =
  'Пока подписки нет, записи в твои категории не пишутся, они попадают в «Остальное». С подпиской всё вернётся 💛';

export const CUSTOM_EDIT_LOCKED_MESSAGE =
  'Записи в свои категории доступны на пробном периоде и в подписке. Выбери системную категорию';

export const CUSTOM_CREATE_LOCKED_MESSAGE =
  'Свои категории доступны на пробном периоде и в подписке. Уже созданные сохранены';

// access — результат getUserAccess: 'trial' | 'active' | 'free'
export const customCategoriesAllowed = (access) => access === 'trial' || access === 'active';

// Системная категория доступна всем, своя — только владельцу и только с пробным периодом или подпиской
export function canUseCategory(cat, userId, access) {
  if (!cat) return false;
  if (cat.user_id === null || cat.user_id === undefined) return true;
  return cat.user_id === userId && customCategoriesAllowed(access);
}

// Ограничивает запрос к categories: системные + свои (если можно) или только системные
export function applyCategoryScope(query, userId, access) {
  return customCategoriesAllowed(access)
    ? query.or(`user_id.is.null,user_id.eq.${userId}`)
    : query.is('user_id', null);
}

// Категория для записи по названию. Своя приоритетнее системной; если она закрыта тарифом — «Остальное».
// Не нашли — тоже «Остальное». lockedFrom — название своей категории, которую пришлось заменить.
export async function resolveCategory(db, userId, name, access) {
  const { data: rows } = await db
    .from('categories')
    .select('id, name, user_id')
    .eq('name', name)
    .eq('is_active', true);
  const list = rows ?? [];
  const own = list.find((r) => r.user_id === userId);
  const system = list.find((r) => r.user_id === null);
  if (own && customCategoriesAllowed(access)) return { id: own.id, name: own.name, lockedFrom: null };
  const found = own ? system : (system ?? null);
  if (found) return { id: found.id, name: found.name, lockedFrom: null };

  if (own) console.warn('[category] своя категория закрыта тарифом free:', name, '→', FALLBACK_CATEGORY);
  else console.warn('[resolveCategory] Category not found:', name, '— falling back to', FALLBACK_CATEGORY);
  const { data: fallback } = await db
    .from('categories')
    .select('id, name')
    .eq('name', FALLBACK_CATEGORY)
    .is('user_id', null)
    .limit(1)
    .maybeSingle();
  return { id: fallback?.id ?? null, name: fallback?.name ?? FALLBACK_CATEGORY, lockedFrom: own ? own.name : null };
}

// Категории группы для выбора в боте: только системные и (если можно) свои, и только активные
export async function listPickableCategories(db, userId, access, groupId) {
  const q = db.from('categories').select('id, name').eq('group_id', groupId).eq('is_active', true);
  const { data } = await applyCategoryScope(q, userId, access).order('name');
  return data ?? [];
}

// Проверка выбранной категории: есть, активна, не чужая и не закрыта тарифом
export async function findPickableCategory(db, userId, access, categoryId) {
  const { data } = await db
    .from('categories')
    .select('id, name, type, user_id, is_active')
    .eq('id', categoryId)
    .maybeSingle();
  if (!data || data.is_active === false) return null;
  return canUseCategory(data, userId, access) ? data : null;
}
