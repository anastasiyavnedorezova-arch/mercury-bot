// Возвраты из терминала (на сервере, где работает бот). Из папки приложения:
//   node --env-file=/etc/finnik-prod.env tools/refund.mjs calc <email | id | telegram_id>
//       показывает оплаченные периоды человека, сколько вернуть по оферте (п. 6.3) и какие возвраты уже сделаны в ЮKassa
//   node --env-file=/etc/finnik-prod.env tools/refund.mjs cancel <email | id | telegram_id> --payment <номер платежа> [--free-promo] [--force] [--no-check]
//       ПОСЛЕ того как деньги возвращены в кабинете ЮKassa: прекращает этот оплаченный период (доступ заканчивается сейчас)
//       --free-promo  вернуть промокод (убрать использование этого платежа из счётчика)
//       --force       отменить, даже если у человека есть оплаченные периоды после этого (возможен перерыв в доступе)
//       --no-check    не сверять с ЮKassa (только если API недоступен, а деньги точно возвращены)
// Для stage используйте /etc/finnik-stage.env.
import { supabase } from '../src/db.js';
import { listRefunds, yookassaConfigured } from '../src/payments/yookassa.js';
import { calcRefundable, findAccounts, paidSubscriptions, cancelAfterRefund } from '../src/payments/refunds.js';

const [, , cmd, ...rest] = process.argv;
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i] === '--payment') { flags.payment = rest[i + 1]; i += 1; } else if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = true; else positional.push(rest[i]);
}
const msk = (iso) => new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const help = () => {
  console.log('Команды: calc <email|id|telegram_id> | cancel <email|id|telegram_id> --payment <номер> [--free-promo] [--force] [--no-check]');
  process.exit(1);
};

async function pickAccount(query) {
  const found = await findAccounts(supabase, query);
  if (!found.length) { console.error('Аккаунт не найден. Попробуй email, полный id или Telegram id.'); process.exit(1); }
  if (found.length > 1) {
    console.error('Найдено несколько аккаунтов, укажи полный id:');
    for (const u of found) console.error(`  ${u.id}  ${u.channel}  ${u.email ?? '-'}  ${u.tg_username ?? ''}`);
    process.exit(1);
  }
  return found[0];
}

async function main() {
  if (!positional[0]) return help();
  if (cmd === 'calc') {
    const u = await pickAccount(positional[0]);
    console.log(`Аккаунт ${u.id} (${u.channel}), ${u.email ?? 'без email'}`);
    const rows = await paidSubscriptions(supabase, u.id);
    if (!rows.length) return console.log('Оплаченных периодов нет.');
    const now = new Date();
    for (const r of rows) {
      const c = calcRefundable(r, now);
      console.log('');
      console.log(`Платёж ${r.payment_id}: статус ${r.status}, ${r.period_months ?? '?'} мес., уплачено ${c.paid} ₽`);
      console.log(`  Срок: ${msk(r.starts_at)} — ${msk(r.ends_at)} (${c.totalDays} дн.), не использовано полных дней: ${c.unusedDays}`);
      console.log(`  К возврату по оферте п. 6.3: ${r.status === 'refunded' ? '0 (уже отменена)' : `${c.amount.toFixed(2)} ₽`}`);
      if (yookassaConfigured()) {
        const lr = await listRefunds(r.payment_id);
        if (!lr.ok) console.log(`  Возвраты в ЮKassa: не удалось получить (${lr.reason})`);
        else if (!lr.refunds.length) console.log('  Возвраты в ЮKassa: нет');
        else for (const x of lr.refunds) console.log(`  Возврат в ЮKassa: ${x.amount.toFixed(2)} ₽, ${x.status}`);
      }
    }
    return console.log('\nСумму возврата ты вводишь в кабинете ЮKassa сама (можно меньше расчётной, например при сбое по нашей вине). Затем: tools/refund.mjs cancel ... --payment <номер>');
  }
  if (cmd === 'cancel') {
    if (!flags.payment) { console.error('Укажи номер платежа: --payment <номер>'); process.exit(1); }
    const u = await pickAccount(positional[0]);
    const r = await cancelAfterRefund(supabase, {
      userId: u.id, paymentId: flags.payment, fetchRefunds: (id) => listRefunds(id),
      freePromo: !!flags['free-promo'], force: !!flags.force, noCheck: !!flags['no-check'],
    });
    if (r.ok) {
      console.log(`Готово. Период по платежу ${flags.payment} прекращён, доступ закончился сейчас. Возвращено в ЮKassa: ${r.refunded ? `${r.refunded.toFixed(2)} ₽` : 'не проверялось'}.`);
      if (flags['free-promo']) console.log(r.freedPromo ? 'Промокод освобождён.' : 'Промокод освободить не удалось (или он не использовался).');
      return undefined;
    }
    const msg = {
      not_found: 'Платёж не найден у этого аккаунта. Проверь номер и аккаунт (calc покажет номера).',
      already: 'Этот период уже отменён.',
      no_refund: 'В ЮKassa нет успешного возврата по этому платежу. Сначала верни деньги в кабинете ЮKassa.',
      check_failed: `Не удалось проверить возврат в ЮKassa (${r.detail}). Повтори позже или добавь --no-check, если деньги точно возвращены.`,
      later_periods: `У человека есть ещё ${r.detail} оплаченных периода, которые начинаются позже. После отмены будет перерыв в доступе. Добавь --force, если так и нужно.`,
      db: `Ошибка базы: ${r.detail}`,
    }[r.reason] ?? r.reason;
    console.error(`Не сделано: ${msg}`);
    process.exit(1);
  }
  return help();
}

main().then(() => process.exit(0)).catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });
