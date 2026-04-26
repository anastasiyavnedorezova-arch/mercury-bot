import OpenAI from 'openai';
import 'dotenv/config';
import { supabase } from '../db.js';
import { getSystemPrompt } from '../prompts/system_prompt.js';
import { userStates } from '../state.js';
import { requireTerms } from './onboarding.js';
import { getUserAccess } from '../utils/access.js';
import { handleTxEditState } from './transaction.js';
import { handleGoalState } from './goal.js';
import { handleBudgetState } from './budget.js';
import { handleHistoryState } from './history.js';
import { handleFeedbackMessage } from './feedback.js';
import { handleSubscriptionEmailState } from './subscription.js';
import { handleCategoryNameState } from './categories.js';
import { handleFileConfirmation } from './fileUpload.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TYPE_RU = {
  expense: 'расход',
  income: 'доход',
  goal: 'цель',
};

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
    .eq('channel', 'telegram')
    .single();
  return data?.id ?? null;
}

async function getCategoryId(name) {
  const { data } = await supabase
    .from('categories')
    .select('id')
    .eq('name', name)
    .single();
  return data?.id ?? null;
}

export async function saveTransaction(userId, parsed, rawMessage) {
  const categoryId = await getCategoryId(parsed.category);
  const { data } = await supabase.from('transactions').insert({
    user_id: userId,
    type: parsed.type,
    amount: parsed.amount,
    category_id: categoryId,
    comment: parsed.comment ?? null,
    transaction_date: parsed.transaction_date,
    raw_message: rawMessage,
  }).select('id').single();
  return data?.id ?? null;
}

function buildConfirmationText(parsed) {
  return (
    `Записал ✅\n` +
    `📅 Дата: ${parsed.transaction_date}\n` +
    `📌 Тип: ${TYPE_RU[parsed.type] ?? parsed.type}\n` +
    `📂 Категория: ${parsed.category}\n` +
    `💸 Сумма: ${parsed.amount} ₽`
  );
}

async function sendConfirmation(bot, chatId, parsed, txId, access) {
  let keyboard;
  if (txId && (access === 'trial' || access === 'active')) {
    keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✏️ Исправить', callback_data: `tx:edit:${txId}` },
            { text: '🗑 Удалить', callback_data: `tx:delete:${txId}` },
          ],
          [{ text: '☰ Главное меню', callback_data: 'menu:main' }],
        ],
      },
    };
  } else {
    keyboard = MENU_KEYBOARD;
  }
  await bot.sendMessage(chatId, buildConfirmationText(parsed), keyboard);
}

async function callLLM(userText, userCategories = []) {
  const today = new Date().toISOString().split('T')[0];
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: getSystemPrompt(userCategories) },
      { role: 'user', content: `Сегодня ${today}. ${userText}` },
    ],
    temperature: 0,
  });
  return JSON.parse(response.choices[0].message.content.trim());
}

function inlineKeyboard(options) {
  const rows = [];
  for (let i = 0; i < options.length; i += 2) {
    rows.push(
      options.slice(i, i + 2).map((opt) => ({ text: opt, callback_data: opt }))
    );
  }
  return { inline_keyboard: rows };
}

async function processAndSave(bot, chatId, telegramId, parsed, rawMessage) {
  const userId = await getUserId(telegramId);
  if (!userId) {
    await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start для регистрации.');
    return;
  }

  const access = await getUserAccess(userId);
  console.log(`[access] telegramId=${telegramId} userId=${userId} access=${access}`);

  if (Array.isArray(parsed)) {
    for (const item of parsed) await saveTransaction(userId, item, rawMessage);
    const text = parsed.map(buildConfirmationText).join('\n\n');
    await bot.sendMessage(chatId, text, MENU_KEYBOARD);
  } else {
    const txId = await saveTransaction(userId, parsed, rawMessage);
    await sendConfirmation(bot, chatId, parsed, txId, access);
  }
}

