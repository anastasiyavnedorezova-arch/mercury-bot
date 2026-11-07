// Проверка здоровья бота на сервере. Запускается systemd-таймером каждые 5 минут.
// Проверяет: приложение, базу, связь с Telegram и OpenAI (через ретранслятор). При сбое шлёт письмо.
// Письмо идёт через RuSender (российский сервис), а не через Telegram: если сломан путь до Telegram, оповещение всё равно дойдёт.
//   node scripts/healthcheck.mjs              — обычная проверка
//   node scripts/healthcheck.mjs --test-email — отправить тестовое письмо и выйти
//   node scripts/healthcheck.mjs --test-telegram — отправить тестовое сообщение в Telegram (бот оповещений) и выйти
// Каждый получатель и Telegram имеют своё состояние доставки и независимые повторы.
import fs from 'node:fs';
import path from 'node:path';
import { runChecks } from '../src/utils/healthChecks.js';
import { sendTelegramAlert } from '../src/utils/alertTelegram.js';
import { dispatchHealthAlerts, sendHealthTestEmail } from '../src/utils/healthDelivery.js';

const stateDir = process.env.STATE_DIRECTORY || '/var/lib/finnik-health';
const stateFile = process.env.HEALTHCHECK_STATE_FILE || path.join(stateDir, 'state.json');
// Название проекта в сообщениях Telegram: один бот оповещений может обслуживать несколько проектов (ALERT_PROJECT)
const project = (process.env.ALERT_PROJECT || '').trim() || 'Финник';

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { checks: {} }; }
}
function saveState(state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, stateFile);
}

async function main() {
  if (process.argv.includes('--test-email')) {
    const results = await sendHealthTestEmail();
    for (const r of results) console.log('[health] test email:', r.destination || 'no_recipient', r.ok ? 'отправлено' : 'НЕ отправлено');
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  }

  if (process.argv.includes('--test-telegram')) {
    const r = await sendTelegramAlert(`🧪 Проект: ${project}. Тест оповещений. Если ты видишь это сообщение, тревоги будут приходить сюда.`);
    console.log('[health] test telegram:', r.ok ? 'отправлено' : `не отправлено (${r.error})`);
    process.exit(r.ok ? 0 : 1);
  }

  const now = Date.now();
  const prev = loadState();
  const results = await runChecks(process.env);

  for (const r of results) console.log(`[health] ${r.name}: ${r.ok ? 'ok' : 'FAIL — ' + r.detail}`);

  const delivery = await dispatchHealthAlerts(prev, results, now);
  for (const r of delivery.outcomes) {
    if (!r.skipped) console.log(`[health] ${r.destination} (${r.actions.join(', ')}): ${r.ok ? 'отправлено' : 'НЕ отправлено; повтор в следующую проверку'}`);
  }
  if (!delivery.configured) console.error('[health] не настроены получатели оповещений');
  saveState(delivery.state);
  process.exit(results.every((r) => r.ok) && delivery.configured && !delivery.outcomes.some((r) => r.ok === false) ? 0 : 1);
}

main().catch((err) => { console.error('[health] внутренняя ошибка:', err.message); process.exit(2); });
