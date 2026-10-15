export function parseAmount(text) {
  console.log('[parseAmount] called with:', typeof text, JSON.stringify(text));
  if (text === undefined || text === null) return null;
  const str = text.toString().toLowerCase().trim();
  if (str === '') return null;

  let cleaned = str
    .replace(/[₽руб]/g, '')
    // точка между цифрами — десятичный разделитель («1.5 млн»); точка после слова или в конце («руб.», «тыс.») — просто мусор
    .replace(/\.(?!\d)/g, '')
    // «1.500.000» — точки как разделители тысяч
    .replace(/^\d{1,3}(\.\d{3})+(?=\s|$|[^\d.])/, (m) => m.replace(/\./g, ''))
    .replace(/\s+/g, ' ')
    .trim();

  const multipliers = [
    { pattern: /(млрд|миллиард(а|ов)?)/,    mult: 1_000_000_000 },
    { pattern: /(млн|миллион(а|ов)?)/,      mult: 1_000_000 },
    { pattern: /(тыс(яч(а|и)?)?|тк)/,      mult: 1_000 },
    { pattern: /([кk])$/,                   mult: 1_000 },
  ];

  for (const { pattern, mult } of multipliers) {
    const match = cleaned.match(
      new RegExp(`^([\\d][\\d\\s,.]*)\\s*${pattern.source}`, 'i')
    );
    if (match && match[1] !== undefined) {
      const numStr = match[1].replace(/\s/g, '').replace(',', '.');
      const num = parseFloat(numStr);
      if (!isNaN(num) && num > 0) return Math.round(num * mult);
    }
  }

  const num = parseFloat(cleaned.replace(/\s/g, '').replace(',', '.'));
  return isNaN(num) ? null : Math.round(num);
}

// Строгий разбор для диалогов, где бот ждёт ТОЛЬКО сумму (цель: «сколько накоплено» и т.п.).
// «282 тыс», «1.5 млн», «3 000 000 ₽» — сумма; «500 на цель», «такси 450» — нет (null), чтобы обычная трата
// не принималась за ответ на вопрос бота.
const UNIT_TAIL = /^(?:\s*(?:млрд|миллиард(?:а|ов)?|млн|миллион(?:а|ов)?|тыс(?:яч(?:а|и)?)?|тк|[кk]))?\s*(?:₽|р|руб(?:л(?:ей|я|ь))?)?\.?$/i;

export function parseAmountStrict(text) {
  if (text === undefined || text === null) return null;
  const t = String(text).trim().toLowerCase();
  const m = t.match(/^(\d[\d\s.,]*)(.*)$/);
  if (!m) return null;
  if (!UNIT_TAIL.test(m[2])) return null;
  return parseAmount(t);
}
