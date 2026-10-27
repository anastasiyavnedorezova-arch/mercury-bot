// «Научи бота» (патч 50): вопрос после ручной записи и обработка ответа человека. Сигналы пишутся в recognition_signals
// и сразу уходят администратору в Telegram. Бонус за обучение пока не начисляется.
import { supabase } from '../db.js';
import { getRealBot } from '../realBot.js';
import { findUserIdByExternalId } from '../utils/findUser.js';
import {
  analyzePhrase, phraseKey, LEARN_ASK_TEXT, LEARN_THANKS_TEXT, LEARN_DECLINED_TEXT, learnKeyboard,
} from '../utils/learnSignal.js';

const MENU_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]],
  },
};

// Текст сигнала для администратора
export function learnSignalText({ phrase, amount, type, category, reason, from }) {
  const kind = type === 'income' ? 'доход' : 'расход';
  return '✍️ Обучить бота\n' +
    `Фраза: «${String(phrase).slice(0, 500)}»\n` +
    `Сумма: ${amount} ₽\n` +
    `Категорию выбрал человек: ${category} (${kind})\n` +
    `Что сказал ИИ: ${reason || '—'}\n` +
    `Пользователь: ${from}`;
}

// Сообщение администратору. Никогда не бросает исключение.
export async function notifyAdminAboutLearnSignal(signal) {
  try {
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (!adminId) return false;
    await getRealBot().sendMessage(adminId, learnSignalText(signal));
    return true;
  } catch (err) {
    console.error('[learn] notify error:', err.message);
    return false;
  }
}

// После ручной записи: если фраза заслуживает вопроса, спрашиваем. Никогда не бросает исключение.
// learn — { text, reason } из памяти (то, что бот не распознал); parsed — запись, которую человек выбрал сам.
export async function maybeAskToLearn(bot, chatId, { userId, learn, parsed }, db = supabase) {
  try {
    if (!learn?.text || !userId) return 'skip:no_context';
    const check = analyzePhrase(learn.text, learn.reason);
    if (!check.ok) {
      console.log('[learn] не спрашиваем:', check.why, JSON.stringify(learn.text));
      return `skip:${check.why}`;
    }
    const key = phraseKey(learn.text);
    // Эту фразу уже передавали (любой человек) или тот же человек уже отвечал на неё: второй раз не спрашиваем
    const { data: sentRows } = await db.from('recognition_signals').select('id').eq('phrase_norm', key).eq('answer', 'sent').limit(1);
    if (sentRows?.length) return 'skip:already_sent';
    const { data: mineRows } = await db.from('recognition_signals').select('id').eq('phrase_norm', key).eq('user_id', userId).limit(1);
    if (mineRows?.length) return 'skip:already_asked';

    const { data: row, error } = await db.from('recognition_signals').insert({
      user_id: userId,
      phrase: learn.text.trim().slice(0, 300),
      phrase_norm: key,
      ai_reason: learn.reason ?? null,
      type: parsed.type,
      category: parsed.category,
      amount: parsed.amount,
    }).select('id').single();
    if (error || !row) {
      console.error('[learn] insert error:', error?.message);
      return 'error';
    }
    await bot.sendMessage(chatId, LEARN_ASK_TEXT(learn.text.trim().slice(0, 100)), learnKeyboard(row.id));
    return 'asked';
  } catch (err) {
    console.error('[learn] ask error:', err.message);
    return 'error';
  }
}

// Кнопки «Да, передать» / «Нет, не надо»: learn:yes:<id>, learn:no:<id>
export async function handleLearnCallback(bot, query, db = supabase, notify = notifyAdminAboutLearnSignal) {
  const chatId = query.message.chat.id;
  const telegramId = query.from.id;
  const [, choice, signalId] = String(query.data).split(':');

  await bot.answerCallbackQuery(query.id);
  if (!signalId || (choice !== 'yes' && choice !== 'no')) return;

  const userId = await findUserIdByExternalId(db, telegramId);
  if (!userId) return;

  // Меняем только ещё не отвеченный вопрос этого же человека: повторное нажатие ничего не делает
  const { data: rows, error } = await db.from('recognition_signals')
    .update({ answer: choice === 'yes' ? 'sent' : 'declined', answered_at: new Date().toISOString() })
    .eq('id', signalId)
    .eq('user_id', userId)
    .eq('answer', 'asked')
    .select('id, phrase, type, category, amount, ai_reason');
  if (error) {
    console.error('[learn] update error:', error.message);
    return;
  }
  const row = rows?.[0];
  if (!row) return;

  if (choice === 'no') {
    await bot.sendMessage(chatId, LEARN_DECLINED_TEXT, MENU_KEYBOARD);
    return;
  }

  const { data: u } = await db.from('users').select('tg_username, external_id, channel, email').eq('id', userId).maybeSingle();
  // Из веб-чата кабинета (на сайте) человек отвечает так же, как в Telegram: у него вместо Telegram id почта
  const from = u?.channel && u.channel !== 'telegram'
    ? `сайт, ${u.email ?? `id ${u.external_id}`}`
    : `${u?.tg_username ? `${u.tg_username}, ` : ''}Telegram id ${u?.external_id ?? telegramId}`;
  await notify({
    phrase: row.phrase, amount: Number(row.amount), type: row.type, category: row.category, reason: row.ai_reason, from,
  });
  await bot.sendMessage(chatId, LEARN_THANKS_TEXT, MENU_KEYBOARD);
}
