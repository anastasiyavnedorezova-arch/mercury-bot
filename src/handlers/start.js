import { queryOne, run } from '../db.js';
import { showConsentScreen } from './onboarding.js';
import { showMainMenu } from './menu.js';

const BOT_START_TIME = Math.floor(Date.now() / 1000);

export async function handleStart(bot, msg) {
  if (msg.date < BOT_START_TIME) return;
  const telegramId = String(msg.from.id);
  const chatId = msg.chat.id;
  const username = msg.from.username || msg.from.first_name || telegramId;

  const { data: existing } = await queryOne(
    `SELECT id, terms_accepted_at FROM users
     WHERE external_id = $1 AND channel = 'telegram'`,
    [telegramId]
  );

  if (!existing) {
    await run(
      `INSERT INTO users (external_id, channel, username) VALUES ($1, 'telegram', $2)`,
      [telegramId, username]
    );
    await showConsentScreen(bot, chatId);
    return;
  }

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
