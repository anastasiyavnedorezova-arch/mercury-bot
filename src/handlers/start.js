import { supabase } from '../db.js';
import { showConsentScreen } from './onboarding.js';
import { showMainMenu } from './menu.js';

const BOT_START_TIME = Math.floor(Date.now() / 1000);

export async function handleStart(bot, msg) {
  // Игнорируем обновления, которые пришли до запуска бота (накопленные в очереди)
  if (msg.date < BOT_START_TIME) return;
  const telegramId = String(msg.from.id);
  const chatId = msg.chat.id;
  const username = msg.from.username || msg.from.first_name || telegramId;

  const { data: existing } = await supabase
    .from('users')
    .select('id, terms_accepted_at')
    .eq('external_id', telegramId)
    .eq('channel', 'telegram')
    .single();

  if (!existing) {
    await supabase.from('users').insert({
      external_id: telegramId,
      channel: 'telegram',
      username,
    });
    await showConsentScreen(bot, chatId);
    return;
  }

  // Обновляем username и last_active_at при каждом /start
  await supabase
    .from('users')
    .update({ username, last_active_at: new Date().toISOString() })
    .eq('external_id', telegramId)
    .eq('channel', 'telegram');

  if (!existing.terms_accepted_at) {
    await showConsentScreen(bot, chatId);
    return;
  }

  // Пользователь уже принял согласие — показываем главное меню
  await showMainMenu(bot, chatId);
}
