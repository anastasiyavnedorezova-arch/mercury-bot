// Личная память фраз (патч 51). Человек записал фразу вручную или исправил категорию — в следующий раз
// такая же фраза («слова + одна сумма») у него же записывается в ту же категорию без ИИ.
// Память хранится в таблице user_phrases, каждая строка принадлежит одному аккаунту; читаем только по user_id.
import { splitAmountAndWords } from './categoryHints.js';
import { analyzePhrase, phraseKey } from './learnSignal.js';
import { parseAmount } from './parseAmount.js';
import { MAX_QUICK_AMOUNT } from './quickParse.js';

// Ключ фразы: слова без суммы. null — если это не «слова + одна сумма» (память для таких не нужна)
export function memoryKey(text) {
  const parts = splitAmountAndWords(text);
  if (!parts) return null;
  return phraseKey(parts.words) || null;
}

export const memoryNote = (text, category) => {
  const words = String(splitAmountAndWords(text)?.words ?? text).trim().slice(0, 60);
  return `Запомнил: «${words}» → «${category}», в следующий раз запишу так же 😉`;
};

// Запомнить. Возвращает ключ или null, если запоминать нечего. Никогда не бросает исключение.
export async function rememberPhrase(db, userId, text, { type, category }) {
  try {
    if (!userId || !category || (type !== 'expense' && type !== 'income')) return null;
    const key = memoryKey(text);
    if (!key) return null;
    if (!analyzePhrase(text, null).ok) return null; // бессмыслицу и чужой язык не запоминаем
    const { error } = await db.from('user_phrases').upsert(
      { user_id: userId, phrase_norm: key, type, category, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,phrase_norm' },
    );
    if (error) {
      console.error('[memory] save error:', error.message);
      return null;
    }
    return key;
  } catch (err) {
    console.error('[memory] save error:', err.message);
    return null;
  }
}

// Вспомнить: готовая запись для сохранения или null. Ищет только среди фраз этого аккаунта.
export async function recallPhrase(db, userId, text, today) {
  try {
    if (!userId) return null;
    const parts = splitAmountAndWords(text);
    if (!parts) return null;
    const key = phraseKey(parts.words);
    if (!key) return null;
    const amount = parseAmount(parts.amountText);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_QUICK_AMOUNT) return null;
    const { data } = await db.from('user_phrases').select('type, category').eq('user_id', userId).eq('phrase_norm', key).maybeSingle();
    if (!data) return null;
    return {
      type: data.type,
      amount,
      category: data.category,
      comment: null,
      transaction_date: today,
      confidence: 'high',
      remembered: { words: parts.words.trim().slice(0, 60), category: data.category },
    };
  } catch (err) {
    console.error('[memory] recall error:', err.message);
    return null;
  }
}
