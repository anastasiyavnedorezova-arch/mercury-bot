// Сколько запросов к ИИ потратили сегодня и за последнюю неделю (только читает). Из папки приложения:
//   node --env-file=/etc/finnik-prod.env tools/ai-usage.mjs
// Для stage используйте /etc/finnik-stage.env.
import { supabase } from '../src/db.js';
import { aiLimitsConfig, GLOBAL_SUBJECT } from '../src/utils/aiLimit.js';

const cfg = aiLimitsConfig();
// у клиента базы нет прямого SQL: читаем через транзакцию (она только читает)
const sql = (text, params) => supabase.transaction((tx) => tx.query(text, params));
const today = `(now() AT TIME ZONE 'Europe/Moscow')::date`;

async function main() {
  const total = await sql(
    `SELECT day::text, requests FROM public.ai_usage WHERE subject = $1 AND day > ${today} - 7 ORDER BY day DESC`,
    [GLOBAL_SUBJECT],
  );
  console.log(`Лимиты: ${cfg.perUser} на человека в сутки, ${cfg.global} всего в сутки${cfg.off ? ' (ПРОВЕРКА ВЫКЛЮЧЕНА)' : ''}`);
  console.log('\nВсего по дням (вес запросов):');
  if (!total.rows.length) console.log('  записей нет');
  for (const r of total.rows) console.log(`  ${r.day}  ${r.requests}`);

  const top = await sql(
    `SELECT subject, requests FROM public.ai_usage WHERE day = ${today} AND subject <> $1 ORDER BY requests DESC LIMIT 10`,
    [GLOBAL_SUBJECT],
  );
  console.log('\nСегодня, самые активные (последние 4 цифры id):');
  if (!top.rows.length) console.log('  пока никого');
  for (const r of top.rows) console.log(`  …${String(r.subject).slice(-4)}  ${r.requests}${r.requests >= cfg.perUser ? '  ← лимит' : ''}`);
  process.exit(0);
}
main().catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });
