// Патч 54 (27.10.2026): единый расчёт бюджета для бота, веб-чата и уведомлений.
//
// Правила:
//  1) «Потрачено», «Остаток» и процент бюджета считают ВСЕ расходы месяца, включая жильё и кредиты
//     (так же, как кабинет). Раньше бот молча пропускал категории с is_system = true.
//  2) В прогнозе до конца месяца крупные траты не растягиваются на остаток месяца: уже оплаченное
//     входит в итог как факт, а средний расход в день считается без них.

// Крупные траты. Это те же три категории, которые бот раньше пропускал целиком (is_system = true).
export const LARGE_CATEGORIES = ['Жильё', 'Кредиты и займы', 'Цель'];

// Строка, которую бот добавляет к каждому сообщению с прогнозом
export const LARGE_NOTE = `ℹ️ Из расчёта темпа я исключаю крупные траты типа: ${LARGE_CATEGORIES.map((c) => c.toLowerCase()).join(', ')}.`;

const num = (n) => Math.round(n).toLocaleString('ru-RU');

// Расходы за месяц: общий итог, крупные и обычные. from включительно, to исключительно ('YYYY-MM-DD').
export async function getMonthExpenses(db, userId, from, to) {
  const { data } = await db
    .from('transactions')
    .select('amount, categories(name)')
    .eq('user_id', userId)
    .eq('type', 'expense')
    .gte('transaction_date', from)
    .lt('transaction_date', to);
  return splitExpenses(data ?? []);
}

export function splitExpenses(rows) {
  let total = 0;
  let large = 0;
  const byCategory = {};
  for (const r of rows) {
    const amount = Number(r.amount ?? 0);
    const name = r.categories?.name ?? 'Другое';
    total += amount;
    if (LARGE_CATEGORIES.includes(name)) large += amount;
    byCategory[name] = (byCategory[name] ?? 0) + amount;
  }
  return { total, large, regular: total - large, byCategory };
}

// Прогноз: факт (всё, что уже потрачено) + средний обычный расход в день на оставшиеся дни.
export function buildForecast({ total, large, regular }, day, daysInMonth) {
  const remainingDays = Math.max(0, daysInMonth - day);
  const avgDaily = day > 0 ? regular / day : 0;
  const forecast = total + avgDaily * remainingDays;
  return { total, large, regular, avgDaily, forecast, remainingDays };
}

// Текст сообщения «Прогноз до конца месяца» (общий для меню бюджета и аналитики)
export function forecastText(f, budgetAmount) {
  let text = `📊 Прогноз до конца месяца\n\nПотрачено сейчас: ${num(f.total)} ₽\n`;
  if (f.large > 0) text += `Из них крупные траты: ${num(f.large)} ₽\n`;
  text +=
    `Среднедневной расход без крупных трат: ${num(f.avgDaily)} ₽/день\n` +
    `Прогноз до конца месяца: ${num(f.forecast)} ₽\n\n`;

  if (!budgetAmount) {
    text += `При текущем темпе до конца месяца потратишь примерно ${num(f.forecast)} ₽`;
  } else {
    const pct = (f.forecast / budgetAmount) * 100;
    text += pct <= 100
      ? `Если сохранишь темп расходов — израсходуешь ${Math.round(pct)}% своего бюджета 💛`
      : `⚠️ Если сохранишь темп расходов — перерасходуешь бюджет на ${Math.round(pct - 100)}%`;
  }
  return `${text}\n\n${LARGE_NOTE}`;
}
