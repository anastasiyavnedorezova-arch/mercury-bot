// Единый источник «сегодня» и «сейчас» для календарной логики.
// Сервер может работать в UTC (Railway) или в Москве (РФ-хостинг) — результат не должен зависеть от этого.
// Часовой пояс приложения можно переопределить переменной APP_TIMEZONE (по умолчанию Москва).

export const APP_TZ = process.env.APP_TIMEZONE || 'Europe/Moscow';

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: APP_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

function parts(date) {
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) {
    if (type !== 'literal') p[type] = parseInt(value, 10);
  }
  return p;
}

const pad2 = (n) => String(n).padStart(2, '0');

// 'YYYY-MM-DD' — сегодняшняя дата в часовом поясе приложения
export function todayStr(date = new Date()) {
  const p = parts(date);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

// Date, у которого локальные геттеры (getFullYear/getMonth/getDate/getHours...) возвращают
// «настенное» время в часовом поясе приложения — независимо от часового пояса сервера.
// Использовать ТОЛЬКО для календарной логики (какой сегодня день/месяц), не для записи момента времени в БД.
export function inTz(date = new Date()) {
  const p = parts(date);
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

// 'YYYY-MM-01' для месяца month (1–12), без Date и без сдвигов часовых поясов
export function monthStartStr(year, month) {
  return `${year}-${pad2(month)}-01`;
}

// 'YYYY-MM-DD' последнего дня месяца month (1–12)
export function monthEndStr(year, month) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad2(month)}-${pad2(last)}`;
}
