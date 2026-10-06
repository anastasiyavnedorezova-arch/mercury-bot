import { supabase } from '../db.js';
import { userStates } from '../state.js';
import { notifyAdminAboutFeedback } from '../utils/feedbackNotify.js';

const MENU_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]],
  },
};

async function getUserId(telegramId) {
  const { data } = await supabase
    .from('users')
    .select('id')
    .eq('external_id', String(telegramId))
    .single();
  return data?.id ?? null;
}

// Точка входа: /feedback и menu:feedback
export async function showFeedback(bot, chatId, telegramId) {
  userStates.set(telegramId, { awaitingFeedback: true });
  await bot.sendMessage(
    chatId,
    'Напиши своё сообщение — я передам его команде Финника 💛\n' +
    'Это может быть вопрос, пожелание или что-то что пошло не так.'
  );
}

// Обработчик текста (вызывается из handleMessage)
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
    await supabase.from('feedback').insert({
      user_id: userId,
      message: text,
      status: 'new',
    });
  }

  const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name ?? 'без имени';
  notifyAdminAboutFeedback({ source: 'telegram', from: `${username} (${telegramId})`, text })
    .catch(() => {});

  await bot.sendMessage(
    chatId,
    'Сообщение отправлено ✅\nОбычно отвечаем в течение 24 часов 💛',
    MENU_KEYBOARD
  );

  return true;
}
