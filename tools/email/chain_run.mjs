// Ручной прогон цепочки писем: показывает, кому и какое письмо ушло бы (по умолчанию ничего не отправляет).
//   node --env-file=/etc/finnik-stage.env tools/email/chain_run.mjs [--now 2026-10-20T12:00:00+03:00] [--mode dry|on]
// --now  — «притвориться», что сейчас другое время (проверить, что будет через несколько дней)
// --mode on — реально отправить; без LETTERS_ONLY_TO в окружении не запустится (защита от рассылки всем)
import { supabase } from '../../src/db.js';
import { runChain } from '../../src/emails/chain.js';
import * as config from '../../src/emails/config.js';

const args = process.argv.slice(2);
const val = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const mode = val('--mode') ?? 'dry';
const nowArg = val('--now');
const now = nowArg ? new Date(nowArg) : new Date();
if (Number.isNaN(now.getTime())) { console.error('Не понял дату в --now'); process.exit(1); }
if (!['dry', 'on'].includes(mode)) { console.error('--mode: dry или on'); process.exit(1); }
if (mode === 'on' && !config.lettersOnlyTo()) {
  console.error('Реальная отправка только при заданном LETTERS_ONLY_TO (список адресов-получателей).');
  process.exit(1);
}

console.log(`Время: ${now.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК · режим: ${mode}`);
console.log(`LETTERS_CHAIN_START: ${config.chainStart()?.toISOString() ?? 'не задан (все аккаунты считаются старыми)'}`);
console.log(`Ссылки оплаты: ${config.paymentsReady() ? 'готовы (или разрешено без них)' : 'НЕ готовы — письма с кнопками «Оплатить» пропускаются'}`);
const only = config.lettersOnlyTo();
console.log(`Только на адреса: ${only ? [...only].join(', ') : 'не ограничено'}`);

const res = await runChain(supabase, { now, mode, pauseMs: 500 });
console.log(`\nПользователей в проверке: ${res.users}`);
if (!res.planned.length) console.log('Писем к отправке нет.');
for (const p of res.planned) console.log(`  ${p.key.padEnd(12)} → ${p.email}  (${p.why})${p.result ? `  [не ушло: ${p.result}]` : ''}`);
if (mode === 'on') console.log(`Отправлено: ${res.sent}, не удалось: ${res.failed}`);
await supabase.end?.();
process.exit(0);
