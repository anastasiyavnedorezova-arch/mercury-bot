// Поиск аккаунта по внешнему идентификатору (telegram_id или идентификатор веб-чата).
// Один общий вариант для всех обработчиков бота: не падает, если строк несколько, не возвращает
// объединённые и удалённые аккаунты, а когда ничего не нашёл — пишет причину в лог
// (раньше «Не нашёл твой аккаунт» не оставлял следов и разобраться было не по чему).
const INACTIVE = new Set(['deleted', 'merged']);

export async function findUserIdByExternalId(db, externalId) {
  const ext = String(externalId ?? '');
  const { data, error } = await db.from('users').select('id, status, channel').eq('external_id', ext);
  if (error) {
    console.error('[user] lookup failed:', error.message);
    return null;
  }
  const all = data ?? [];
  const rows = all.filter((r) => !INACTIVE.has(r.status ?? 'active'));
  if (!rows.length) {
    console.warn(`[user] not found: external_id=…${ext.slice(-4)} rows=${all.length}${all.length ? ` (все ${all.map((r) => r.status).join('/')})` : ''}`);
    return null;
  }
  if (rows.length > 1) console.warn(`[user] several active accounts for external_id=…${ext.slice(-4)}: ${rows.map((r) => r.channel).join('/')}`);
  return (rows.find((r) => r.channel === 'telegram') ?? rows[0]).id;
}
