import cron from 'node-cron';
import {
  checkBudgetReminders,
  checkActivityReminders,
  checkBudgetAlerts,
  checkTrialEnding,
  checkSubscriptionEnding,
} from './index.js';
import { sendMonthlyAnalytics } from '../handlers/analytics.js';

async function runDailyChecks(bot) {
  console.log('[scheduler] Daily checks started at:',
    new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }));

  const checks = [
    checkBudgetReminders,
    checkActivityReminders,
    checkBudgetAlerts,
    checkTrialEnding,
    checkSubscriptionEnding,
  ];

  for (const check of checks) {
    try {
      await check(bot);
    } catch (err) {
      console.error(`[scheduler] Error in ${check.name}:`, err.message);
    }
  }

  console.log('[scheduler] Daily checks done');
}

async function runMonthlyAnalytics(bot) {
  console.log('[scheduler] Running monthly analytics...');
  await sendMonthlyAnalytics(bot).catch(e => console.error('[sendMonthlyAnalytics]', e.message));
  console.log('[scheduler] Monthly analytics done');
}

export function startScheduler(bot) {
  // Ежедневные проверки в 10:00 МСК
  cron.schedule('0 10 * * *', () => {
    console.log('[scheduler] Running daily checks...');
    runDailyChecks(bot);
  }, { timezone: 'Europe/Moscow' });

  // Аналитика 1-го числа в 10:00 МСК
  cron.schedule('0 10 1 * *', () => {
    console.log('[scheduler] Running monthly analytics...');
    runMonthlyAnalytics(bot);
  }, { timezone: 'Europe/Moscow' });

  console.log('[scheduler] Started');
}