export async function handleCategorySelection(bot, chatId, telegramId, category) {
  const state = userStates.get(telegramId);
  if (!state?.awaitingCategory) return false;
  userStates.delete(telegramId);

  const userId = await getUserId(telegramId);
  if (!userId) {
    await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start для регистрации.');
    return true;
  }

  if (!state.amount) {
    await bot.sendMessage(chatId, 'Не смог определить сумму. Попробуй написать заново 🤔');
    return true;
  }

  const access = await getUserAccess(userId);
  const parsed = {
    type: state.type ?? 'expense',
    amount: state.amount,
    category,
    comment: null,
    transaction_date: state.transaction_date ?? new Date().toISOString().split('T')[0],
  };

  const txId = await saveTransaction(userId, parsed, state.rawMessage);
  await sendConfirmation(bot, chatId, parsed, txId, access);
  return true;
}

export async function handleMessage(bot, msg) {
  const text = msg.text;
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;

  // Жёсткая блокировка: без согласия не обрабатываем ничего
  if (await requireTerms(bot, telegramId, chatId)) return;

  // Состояние подтверждения загруженной выписки
  if (await handleFileConfirmation(bot, msg)) return;

  // Состояние редактирования транзакции (Исправить → поле → текст)
  if (await handleTxEditState(bot, msg)) return;

  // Состояние диалога создания финансовой цели
  if (await handleGoalState(bot, msg)) return;

  // Состояние ввода бюджета
  if (await handleBudgetState(bot, msg)) return;

  // Состояние ввода дат для истории
  if (await handleHistoryState(bot, msg)) return;

  // Состояние ввода фидбека
  if (await handleFeedbackMessage(bot, msg)) return;

  // Состояние ввода email для оплаты подписки
  if (await handleSubscriptionEmailState(bot, msg)) return;

  // Состояние ввода названия пользовательской категории
  if (await handleCategoryNameState(bot, msg)) return;

  // Проверяем ожидающее состояние (например, выбор категории для WB текстом)
  const state = userStates.get(telegramId);
  if (state?.awaitingCategory) {
    await handleCategorySelection(bot, chatId, telegramId, text);
    return;
  }

  // Обычный поток
  let parsed;
  try {
    const userId = await getUserId(telegramId);
    let userCategories = [];
    if (userId) {
      const { data } = await supabase
        .from('categories')
        .select('name, type')
        .eq('user_id', userId)
        .eq('is_active', true);
      userCategories = data ?? [];
    }
    parsed = await callLLM(text, userCategories);
  } catch (err) {
    console.error('OpenAI error:', err.message);
    await bot.sendMessage(chatId, 'Ошибка при обработке сообщения. Попробуй ещё раз 🙏');
    return;
  }

  if (!Array.isArray(parsed) && parsed.error) {
    if (parsed.error === 'clarification_needed' && parsed.clarification_type === 'wb_category') {
      userStates.set(telegramId, {
        awaitingCategory: true,
        clarificationType: 'wb_category',
        rawMessage: text,
        amount: parsed.amount ?? null,
        type: parsed.type ?? 'expense',
        transaction_date: parsed.transaction_date ?? new Date().toISOString().split('T')[0],
      });
      const options = parsed.options ?? ['Одежда и обувь', 'Дом и быт', 'Техника и мебель', 'Красота', 'Другое'];
      await bot.sendMessage(chatId, parsed.message, { reply_markup: inlineKeyboard(options) });
      return;
    }
    if (parsed.error === 'clarification_needed') {
      await bot.sendMessage(chatId, parsed.message);
      return;
    }
    if (parsed.error === 'no_amount') {
      await bot.sendMessage(chatId, 'Не смог распознать сумму. Уточни и напиши ещё раз 🙏');
      return;
    }
    await bot.sendMessage(chatId, 'Не смог распознать запись. Попробуй в формате: Продукты 2500 🤔');
    return;
  }

  await processAndSave(bot, chatId, telegramId, parsed, text);
}
