// Промокоды из терминала (на сервере, где работает бот). Из папки приложения:
//   node --env-file=/etc/finnik-prod.env tools/promo.mjs list
//   node --env-file=/etc/finnik-prod.env tools/promo.mjs create FINNIK200 --off 200 --max 50 --until 2026-12-31 --note "осенняя акция"
//   node --env-file=/etc/finnik-prod.env tools/promo.mjs off FINNIK200      (выключить)
//   node --env-file=/etc/finnik-prod.env tools/promo.mjs on FINNIK200       (включить обратно)
// Параметры create: --off скидка в ₽ (обязательно), --max сколько раз всего (без него — без лимита),
//   --per-user сколько раз один человек (по умолчанию 1), --until последний день действия (ГГГГ-ММ-ДД, по Москве), --note заметка.
// Для stage используйте /etc/finnik-stage.env.
import { supabase } from '../src/db.js';
import { createPromo, setPromoActive, listPromos, describePromo } from '../src/payments/promoAdmin.js';

const [, , cmd, ...rest] = process.argv;
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i].startsWith('--')) { flags[rest[i].slice(2)] = rest[i + 1]; i += 1; } else positional.push(rest[i]);
}
const help = () => {
  console.log('Команды: list | create КОД --off 200 [--max 50] [--per-user 1] [--until 2026-12-31] [--note "текст"] | off КОД | on КОД');
  process.exit(1);
};

async function main() {
  if (cmd === 'list') {
    const rows = (await listPromos(supabase)).map((p) => describePromo(p));
    if (!rows.length) return console.log('Промокодов пока нет.');
    console.log(['КОД', 'СКИДКА', 'ИСПОЛЬЗОВАНО', 'НА ЧЕЛОВЕКА', 'ДО', 'СТАТУС', 'ЗАМЕТКА'].join('\t'));
    for (const r of rows) console.log([r.code, r.off, r.used, r.perUser, r.until, r.status, r.note].join('\t'));
    return undefined;
  }
  if (cmd === 'create') {
    const r = await createPromo(supabase, { code: positional[0], off: flags.off, max: flags.max, perUser: flags['per-user'], until: flags.until, note: flags.note });
    if (!r.ok) { console.error('Ошибка:', r.error); process.exit(1); }
    const d = describePromo({ ...r.promo, used: 0 });
    console.log(`Готово. Код ${d.code}: скидка ${d.off}, использований ${d.used}, на человека ${d.perUser}, до: ${d.until}.`);
    if (r.promo.max_uses == null) console.log('Внимание: лимита использований нет. Задать лимит можно при создании: --max 50');
    return undefined;
  }
  if (cmd === 'off' || cmd === 'on') {
    const r = await setPromoActive(supabase, positional[0], cmd === 'on');
    if (!r.ok) { console.error('Ошибка:', r.error); process.exit(1); }
    console.log(`Код ${r.promo.code} ${cmd === 'on' ? 'включён' : 'выключен'}.`);
    return undefined;
  }
  return help();
}

main().then(() => process.exit(0)).catch((e) => { console.error('Ошибка:', e.message); process.exit(1); });
