import { queryOne, run } from '../db.js';
import { userStates } from '../state.js';

const MENU_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]],
  },
};

async function getUserId(telegramId) {
  const { data } = await queryOne(
    `SELECT id FROM users WHERE external_id = $1 AND channel = 'telegram'`,
    [String(telegramId)]
  );
  return data?.id ?? null;
}

export async function showFeedback(bot, chatId, telegramId) {
  userStates.set(telegramId, { awaitingFeedback: true });
  await bot.sendMessage(
    chatId,
    'Напиши своё сообщение — я передам его команде Меркури 💛\n' +
    'Это может быть вопрос, пожелание или что-то что пошло не так.'
  );
}

export async function handleFeedbackMessage(bot, msg) {
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;

  const state = userStates.get(telegramId);
  if (!state?.awaitingFeedback) return false;

  const text = msg.text;
  if (!text) {
    await bot.sendMessage(chatId, 'Отправь текстовое сообщение 🙏');
    return true;
  }

  userStates.delete(telegramId);

  const userId = await getUserId(telegramId);
  if (userId) {
    await run(
      `INSERT INTO feedback (user_id, message, status) VALUES ($1, $2, 'new')`,
      [userId, text]
    );
  }

  const adminId = process.env.ADMIN_TELEGRAM_ID;
  if (adminId) {
    const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name ?? 'без имени';
    await bot.sendMessage(
      adminId,
      `📩 Новый фидбек от ${username} (${telegramId}):\n\n${text}`
    ).catch(err => console.error('Admin notify error:', err.message));
  }

  await bot.sendMessage(
    chatId,
    'Сообщение отправлено ✅\nОбычно отвечаем в течение 24 часов 💛',
    MENU_KEYBOARD
  );

  return true;
}
