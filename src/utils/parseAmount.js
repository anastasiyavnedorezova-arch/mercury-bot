export function parseAmount(text) {
  console.log('[parseAmount] called with:', typeof text, JSON.stringify(text));
  if (text === undefined || text === null) return null;
  const str = text.toString().toLowerCase().trim();
  if (str === '') return null;

  let cleaned = str
    .replace(/[₽руб\.]/g, '')
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
