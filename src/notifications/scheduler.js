import cron from 'node-cron';
import {
  checkBudgetReminders,
  checkActivityReminders,
  checkBudgetAlerts,
  checkTrialEnding,
  checkSubscriptionEnding,
} from './index.js';
import { sendMonthlyAnalytics } from '../handlers/analytics.js';
import { supabase } from '../db.js';

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

  // Очистка удалённых аккаунтов в 03:00 UTC
  cron.schedule('0 3 * * *', async () => {
    console.log('[cleanup] Checking for accounts to purge...');
    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const { data: toDelete, error } = await supabase
        .from('users')
        .select('id')
        .eq('status', 'deleted')
        .lt('deleted_at', thirtyDaysAgo.toISOString());

      if (error) throw error;
      if (!toDelete?.length) {
        console.log('[cleanup] No accounts to purge.');
        return;
      }

      for (const user of toDelete) {
        await supabase.from('transactions').delete().eq('user_id', user.id);
        await supabase.from('goals').delete().eq('user_id', user.id);
        await supabase.from('budget').delete().eq('user_id', user.id);
        console.log('[cleanup] Purged data for user:', user.id);
      }
    } catch (err) {
      console.error('[cleanup] Error:', err.message);
    }
  });

  console.log('[scheduler] Started');
}
