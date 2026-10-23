import { supabase } from '../db.js';
import { userStates } from '../state.js';
import { notifyAdminAboutFeedback } from '../utils/feedbackNotify.js';
import { findUserIdByExternalId } from '../utils/findUser.js';
import { isValidEmail, normalizeEmail } from '../auth/authCore.js';

const MENU_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]],
  },
};

export const FEEDBACK_ASK_EMAIL_TEXT =
  'Напиши, на какой e-mail тебе ответить 📧\n' +
  'Например: ivan@gmail.com\n' +
  'Он нужен только для ответа на это обращение, в профиль я его не сохраняю.';

export const FEEDBACK_BAD_EMAIL_TEXT =
  'Не похоже на e-mail. Попробуй ещё раз 👇\n' +
  'Например: ivan@gmail.com';

export function feedbackSentText(email) {
  return `Сообщение отправлено ✅\nОтветим на твой e-mail ${email} в течение 24 рабочих часов 💛`;
}

async function getUserEmail(db, userId) {
  if (!userId) return null;
  const { data } = await db.from('users').select('email').eq('id', userId).single();
  const email = normalizeEmail(data?.email ?? '');
  return isValidEmail(email) ? email : null;
}

// Точка входа: /feedback и menu:feedback
export async function showFeedback(bot, chatId, telegramId) {
  userStates.set(telegramId, { awaitingFeedback: true, createdAt: Date.now() });
  await bot.sendMessage(
    chatId,
    'Напиши своё сообщение — я передам его команде Финника 💛\n' +
    'Это может быть вопрос, пожелание или что-то что пошло не так.',
    MENU_KEYBOARD
  );
}

// Сохраняет обращение и уведомляет администратора.
// e-mail для ответа хранится только в самом обращении, в профиль пользователя не пишется.
async function submitFeedback(bot, msg, text, email, db, notify) {
  const telegramId = msg.from.id;
  const userId = await findUserIdByExternalId(db, telegramId);
  if (userId) {
    await db.from('feedback').insert({
      user_id: userId,
      message: `От: ${email}\n\n${text}`,
      status: 'new',
    });
  }

  const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name ?? 'без имени';
  notify({
    source: 'telegram',
    from: `${username} (${telegramId}), e-mail для ответа: ${email}`,
    text,
  }).catch(() => {});

  await bot.sendMessage(msg.chat.id, feedbackSentText(email), MENU_KEYBOARD);
}

// Обработчик текста (вызывается из handleMessage)
export async function handleFeedbackMessage(bot, msg, db = supabase, notify = notifyAdminAboutFeedback) {
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;

  const state = userStates.get(telegramId);
  if (!state?.awaitingFeedback && !state?.awaitingFeedbackEmail) return false;

  const text = msg.text;
  if (!text) {
    await bot.sendMessage(chatId, 'Отправь текстовое сообщение 🙏');
    return true;
  }

  // Шаг 2: у пользователя нет e-mail — ждём адрес для ответа
  if (state.awaitingFeedbackEmail) {
    const email = normalizeEmail(text);
    if (!isValidEmail(email)) {
      await bot.sendMessage(chatId, FEEDBACK_BAD_EMAIL_TEXT, MENU_KEYBOARD);
      return true;
    }
    userStates.delete(telegramId);
    await submitFeedback(bot, msg, state.feedbackText, email, db, notify);
    return true;
  }

  // Шаг 1: само сообщение
  const userId = await findUserIdByExternalId(db, telegramId);
  const email = await getUserEmail(db, userId);
  if (!email) {
    userStates.set(telegramId, { awaitingFeedbackEmail: true, feedbackText: text, createdAt: Date.now() });
    await bot.sendMessage(chatId, FEEDBACK_ASK_EMAIL_TEXT, MENU_KEYBOARD);
    return true;
  }

  userStates.delete(telegramId);
  await submitFeedback(bot, msg, text, email, db, notify);
  return true;
}
