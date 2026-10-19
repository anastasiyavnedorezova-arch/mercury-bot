// Текст «История транзакций» для бота. Чистые функции без базы: их проверяют тесты.
const MONTHS_RU = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

export const TELEGRAM_TEXT_LIMIT = 3900;
export const HISTORY_URL = 'finnikbot.ru/cabinet/history';

export function formatNum(n) {
  return Math.round(n).toLocaleString('ru-RU');
}

export function formatRuDate(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${parseInt(d)} ${MONTHS_RU[parseInt(m) - 1]}`;
}

/**
 * @param {Array} transactions  показанные операции (последние по дате)
 * @param {{ sumIncome: number, sumExpense: number }} totals  итоги по ВСЕМ операциям периода
 * @param {{ total?: number }} [o] total — сколько всего операций в периоде (может быть больше показанных)
 */
export function buildHistoryText(transactions, totals, startDate, endDate, limitNote, { total } = {}) {
  const { sumIncome, sumExpense } = totals;
  const balance = sumIncome - sumExpense;
  const shown = transactions.length;
  const all = Math.max(total ?? shown, shown);

  let head = `📋 История за ${formatRuDate(startDate)} — ${formatRuDate(endDate)}\nВсего: ${all} операций\n`;
  if (all > shown) head += `Показаны последние ${shown}. Полный список за этот период в кабинете: ${HISTORY_URL}\n`;
  if (limitNote) head += `ℹ️ ${limitNote}\n`;
  head += '\n';

  const byDate = {};
  for (const t of transactions) {
    const d = t.transaction_date;
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(t);
  }
  let list = '';
  for (const [date, txs] of Object.entries(byDate)) {
    list += `📅 ${formatRuDate(date)}\n`;
    for (const t of txs) {
      const sign = t.type === 'income' ? '+' : '-';
      const cat = t.categories?.name ?? 'Другое';
      const comment = t.comment ? ` (${t.comment})` : '';
      list += `- ${cat}${comment} ${sign} ${formatNum(t.amount)} ₽\n`;
    }
    list += '\n';
  }

  const balanceStr = balance > 0 ? `+${formatNum(balance)}` : balance < 0 ? `-${formatNum(Math.abs(balance))}` : '0';
  const footer =
    `💰 Доходы: +${formatNum(sumIncome)} ₽\n` +
    `💸 Расходы: -${formatNum(sumExpense)} ₽\n` +
    `📊 Баланс: ${balanceStr} ₽`;

  // Лимит Telegram 4096 символов: при нехватке места режем список, а итоги в конце оставляем
  const room = TELEGRAM_TEXT_LIMIT - head.length - footer.length;
  if (list.length > room) {
    const cutNote = '…(список сокращён)\n\n';
    list = list.slice(0, Math.max(0, room - cutNote.length)).replace(/\n[^\n]*$/, '\n') + cutNote;
  }
  return head + list + footer;
}
