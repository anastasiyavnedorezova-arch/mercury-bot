// ── Расчёт ежемесячного взноса для финансовой цели ───────────────────────────
//
// Параметры:
//   targetAmount  — стоимость цели в сегодняшних ценах, ₽
//   initialSaved  — уже накоплено, ₽
//   targetDate    — строка 'YYYY-MM-DD' или Date
//   yieldRate     — годовая доходность (0.10 = 10%) или null/0 для без доходности
//
// Возвращает: { futureValue, monthlyPayment, months }
// Бросает Error если дата в прошлом или уже накоплено достаточно.

export function calculateMonthlyPayment({ targetAmount, initialSaved, targetDate, yieldRate = null }) {
  const today = new Date();
  const target = new Date(targetDate);

  // Количество полных календарных месяцев до цели
  const months = (target.getFullYear() - today.getFullYear()) * 12
               + (target.getMonth() - today.getMonth());

  if (months <= 0) throw new Error('Дата цели должна быть в будущем');

  // Лет для расчёта инфляции
  const years = months / 12;

  // Будущая стоимость с учётом инфляции 6%
  const inflationRate = 0.06;
  const futureValue = targetAmount * Math.pow(1 + inflationRate, years);

  let monthlyPayment;

  if (!yieldRate || yieldRate === 0) {
    // БЕЗ доходности: простое деление остатка на число месяцев
    const needToSave = futureValue - initialSaved;
    monthlyPayment = needToSave / months;
  } else {
    // С ДОХОДНОСТЬЮ: формула аннуитета
    const r = yieldRate / 12; // месячная ставка

    // Рост уже накопленных средств за период
    const savedGrowth = initialSaved * Math.pow(1 + yieldRate, years);

    // Сколько нужно добрать взносами
    const needToSave = futureValue - savedGrowth;

    // PMT = S × r ÷ ((1 + r)^n − 1)
    const denominator = Math.pow(1 + r, months) - 1;
    monthlyPayment = needToSave * r / denominator;
  }

  // Защита от отрицательных и нулевых значений
  if (monthlyPayment <= 0) {
    throw new Error('Уже накоплено достаточно для достижения цели!');
  }

  return {
    futureValue: Math.round(futureValue),
    monthlyPayment: Math.round(monthlyPayment),
    months,
  };
}
