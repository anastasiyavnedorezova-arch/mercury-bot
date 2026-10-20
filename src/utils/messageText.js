// Текст для колонки «Сообщение» в кабинете (история, дашборд, выгрузка в .csv).
// Комментарий заполняется, только если ИИ нашёл в тексте уточнение («метро», «такси», «билеты на поезд»).
// Если комментария нет, показываем исходный текст человека без суммы: «книги 899» → «книги».
// Ручные записи (в исходном тексте одна сумма) и совпадения с названием категории остаются пустыми.
const AMOUNT_RE = /\d+(?:[\s ]\d{3})*(?:[.,]\d+)?\s*(?:₽|руб(?:лей|ля|\.)?|р(?:\.|(?![а-яё]))|тыс(?:яч[а-яё]*|\.)?|к(?![а-яё]))?/giu;
const MAX_LEN = 120;

const norm = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

export function stripAmount(text) {
  return String(text ?? '').replace(AMOUNT_RE, ' ').replace(/\s+/g, ' ').replace(/^[\s,.;:+\-–—]+|[\s,.;:+\-–—]+$/g, '').trim();
}

export function displayMessage({ comment, raw_message } = {}, categoryName = '') {
  const c = typeof comment === 'string' ? comment.trim() : '';
  if (c) return c;
  if (typeof raw_message !== 'string') return null;
  const raw = raw_message.trim();
  if (!raw || raw.startsWith('/')) return null;
  const text = stripAmount(raw);
  if (!text || text.length > MAX_LEN) return null;
  if (!/[a-zа-яё]/iu.test(text)) return null;
  const t = norm(text);
  const cat = norm(categoryName);
  if (cat && (cat === t || cat.startsWith(t))) return null; // «продукты» у категории «Продукты» — повтор
  return text;
}
