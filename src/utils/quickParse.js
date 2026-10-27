// Быстрый разбор коротких записей без ИИ (патч 49): «развлечения 400», «налоги 5000», «золотое яблоко 3400».
// Берётся только фраза «слова + одна сумма», где слова целиком опознаны справочником. Всё остальное идёт к ИИ.
// Свои категории пользователя главнее: если слова похожи на название или синоним его категории, решает ИИ.
import { splitAmountAndWords, matchHint, normalizePhrase } from './categoryHints.js';
import { parseAmount } from './parseAmount.js';

export const MAX_QUICK_AMOUNT = 100_000_000;

function touchesUserCategory(words, userCategories) {
  const w = normalizePhrase(words);
  for (const c of userCategories ?? []) {
    const names = [c.name, ...(Array.isArray(c.synonyms) ? c.synonyms : [])].map(normalizePhrase).filter(Boolean);
    if (names.some((n) => n === w || n.includes(w) || w.includes(n))) return true;
  }
  return false;
}

// → { type, amount, category, comment, transaction_date, confidence } или null
export function quickParse(text, userCategories, today) {
  const parts = splitAmountAndWords(text);
  if (!parts) return null;
  const hint = matchHint(parts.words);
  if (!hint) return null;
  if (touchesUserCategory(parts.words, userCategories)) return null;
  const amount = parseAmount(parts.amountText);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_QUICK_AMOUNT) return null;
  return {
    type: hint.type,
    amount,
    category: hint.category,
    comment: hint.comment,
    transaction_date: today,
    confidence: 'high',
  };
}
