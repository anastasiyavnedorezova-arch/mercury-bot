// Ручная выдача подписки из терминала (на сервере, где работает бот). Из папки приложения:
//   node --env-file=/etc/finnik-prod.env tools/grant.mjs <email | id | telegram_id> <месяцев>
//       только показывает, что получится (ничего не меняет)
//   node --env-file=/etc/finnik-prod.env tools/grant.mjs <email | id | telegram_id> <месяцев> --yes
//       выдаёт подписку: если доступ ещё действует, новый период идёт после него
// Месяцев от 1 до 24. Это не платёж: запись без номера платежа, возврату не подлежит.
// Человеку ничего не отправляется: при необходимости напиши ему сама.
// Для stage используйте /etc/finnik-stage.env.
import { supabase } from '../src/db.js';
import { findAccounts } from '../src/payments/refunds.js';
import { validMonths, planGrant, applyGrant, MAX_GRANT_MONTHS } from '../src/accounts/grantManual.js';

const args = process.argv.slice(2);
const yes = args.includes('--yes');
const positional = args.filter((a) => !a.startsWith('--'));
const msk = (d) => d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const help = () => {
  console.log(`Использование: grant.mjs <email|id|telegram_id> <месяцев 1–${MAX_GRANT_MONTHS}> [--yes]`);
  process.exit(1);
};

async function main() {
  if (positional.length < 2) return help();
  const months = validMonths(positional[1]);
  if (!months) { console.error(`Месяцев должно быть целое число от 1 до ${MAX_GRANT_MONTHS}.`); process.exit(1); }

  const found = await findAccounts(supabase, positional[0]);
  if (!found.length) { console.error('Аккаунт не найден. Попробуй email, полный id или Telegram id.'); process.exit(1); }
  if (found.length > 1) {
    console.error('Найдено несколько аккаунтов, укажи полный id:');
    for (const u of found) console.error(`  ${u.id}  ${u.channel}  ${u.email ?? '-'}  ${u.tg_username ?? ''}`);
    process.exit(1);
  }
  const u = found[0];

  const plan = await planGrant(supabase, u.id, months);
  console.log(`Аккаунт ${u.id} (${u.channel}), ${u.email ?? 'без email'}${u.tg_username ? `, Telegram @${u.tg_username}` : ''}`);
  console.log(`Сейчас доступ: ${plan.current ? `до ${msk(plan.current)}` : 'нет'}`);
  console.log(`Выдаём ${months} мес.: с ${msk(plan.startsAt)} по ${msk(plan.endsAt)}`);
  if (!yes) {
    console.log('\nПока ничего не изменено. Чтобы выдать, повтори эту же команду с --yes в конце.');
    return;
  }
  const r = await applyGrant(supabase, u.id, months);
  console.log(`\nГотово. Подписка выдана до ${msk(r.endsAt)}. Запиши у себя: дата, аккаунт, ${months} мес., причина.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });
