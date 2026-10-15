// Правка транзакции из кабинета («История»). Вынесена из cabinetRoutes.js для проверки тестами.
// Категорию берём по id (его присылает страница); если id нет — ищем по названию и типу.
// Если категорию найти не удалось, оставляем прежнюю: пустая категория базе не подходит.
import { isUuid } from './categories.js';

const fail = (status, message) => ({ status, json: { error: message, message } });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function findCategory(db, userId, { category_id, category }, type) {
  if (isUuid(category_id)) {
    const { data, error } = await db
      .from('categories')
      .select('id, type, user_id')
      .eq('id', category_id)
      .or(`user_id.is.null,user_id.eq.${userId}`)
      .maybeSingle();
    if (error) throw error;
    return data ?? null;
  }
  if (typeof category === 'string' && category.trim()) {
    const { data, error } = await db
      .from('categories')
      .select('id, type, user_id, is_active')
      .eq('name', category.trim())
      .eq('type', type)
      .or(`user_id.is.null,user_id.eq.${userId}`)
      .order('is_active', { ascending: false })
      .order('user_id', { ascending: true, nullsFirst: false });
    if (error) throw error;
    return (data || [])[0] ?? null;
  }
  return null;
}

export async function updateTransaction(db, userId, id, body = {}) {
  if (!isUuid(id)) return fail(404, 'Запись не найдена');
  const { type, amount, transaction_date } = body;

  if (!['income', 'expense'].includes(type)) return fail(400, 'Неверный тип записи');
  const sum = Number(amount);
  if (!Number.isFinite(sum) || sum <= 0) return fail(400, 'Сумма должна быть больше нуля');
  if (sum >= 1e10) return fail(400, 'Слишком большая сумма');
  if (typeof transaction_date !== 'string' || !DATE_RE.test(transaction_date) || Number.isNaN(Date.parse(transaction_date))) {
    return fail(400, 'Неверная дата');
  }

  const update = { type, amount: Math.round(sum * 100) / 100, transaction_date };

  const cat = await findCategory(db, userId, body, type);
  if (cat) {
    if (cat.type !== type) return fail(400, 'Категория не подходит к типу записи');
    update.category_id = cat.id;
  }

  const { data, error } = await db.from('transactions').update(update).eq('id', id).eq('user_id', userId).select('id');
  if (error) throw error;
  if (!data?.length) return fail(404, 'Запись не найдена');
  return { status: 200, json: { ok: true } };
}
