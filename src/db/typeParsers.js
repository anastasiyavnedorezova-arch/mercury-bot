// Приводим типы PostgreSQL к тем, которые раньше отдавал Supabase (PostgREST):
// числа — числами, даты — строками, время — ISO-строкой.
// Без этого numeric и count приходят строками, и код вида `sum + t.amount` склеивает строки вместо сложения.

// 'YYYY-MM-DD HH:MM:SS[.ffffff]+00' -> ISO-строка в UTC
export function timestamptzToIso(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  if (s === 'infinity' || s === '-infinity') return s;
  s = s.replace(' ', 'T');
  if (/[+-]\d{2}$/.test(s)) s += ':00';          // +00 -> +00:00
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toISOString();
}

export const PARSERS = {
  20: (v) => Number(v),          // int8 (например, count(*))
  1700: (v) => Number(v),        // numeric
  1082: (v) => v,                // date -> 'YYYY-MM-DD' (строка, как раньше)
  1184: timestamptzToIso,        // timestamptz -> ISO-строка
};
