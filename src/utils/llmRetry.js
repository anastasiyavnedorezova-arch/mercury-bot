// Если модель ответила «не распознано» на сообщение с суммой, спрашиваем её ещё раз с подсказкой.
// Нужно, потому что модель иногда отказывается даже от простых записей («книги 499», «сок 398»): одна и та же фраза
// в разное время распознаётся по-разному.
export const RETRY_HINT =
  'Подсказка: это обычная запись о трате или доходе, в сообщении есть сумма и название покупки или услуги. ' +
  'Подбери ближайшую категорию из списка (еда и напитки для дома — «Продукты», книги — «Обучение»). ' +
  'Верни {"error":"unrecognized"} только если в сообщении нет ни одного слова, обозначающего покупку, услугу или доход.';

export function needsRetry(parsed, text) {
  return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    && parsed.error === 'unrecognized' && /\d/.test(String(text ?? ''));
}

// call({ retryHint }) → результат разбора. Вторая попытка — только при «не распознано», не больше одной.
export async function parseWithRetry(call, text, log = console.log) {
  const first = await call({});
  if (!needsRetry(first, text)) return first;
  log('[llm] не распознано, повторная попытка', JSON.stringify(text));
  const second = await call({ retryHint: RETRY_HINT });
  if (!needsRetry(second, text)) log('[llm] повторная попытка помогла', JSON.stringify(text));
  return second;
}
