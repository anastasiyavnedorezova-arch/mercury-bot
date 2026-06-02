import { queryOne, run } from '../db.js';
import { showConsentScreen } from './onboarding.js';
import { showMainMenu } from './menu.js';

const BOT_START_TIME = Math.floor(Date.now() / 1000);

export async function handleStart(bot, msg) {
  if (msg.date < BOT_START_TIME) return;
  const telegramId = String(msg.from.id);
  const chatId = msg.chat.id;
  const username = msg.from.username || msg.from.first_name || telegramId;

  const { data: existing, error: lookupError } = await queryOne(
    `SELECT id, terms_accepted_at FROM users
     WHERE external_id = $1 AND channel = 'telegram'`,
    [telegramId]
  );

  if (lookupError) {
    console.error('[start] DB error looking up user:', telegramId, lookupError.message);
    await bot.sendMessage(chatId, 'Произошла ошибка. Попробуй ещё раз позже 🙏');
    return;
  }

  if (!existing) {
    console.log('[start] New user, inserting:', telegramId);
    await run(
      `INSERT INTO users (external_id, channel, username) VALUES ($1, 'telegram', $2)`,
      [telegramId, username]
    );
    await showConsentScreen(bot, chatId);
    return;
  }

  console.log('[start] Existing user found:', telegramId, 'terms_accepted_at:', existing.terms_accepted_at);

  await run(
    `UPDATE users SET username = $1, last_active_at = NOW()
     WHERE external_id = $2 AND channel = 'telegram'`,
    [username, telegramId]
  );

  if (!existing.terms_accepted_at) {
    await showConsentScreen(bot, chatId);
    return;
  }

  await showMainMenu(bot, chatId);
}
