// Проверка здоровья бота на сервере. Запускается systemd-таймером каждые 5 минут.
// Проверяет: приложение, базу, связь с Telegram и OpenAI (через ретранслятор). При сбое шлёт письмо.
// Письмо идёт через RuSender (российский сервис), а не через Telegram: если сломан путь до Telegram, оповещение всё равно дойдёт.
//   node scripts/healthcheck.mjs              — обычная проверка
//   node scripts/healthcheck.mjs --test-email — отправить тестовое письмо и выйти
//   node scripts/healthcheck.mjs --test-telegram — отправить тестовое сообщение в Telegram (бот оповещений) и выйти
// Тревога уходит двумя путями сразу: письмом и в Telegram. Считается доставленной, если дошёл хотя бы один путь.
import fs from 'node:fs';
import path from 'node:path';
import { runChecks } from '../src/utils/healthChecks.js';
import { evaluate, revertOnSendFailure, buildEmail, buildTelegramText } from '../src/utils/healthLogic.js';
import { sendEmail } from '../src/utils/email.js';
import { alertConfigured, sendTelegramAlert } from '../src/utils/alertTelegram.js';

const stateDir = process.env.STATE_DIRECTORY || '/var/lib/finnik-health';
const stateFile = process.env.HEALTHCHECK_STATE_FILE || path.join(stateDir, 'state.json');
const to = process.env.ADMIN_NOTIFY_EMAIL || process.env.MAIL_FROM_EMAIL;
// Название проекта в сообщениях Telegram: один бот оповещений может обслуживать несколько проектов (ALERT_PROJECT)
const project = (process.env.ALERT_PROJECT || '').trim() || 'Финник';

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { checks: {} }; }
}
function saveState(state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, stateFile);
}

async function main() {
  if (process.argv.includes('--test-email')) {
    if (!to) { console.error('[health] нет адреса: задайте ADMIN_NOTIFY_EMAIL или MAIL_FROM_EMAIL'); process.exit(1); }
    const r = await sendEmail({
      to,
      subject: '🧪 Финник: тест оповещений',
      text: 'Это тестовое письмо проверки здоровья бота. Если вы его видите, оповещения будут доходить.',
    });
    console.log('[health] test email:', r.ok ? 'отправлено' : `не отправлено (${r.error || r.status || 'skipped'})`);
    process.exit(r.ok ? 0 : 1);
  }

  if (process.argv.includes('--test-telegram')) {
    const r = await sendTelegramAlert(`🧪 Проект: ${project}. Тест оповещений. Если ты видишь это сообщение, тревоги будут приходить сюда.`);
    console.log('[health] test telegram:', r.ok ? 'отправлено' : `не отправлено (${r.error})`);
    process.exit(r.ok ? 0 : 1);
  }

  const now = Date.now();
  const prev = loadState();
  const results = await runChecks(process.env);
  const { state, actions } = evaluate(prev, results, now);

  for (const r of results) console.log(`[health] ${r.name}: ${r.ok ? 'ok' : 'FAIL — ' + r.detail}`);

  let finalState = state;
  if (actions.length) {
    const mail = buildEmail(actions, now);
    const what = actions.map((a) => a.kind + ':' + a.name).join(', ');
    const [r, tg] = await Promise.all([
      to ? sendEmail({ to, ...mail }) : Promise.resolve({ ok: false, error: 'no_recipient' }),
      alertConfigured() ? sendTelegramAlert(buildTelegramText(actions, now, project)) : Promise.resolve({ ok: false, skipped: true, error: 'не настроен' }),
    ]);
    console.log(`[health] письмо (${what}): ${r.ok ? 'отправлено' : 'НЕ отправлено (' + (r.error || r.status || 'skipped') + ')'}`);
    console.log(`[health] Telegram (${what}): ${tg.ok ? 'отправлено' : tg.skipped ? 'пропущено (не настроен)' : 'НЕ отправлено (' + tg.error + ')'}`);
    if (!r.ok && !tg.ok) finalState = revertOnSendFailure(prev, state, actions);
  }
  saveState(finalState);
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}

main().catch((err) => { console.error('[health] внутренняя ошибка:', err.message); process.exit(2); });
