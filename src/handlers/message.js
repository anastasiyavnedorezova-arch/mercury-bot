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
import { handleFileTextResponse } from './fileUpload.js';
import { parseAmount } from '../utils/parseAmount.js';

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
  if (txId) {
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

const FAQ_SYSTEM_PROMPT = `Ты — дружелюбный помощник финансового бота Меркури 💛
Отвечай тепло, по-человечески, на «ты».
Используй эмодзи — но не больше 1-2 на ответ.
Отвечай кратко и по делу.

ВОПРОСЫ И ОТВЕТЫ:

Q: Что ты умеешь? / Что умеет Меркури?
A: Вот что я умею 👇
— Записывать расходы и доходы — просто напиши мне в свободной форме, отправь голосовое или скрин из банковского приложения
— Считать ежемесячный взнос для достижения финансовой цели и следить за прогрессом
— Анализировать расходы по категориям и следить за бюджетом

Q: Как записывать расходы и доходы?
A: Очень просто 🙌 Напиши мне в свободной форме, например «продукты 1800» или «зарплата 120000».
Ещё можешь записать голосовое сообщение или прислать скрин из банковского приложения — я всё распознаю сам.

Q: Как отредактировать или удалить запись?
A: После каждой записи я показываю кнопки [Исправить] и [Удалить] — просто нажми нужную 💛

Q: Как посмотреть историю записей?
A: Выбери «История транзакций» в главном меню 📋

Q: Как изменить цель?
A: Нажми «Моя цель» в меню, выбери нужную цель и уточни что хочешь изменить 🎯

Q: Как посмотреть расходы за неделю или другой период?
A: Сейчас аналитика по запросу доступна с 1-го числа месяца по сегодня — на пробном или платном тарифе.
На бесплатном — общая аналитика приходит в конце каждого месяца 📊

Q: Как посмотреть все категории?
A: Нажми «Мои категории» в главном меню — там увидишь все доступные категории 📂

Q: Как добавить свою категорию?
A: В меню выбери «Мои категории» → «Добавить» ✨
Количество своих категорий не ограничено, но не добавляй слишком много — могу запутаться 😅

Q: Как записать расход в свою категорию?
A: Напиши чуть подробнее. Например, если создала категорию «Дача» — пиши «цветы на дачу 2500» и я сразу пойму что это для Дачи 🌱

Q: Как установить бюджет?
A: Нажми «Мой бюджет» в главном меню или напиши /budget 💰

Q: Как поставить финансовую цель?
A: Нажми «Моя цель» в главном меню или напиши /goal 🎯

Q: Как посмотреть аналитику?
A: Нажми «Аналитика» в главном меню или напиши /analytics 📊

Q: Как загрузить выписку из банка?
A: Просто отправь мне фото или скрин истории операций из банковского приложения 📸
Я распознаю транзакции и покажу список на подтверждение.

Если вопрос не про Меркури — мягко предложи написать через кнопку «Обратная связь».`;

async function callFaqLLM(question) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: FAQ_SYSTEM_PROMPT },
      { role: 'user', content: question },
    ],
    temperature: 0.3,
  });
  return response.choices[0].message.content.trim();
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
  // pendingAmount означает Сценарий А — обрабатывается в handleMessage через LLM
  if (!state?.awaitingCategory || state.pendingAmount !== undefined) return false;
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

  // Обновляем username и активность при каждом сообщении
  const telegramUsername = msg.from?.username || msg.from?.first_name || null;
  if (telegramUsername) {
    supabase
      .from('users')
      .update({ username: telegramUsername, last_active_at: new Date().toISOString() })
      .eq('external_id', String(telegramId))
      .eq('channel', 'telegram')
      .then(() => {})
      .catch(err => console.error('[username update]', err.message));
  }

  // Сброс зависшего state (старше 30 минут)
  const staleState = userStates.get(telegramId);
  if (staleState?.createdAt && Date.now() - staleState.createdAt > 30 * 60 * 1000) {
    console.log('[state] Clearing stale state for:', telegramId);
    userStates.delete(telegramId);
  }

  // Состояния с приоритетом (правки выписки, редактирование транзакции и т.д.)
  if (await handleFileTextResponse(bot, msg)) return;
  if (await handleTxEditState(bot, msg)) return;
  if (await handleGoalState(bot, msg)) return;
  if (await handleBudgetState(bot, msg)) return;
  if (await handleHistoryState(bot, msg)) return;
  if (await handleFeedbackMessage(bot, msg)) return;
  if (await handleSubscriptionEmailState(bot, msg)) return;
  if (await handleCategoryNameState(bot, msg)) return;

  const state = userStates.get(telegramId);

  // FAQ-вопрос
  if (state?.awaitingQuestion) {
    userStates.delete(telegramId);
    try {
      const answer = await callFaqLLM(text);
      await bot.sendMessage(chatId, answer, {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Задать ещё вопрос', callback_data: 'ask_question' },
            { text: '☰ Главное меню', callback_data: 'menu:main' },
          ]],
        },
      });
    } catch (err) {
      console.error('FAQ LLM error:', err.message);
      await bot.sendMessage(chatId, 'Не смог ответить. Попробуй ещё раз 🙏');
    }
    return;
  }

  // ── Определяем effectiveText в зависимости от pending-состояния ───────────

  let effectiveText = text;

  if (state?.awaitingCategory && state.pendingAmount !== undefined) {
    // Сценарий А — ответ: пользователь написал категорию для отложенной суммы
    userStates.delete(telegramId);
    effectiveText = `${text} ${state.pendingAmount}`;
    // pass through to LLM

  } else if (state?.awaitingAmount && state.pendingCategory) {
    // Сценарий Б — ответ: пользователь написал сумму для отложенной категории
    userStates.delete(telegramId);
    const amount = parseAmount(text);
    if (amount !== null) {
      effectiveText = `${state.pendingCategory} ${text}`;
    }
    // если не число — pass through as-is

  } else if (state?.awaitingCategory) {
    // WB/маркетплейс — пользователь набрал категорию текстом
    await handleCategorySelection(bot, chatId, telegramId, text);
    return;

  } else {
    // Нет активного state — проверяем Сценарии А и Б
    const trimmed = text.trim();
    const pureAmount = parseAmount(trimmed);
    const onlyNumber = pureAmount !== null &&
      /^[\d\s.,kKкК]+(тыс(яч(а|и)?)?|тк|млн(ов)?|млрд)?$/i.test(trimmed);

    if (onlyNumber) {
      // Сценарий А: пользователь написал только число
      userStates.set(telegramId, {
        awaitingCategory: true,
        pendingAmount: pureAmount,
        createdAt: Date.now(),
      });
      await bot.sendMessage(
        chatId,
        `Сумма <b>${pureAmount} ₽</b> — уточни в какую категорию записать эту транзакцию 👇`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // Сценарий Б: только слова без числа — проверяем совпадение с категорией
    if (pureAmount === null && trimmed.length > 1 && /^[а-яА-ЯёЁa-zA-Z\s,.-]+$/.test(trimmed)) {
      const userId = await getUserId(telegramId);
      if (userId) {
        const { data: matchedCat } = await supabase
          .from('categories')
          .select('name')
          .or(`user_id.is.null,user_id.eq.${userId}`)
          .eq('is_active', true)
          .ilike('name', trimmed)
          .maybeSingle();

        if (matchedCat) {
          userStates.set(telegramId, {
            awaitingAmount: true,
            pendingCategory: matchedCat.name,
            createdAt: Date.now(),
          });
          await bot.sendMessage(
            chatId,
            `Расход в категории <b>${matchedCat.name}</b>. Уточни, какую сумму записать 👇`,
            { parse_mode: 'HTML' }
          );
          return;
        }
        // Категория не найдена — передаём в LLM (Сценарий В)
      }
    }
  }

  // ── Обычный поток через LLM ───────────────────────────────────────────────

  let parsed;
  try {
    const userId = await getUserId(telegramId);
    let userCategories = [];
    if (userId) {
      const { data } = await supabase
        .from('categories')
        .select('name, type, synonyms')
        .eq('user_id', userId)
        .eq('is_active', true);
      userCategories = data ?? [];
    }
    parsed = await callLLM(effectiveText, userCategories);
  } catch (err) {
    console.error('OpenAI error:', err.message);
    await bot.sendMessage(chatId, 'Ошибка при обработке сообщения. Попробуй ещё раз 🙏');
    return;
  }

  if (!Array.isArray(parsed) && parsed.error) {
    if (parsed.error === 'clarification_needed' && parsed.clarification_type === 'wb_category') {
      // Fix 5: если в сообщении есть слова про возврат — не спрашиваем про WB
      const isReturn = /возврат|вернули|вернул|refund/i.test(effectiveText);
      if (isReturn && parsed.amount) {
        await processAndSave(bot, chatId, telegramId, {
          type: 'income',
          amount: parsed.amount,
          category: 'Возврат денег',
          comment: 'возврат товара',
          transaction_date: parsed.transaction_date ?? new Date().toISOString().split('T')[0],
        }, effectiveText);
        return;
      }
      userStates.set(telegramId, {
        awaitingCategory: true,
        clarificationType: 'wb_category',
        rawMessage: effectiveText,
        amount: parsed.amount ?? null,
        type: parsed.type ?? 'expense',
        transaction_date: parsed.transaction_date ?? new Date().toISOString().split('T')[0],
        createdAt: Date.now(),
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
      await bot.sendMessage(chatId, 'Не смог распознать сумму. Напиши только число 👇');
      return;
    }
    await bot.sendMessage(chatId, 'Не смог распознать запись. Попробуй в формате: Продукты 2500 🤔');
    return;
  }

  await processAndSave(bot, chatId, telegramId, parsed, effectiveText);
}
