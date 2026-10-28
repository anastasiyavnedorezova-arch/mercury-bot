import OpenAI from 'openai';
import { reserveAi, denyAi } from '../utils/aiLimit.js';
import { parseWithRetry } from '../utils/llmRetry.js';
import { replyIfQuota } from '../utils/openaiErrors.js';
import 'dotenv/config';
import { supabase } from '../db.js';
import { getSystemPrompt } from '../prompts/system_prompt.js';
import { userStates } from '../state.js';
import { requireTerms, maybeShowFirstRecordTip } from './onboarding.js';
import { getUserAccess } from '../utils/access.js';
import { resolveCategory, applyCategoryScope } from '../utils/categoryAccess.js';
import { handleTxEditState } from './transaction.js';
import { handleGoalState } from './goal.js';
import { handleBudgetState } from './budget.js';
import { handleHistoryState } from './history.js';
import { handleFeedbackMessage } from './feedback.js';
import { handleSubscriptionEmailState, handleSubscriptionPromoState } from './subscription.js';
import { handleCategoryNameState } from './categories.js';
import { handleFileTextResponse } from './fileUpload.js';
import { parseAmount } from '../utils/parseAmount.js';
import { quickParse } from '../utils/quickParse.js';
import { rememberPhrase, recallPhrase, memoryNote } from '../utils/phraseMemory.js';
import { rememberUnrecognized, clearUnrecognized, takeUnrecognized, looksLikeMash } from '../utils/learnSignal.js';
import { splitAmountAndWords } from '../utils/categoryHints.js';
import { maybeAskToLearn } from './learn.js';
import { mentionsMarketplace, isWebBot, buildConfirmationText, buildMultiConfirmationText, buildMultiKeyboard, buildGoalPickText, buildGoalPickKeyboard, textForPendingAmount, TEXTS } from '../utils/botTexts.js';
import { GOAL_CATEGORY, getActiveGoals, getContributions, attachGoalInfo, planGoalContributions, matchGoalByText, isGoalItem, normalizeGoalItem } from '../utils/goalProgress.js';
import { isGoalStateExpired } from '../utils/goalEdit.js';
import { parseAmountStrict } from '../utils/parseAmount.js';
import { todayStr } from '../utils/dateTz.js';
import { findUserIdByExternalId } from '../utils/findUser.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MENU_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]],
  },
};

const MANUAL_ERROR_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '✏️ Добавить запись вручную', callback_data: 'manual:start' }],
      [{ text: '☰ Главное меню', callback_data: 'menu:main' }],
    ],
  },
};

const getUserId = (externalId) => findUserIdByExternalId(supabase, externalId);

// goalId — только для взноса на цель (type=goal): к какой цели он относится
export async function saveTransaction(userId, parsed, rawMessage, goalId = null) {
  const access = await getUserAccess(userId);
  const category = await resolveCategory(supabase, userId, parsed.category, access);
  parsed.category_saved = category.name; // категория, которая реально попала в базу — её показываем пользователю
  if (category.lockedFrom) parsed.category_locked = category.lockedFrom; // своя категория закрыта тарифом free: скажем об этом пользователю
  const { data, error } = await supabase.from('transactions').insert({
    user_id: userId,
    type: parsed.type,
    amount: parsed.amount,
    category_id: category.id,
    comment: parsed.comment ?? null,
    transaction_date: parsed.transaction_date,
    raw_message: rawMessage,
    goal_id: parsed.type === 'goal' ? goalId : null,
  }).select('id').single();

  if (error) {
    console.error('[saveTransaction] Supabase error:', error.message, '| category:', parsed.category, '| categoryId:', category.id);
    return null;
  }
  return data?.id ?? null;
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
  // Самая первая запись человека: один раз подсказываем, что делать дальше (цель, бюджет)
  await maybeShowFirstRecordTip(bot, chatId, txId);
}

const FAQ_SYSTEM_PROMPT = `Ты — Финник, дружелюбный помощник сервиса «Финник · Деньги» (личные финансы: чат в Telegram и личный кабинет на сайте) 💛
Отвечай тепло, по-человечески, на «ты».
Используй эмодзи — но не больше 1-2 на ответ.
Отвечай кратко и по делу.

ВОПРОСЫ И ОТВЕТЫ:

Q: Что ты умеешь? / Что умеет Финник?
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
Перед отправкой лучше закрыть ФИО, номера карт и счетов: для учёта они не нужны. Файл уходит на распознавание за границу, подробности в Согласии.

Если вопрос не про Финника — мягко предложи написать через кнопку «Обратная связь».`;

const FAQ_WEB_NOTE = `

ВАЖНО: сейчас пользователь пишет из веб-чата в личном кабинете. Здесь пока нельзя отправлять голосовые сообщения и фото или скриншоты — не предлагай их. Записывать траты нужно текстом. Если спросят про голос или скриншоты — скажи, что это пока работает только в Telegram-боте 💛`;

async function callFaqLLM(question, bot) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: FAQ_SYSTEM_PROMPT + (isWebBot(bot) ? FAQ_WEB_NOTE : '') },
      { role: 'user', content: question },
    ],
    temperature: 0.3,
    max_tokens: 600,
  });
  return response.choices[0].message.content.trim();
}

async function callLLM(userText, userCategories = [], { retryHint } = {}) {
  const today = todayStr();
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: getSystemPrompt(userCategories) },
      // Дата и сообщение — на разных строках: в записи «Сегодня 2026-09-27. 3917 …» модель могла принять «27. 3917» за число
      { role: 'user', content: `Сегодня ${today}.\nСообщение пользователя: ${userText}${retryHint ? `\n\n${retryHint}` : ''}` },
    ],
    temperature: retryHint ? 0.3 : 0,
    max_tokens: 1500,
  });
  const raw = response.choices[0].message.content.trim();
  // Иногда модель оборачивает JSON в ```json … ``` — убираем ограждение
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let result;
  try {
    result = JSON.parse(cleaned);
  } catch (err) {
    console.error('[llm] invalid JSON', JSON.stringify({ text: userText, raw: raw.slice(0, 300) }));
    throw err;
  }
  if (result === null || typeof result !== 'object') {
    console.error('[llm] unexpected result', JSON.stringify({ text: userText, raw: raw.slice(0, 300) }));
    throw new Error('LLM returned non-object');
  }
  return result;
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

const NO_GOAL_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🎯 Поставить цель', callback_data: 'goal:new' }],
      [{ text: '☰ Главное меню', callback_data: 'menu:main' }],
    ],
  },
};

// Подсчитывает накопленное по целям после сохранения и дописывает в записи (для текста подтверждения).
async function attachGoalInfoSafe(userId, goals, entries) {
  try {
    const contributions = await getContributions(supabase, userId);
    for (const { item, goalId } of entries) {
      const goal = goals.find((g) => g.id === goalId);
      if (goal) attachGoalInfo(item, goal, contributions);
    }
  } catch (err) {
    console.error('[goalProgress] attach failed:', err.message);
  }
}

async function askGoalPick(bot, chatId, telegramId, userId, items, rawMessage, goals) {
  userStates.set(telegramId, { awaitingGoalPick: true, userId, items, rawMessage, createdAt: Date.now() });
  await bot.sendMessage(chatId, buildGoalPickText(items[0]), buildGoalPickKeyboard(goals));
}

async function processAndSave(bot, chatId, telegramId, parsed, rawMessage) {
  const userId = await getUserId(telegramId);
  if (!userId) {
    await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start для регистрации.');
    return;
  }

  const access = await getUserAccess(userId);
  console.log(`[access] telegramId=${telegramId} userId=${userId} access=${access}`);

  const isMulti = Array.isArray(parsed);
  const items = isMulti ? parsed : [parsed];
  // Взнос на цель: одна цель — берём её; несколько — по названию в тексте, иначе спрашиваем кнопками
  const goals = items.some(isGoalItem) ? await getActiveGoals(supabase, userId) : [];
  const { toSave, pending, dropped } = planGoalContributions(goals, items, rawMessage);

  if (toSave.length > 0) {
    const ids = [];
    for (const { item, goalId } of toSave) {
      // В комментарий — название цели: в истории видно, на какую цель ушёл взнос
      if (goalId) item.comment = goals.find((g) => g.id === goalId)?.name ?? item.comment;
      ids.push(await saveTransaction(userId, item, rawMessage, goalId));
    }
    const savedEntries = toSave.filter((_, k) => ids[k] !== null);
    if (savedEntries.some((e) => e.goalId)) await attachGoalInfoSafe(userId, goals, savedEntries);

    if (savedEntries.length === 0) {
      await bot.sendMessage(chatId, isMulti ? TEXTS.saveFailedMany : TEXTS.saveFailed, MENU_KEYBOARD);
    } else if (isMulti) {
      await bot.sendMessage(chatId, buildMultiConfirmationText(toSave.map((e) => e.item)), buildMultiKeyboard(ids));
    } else {
      await sendConfirmation(bot, chatId, toSave[0].item, ids[0], access);
    }
  }

  if (dropped > 0) {
    await bot.sendMessage(chatId, TEXTS.goalNone, NO_GOAL_KEYBOARD);
  }
  if (pending.length > 0) {
    await askGoalPick(bot, chatId, telegramId, userId, pending, rawMessage, goals);
  }
}

// Ответ на «На какую цель?»: кнопка (goal:contrib:<id>) или название цели текстом.
async function finishGoalPick(bot, chatId, telegramId, state, goalId) {
  const goals = await getActiveGoals(supabase, state.userId);
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) {
    userStates.delete(telegramId);
    await bot.sendMessage(chatId, TEXTS.goalPickStale, MENU_KEYBOARD);
    return;
  }

  // Исправление уже записанного взноса: только привязываем его к цели
  if (state.linkTxId) {
    userStates.delete(telegramId);
    await supabase.from('transactions').update({ goal_id: goal.id, type: 'goal' }).eq('id', state.linkTxId).eq('user_id', state.userId);
    await bot.sendMessage(chatId, `Готово, взнос привязан к цели «${goal.name}» 🎯`, MENU_KEYBOARD);
    return;
  }

  const item = state.items.shift();
  if (!item) {
    userStates.delete(telegramId);
    await bot.sendMessage(chatId, TEXTS.goalPickStale, MENU_KEYBOARD);
    return;
  }
  const access = await getUserAccess(state.userId);
  item.comment = goal.name;
  const txId = await saveTransaction(state.userId, item, state.rawMessage, goal.id);
  if (txId === null) {
    userStates.delete(telegramId);
    await bot.sendMessage(chatId, TEXTS.saveFailed, MENU_KEYBOARD);
    return;
  }
  await attachGoalInfoSafe(state.userId, goals, [{ item, goalId: goal.id }]);
  await sendConfirmation(bot, chatId, item, txId, access);

  if (state.items.length > 0) {
    await askGoalPick(bot, chatId, telegramId, state.userId, state.items, state.rawMessage, goals);
  } else {
    userStates.delete(telegramId);
  }
}

export async function handleGoalContribCallback(bot, query) {
  const chatId = query.message.chat.id;
  const telegramId = query.from.id;
  await bot.answerCallbackQuery(query.id);

  const state = userStates.get(telegramId);
  if (query.data === 'goal:contrib_cancel') {
    if (state?.awaitingGoalPick) userStates.delete(telegramId);
    await bot.sendMessage(chatId, TEXTS.goalPickCancelled, MENU_KEYBOARD);
    return;
  }
  if (!state?.awaitingGoalPick || isGoalStateExpired(state)) {
    if (state?.awaitingGoalPick) userStates.delete(telegramId);
    await bot.sendMessage(chatId, TEXTS.goalPickStale, MENU_KEYBOARD);
    return;
  }
  await finishGoalPick(bot, chatId, telegramId, state, query.data.split(':')[2]);
}

// ── «Пополнить» из карточки цели ─────────────────────────────────────────────

export async function handleGoalTopupCallback(bot, query) {
  const chatId = query.message.chat.id;
  const telegramId = query.from.id;
  await bot.answerCallbackQuery(query.id);

  if (query.data === 'goal:topup_cancel') {
    if (userStates.get(telegramId)?.awaitingGoalTopup) userStates.delete(telegramId);
    await bot.sendMessage(chatId, TEXTS.goalPickCancelled, MENU_KEYBOARD);
    return;
  }

  const userId = await getUserId(telegramId);
  if (!userId) {
    await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start для регистрации.');
    return;
  }
  const goal = (await getActiveGoals(supabase, userId)).find((g) => g.id === query.data.split(':')[2]);
  if (!goal) {
    await bot.sendMessage(chatId, 'Цель не найдена 🤔', MENU_KEYBOARD);
    return;
  }
  userStates.set(telegramId, { awaitingGoalTopup: true, goalId: goal.id, userId, createdAt: Date.now() });
  await bot.sendMessage(chatId, `Сколько отложил на «${goal.name}»? Напиши сумму, например 5000 👇`, {
    reply_markup: { inline_keyboard: [[{ text: 'Отмена', callback_data: 'goal:topup_cancel' }]] },
  });
}

// Бот ждёт сумму. Только сумма («5000», «5 тыс») — взнос; текст без цифр — переспрашиваем;
// всё остальное («кофе 200») — обычная запись, ожидание снимаем.
async function handleGoalTopupText(bot, msg) {
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;
  const state = userStates.get(telegramId);
  if (!state?.awaitingGoalTopup) return false;

  const text = String(msg.text ?? '');
  const amount = parseAmountStrict(text);
  if (amount === null || amount <= 0) {
    if (!/\d/.test(text)) {
      await bot.sendMessage(chatId, TEXTS.manualNoAmount);
      return true;
    }
    userStates.delete(telegramId);
    return false;
  }

  userStates.delete(telegramId);
  const goals = await getActiveGoals(supabase, state.userId);
  const goal = goals.find((g) => g.id === state.goalId);
  if (!goal) {
    await bot.sendMessage(chatId, 'Цель не найдена 🤔', MENU_KEYBOARD);
    return true;
  }
  const item = { type: 'goal', amount, category: GOAL_CATEGORY, comment: goal.name, transaction_date: todayStr() };
  const txId = await saveTransaction(state.userId, item, text, goal.id);
  if (txId === null) {
    await bot.sendMessage(chatId, TEXTS.saveFailed, MENU_KEYBOARD);
    return true;
  }
  await attachGoalInfoSafe(state.userId, goals, [{ item, goalId: goal.id }]);
  await sendConfirmation(bot, chatId, item, txId, await getUserAccess(state.userId));
  return true;
}

// Пока бот ждёт выбор цели: название цели текстом — это ответ; любое другое сообщение — новая запись,
// а ожидающий взнос снимаем (и честно говорим об этом, чтобы он не пропал молча).
async function handleGoalPickText(bot, msg) {
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;
  const state = userStates.get(telegramId);
  if (!state?.awaitingGoalPick) return false;

  const text = String(msg.text ?? '').trim();
  const goals = await getActiveGoals(supabase, state.userId);
  const hit = text && !/\d/.test(text)
    ? goals.find((g) => g.name.trim().toLowerCase() === text.toLowerCase()) ?? matchGoalByText(goals, text)
    : null;
  if (hit) {
    await finishGoalPick(bot, chatId, telegramId, state, hit.id);
    return true;
  }

  userStates.delete(telegramId);
  const what = state.linkTxId ? 'Взнос не привязан к цели' : 'Взнос на цель не записал — не выбрана цель';
  await bot.sendMessage(chatId, `${what} 🙈 Если нужно, напиши ещё раз.`);
  return false;
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
    await bot.sendMessage(chatId, TEXTS.noAmountInState);
    return true;
  }

  const access = await getUserAccess(userId);
  const parsed = {
    type: state.type ?? 'expense',
    amount: state.amount,
    category,
    comment: null,
    transaction_date: state.transaction_date ?? todayStr(),
  };

  if (isGoalItem(parsed)) {
    await processAndSave(bot, chatId, telegramId, normalizeGoalItem(parsed), state.rawMessage);
    return true;
  }

  const txId = await saveTransaction(userId, parsed, state.rawMessage);
  await sendConfirmation(bot, chatId, parsed, txId, access);
  return true;
}

const MANUAL_GROUPS = {
  expense: {
    'Еда': ['Продукты', 'Кафе и рестораны', 'Кофе на вынос', 'Доставка еды'],
    'Жильё и дом': ['Жильё', 'Товары в дом', 'Техника и мебель'],
    'Транспорт': ['Транспорт', 'Авто'],
    'Здоровье и красота': ['Здоровье', 'Красота и уход за собой', 'Спорт'],
    'Досуг и развлечения': ['Одежда и обувь', 'Путешествия', 'Отдых и развлечения', 'Обучение', 'Подписки', 'Подарки другим'],
    'Финансы и обязательства': ['Кредиты и займы', 'Налоги и штрафы', 'Комиссии', 'Долг я дал', 'Благотворительность', 'Связь и интернет'],
    'Другое': ['Дети', 'Животные', 'Остальное'],
  },
  income: {
    'Доход за работу': ['Зарплата', 'Фриланс и подработка', 'Продажа и соцвыплаты'],
    'Доходность вложений': ['Проценты по вкладу', 'Инвестиционный доход', 'Кэшбек и бонусы'],
    'Подарки и возвраты': ['Подарки мне', 'Возврат денег', 'Долг мне вернули'],
  },
};

async function handleManualAmountState(bot, msg) {
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;
  const state = userStates.get(telegramId);

  if (state?.manualStep !== 'amount') return false;

  const amount = parseAmount(msg.text?.trim());
  if (amount === null) {
    await bot.sendMessage(chatId, TEXTS.manualNoAmount);
    return true;
  }

  userStates.delete(telegramId);

  const userId = await getUserId(telegramId);
  if (!userId) {
    await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start для регистрации.');
    return true;
  }

  const access = await getUserAccess(userId);
  const parsed = {
    type: state.manualType,
    amount,
    category: state.manualCategory,
    comment: null,
    transaction_date: todayStr(),
  };

  const txId = await saveTransaction(userId, parsed, msg.text);
  if (txId === null) {
    await bot.sendMessage(chatId,
      TEXTS.saveFailed,
      MENU_KEYBOARD
    );
    return true;
  }
  await sendConfirmation(bot, chatId, parsed, txId, access);
  // Фраза, которую бот не смог распознать: запоминаем выбор человека и предлагаем передать фразу разработчикам
  if (state.learn?.text && await rememberPhrase(supabase, userId, state.learn.text, parsed)) {
    await bot.sendMessage(chatId, memoryNote(state.learn.text, parsed.category));
  }
  await maybeAskToLearn(bot, chatId, { userId, learn: state.learn, parsed });
  return true;
}

export async function handleManualCallback(bot, query) {
  const chatId = query.message.chat.id;
  const telegramId = query.from.id;
  const action = query.data;

  await bot.answerCallbackQuery(query.id);

  if (action === 'manual:start') {
    userStates.set(telegramId, { manualStep: 'type', learn: takeUnrecognized(telegramId), createdAt: Date.now() });
    await bot.sendMessage(chatId, 'Это расход или доход? 👇', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '💸 Расход', callback_data: 'manual:type:expense' }],
          [{ text: '💰 Доход', callback_data: 'manual:type:income' }],
        ],
      },
    });
    return;
  }

  if (action.startsWith('manual:type:')) {
    const type = action.split(':')[2];
    const state = userStates.get(telegramId) ?? {};
    userStates.set(telegramId, { ...state, manualStep: 'group', manualType: type, createdAt: state.createdAt ?? Date.now() });

    const groups = Object.keys(MANUAL_GROUPS[type] ?? {});
    const keyboard = groups.map(g => [{ text: g, callback_data: `manual:group:${g}` }]);
    await bot.sendMessage(chatId, 'Выбери группу категорий 👇', {
      reply_markup: { inline_keyboard: keyboard },
    });
    return;
  }

  if (action.startsWith('manual:group:')) {
    const group = action.slice('manual:group:'.length);
    const state = userStates.get(telegramId) ?? {};
    userStates.set(telegramId, { ...state, manualStep: 'category', manualGroup: group, createdAt: state.createdAt ?? Date.now() });

    const type = state.manualType ?? 'expense';
    const categories = MANUAL_GROUPS[type]?.[group] ?? [];
    const keyboard = categories.map(c => [{ text: c, callback_data: `manual:cat:${c}` }]);
    await bot.sendMessage(chatId, 'Выбери категорию 👇', {
      reply_markup: { inline_keyboard: keyboard },
    });
    return;
  }

  if (action.startsWith('manual:cat:')) {
    const category = action.slice('manual:cat:'.length);
    const state = userStates.get(telegramId) ?? {};
    userStates.set(telegramId, { ...state, manualStep: 'amount', manualCategory: category, createdAt: state.createdAt ?? Date.now() });

    await bot.sendMessage(chatId, 'Введи сумму ₽ 👇');
    return;
  }
}

// Точное совпадение текста с названием категории (системной или самого пользователя)
async function matchCategoryName(externalId, text) {
  const userId = await getUserId(externalId);
  if (!userId) return null;
  const access = await getUserAccess(userId);
  const { data } = await applyCategoryScope(supabase.from('categories').select('name'), userId, access)
    .eq('is_active', true);
  const t = String(text ?? '').trim().toLowerCase();
  return (data ?? []).find((c) => c.name.toLowerCase() === t)?.name ?? null;
}

export async function handleMessage(bot, msg) {
  const text = msg.text;
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;

  // Жёсткая блокировка: без согласия не обрабатываем ничего
  if (await requireTerms(bot, telegramId, chatId)) return;

  // Обновляем tg_username и активность при каждом сообщении
  const telegramUsername = msg.from?.username || msg.from?.first_name || null;
  if (telegramUsername) {
    supabase
      .from('users')
      .update({ tg_username: telegramUsername, last_active_at: new Date().toISOString() })
      .eq('external_id', String(telegramId))
      .eq('channel', 'telegram')
      .then(() => {})
      .catch(err => console.error('[tg_username update]', err.message));
  }

  // Сброс зависшего state (старше 30 минут)
  const staleState = userStates.get(telegramId);
  if (staleState?.createdAt && Date.now() - staleState.createdAt > 30 * 60 * 1000) {
    console.log('[state] Clearing stale state for:', telegramId);
    userStates.delete(telegramId);
  }

  // Состояния с приоритетом (правки выписки, редактирование транзакции и т.д.)
  if (await handleFileTextResponse(bot, msg)) return;
  if (await handleGoalPickText(bot, msg)) return;
  if (await handleGoalTopupText(bot, msg)) return;
  if (await handleTxEditState(bot, msg)) return;
  if (await handleGoalState(bot, msg)) return;
  if (await handleBudgetState(bot, msg)) return;
  if (await handleHistoryState(bot, msg)) return;
  if (await handleFeedbackMessage(bot, msg)) return;
  if (await handleSubscriptionEmailState(bot, msg)) return;
  if (await handleSubscriptionPromoState(bot, msg)) return;
  if (await handleCategoryNameState(bot, msg)) return;
  if (await handleManualAmountState(bot, msg)) return;

  let state = userStates.get(telegramId);

  // Бот ждёт категорию после вопроса про маркетплейс (кнопки). Если вместо кнопки пришёл текст:
  //  — это точное название категории → записываем в неё;
  //  — иначе отложенная запись отменяется. Ответ без цифр («одежда», «платье») считаем описанием покупки
  //    для отложенной суммы; со цифрами («3400 продукты») — это уже новое сообщение о трате.
  // Раньше любой текст здесь принимался за название категории («3400 продукты» уходило в «Остальное»).
  let pendingAnswerText = null;
  if (state?.awaitingCategory && state.pendingAmount === undefined) {
    const picked = await matchCategoryName(telegramId, text);
    if (picked) {
      await handleCategorySelection(bot, chatId, telegramId, picked);
      return;
    }
    userStates.delete(telegramId);
    if (state.amount && !/\d/.test(text)) pendingAnswerText = `${text} ${state.amount}`;
    state = undefined;
  }

  // FAQ-вопрос
  if (state?.awaitingQuestion) {
    userStates.delete(telegramId);
    const faqGate = await reserveAi(supabase, telegramId, 'faq');
    if (!faqGate.ok) { await denyAi(bot, chatId, faqGate); return; }
    try {
      const answer = await callFaqLLM(text, bot);
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
      if (await replyIfQuota(err, bot, chatId)) return;
      await bot.sendMessage(chatId, TEXTS.faqFailed);
    }
    return;
  }

  // ── Определяем effectiveText в зависимости от pending-состояния ───────────

  let effectiveText = pendingAnswerText ?? text;

  if (state?.awaitingCategory && state.pendingAmount !== undefined) {
    // Сценарий А — ответ: пользователь написал категорию для отложенной суммы
    userStates.delete(telegramId);
    effectiveText = textForPendingAmount(text, state.pendingAmount);
    // pass through to LLM

  } else if (state?.awaitingAmount && state.pendingCategory) {
    // Сценарий Б — ответ: пользователь написал сумму для отложенной категории
    userStates.delete(telegramId);
    const amount = parseAmount(text);
    if (amount !== null) {
      effectiveText = `${state.pendingCategory} ${text}`;
    }
    // если не число — pass through as-is

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
        `Записываю <b>${pureAmount} ₽</b> 💸 В какую категорию отнести? Напиши название 👇`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    // Сценарий Б: только слова без числа — проверяем совпадение с категорией
    if (pureAmount === null && trimmed.length > 1 && /^[а-яА-ЯёЁa-zA-Z\s,.-]+$/.test(trimmed)) {
      const userId = await getUserId(telegramId);
      if (userId) {
        const accessNow = await getUserAccess(userId);
        const { data: matchedCat } = await applyCategoryScope(supabase.from('categories').select('name'), userId, accessNow)
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
            `Категория <b>${matchedCat.name}</b> 👌 Какую сумму записать? 👇`,
            { parse_mode: 'HTML' }
          );
          return;
        }
        // Категория не найдена — передаём в LLM (Сценарий В)
      }
    }
  }

  // ── Обычный поток через LLM ───────────────────────────────────────────────

  clearUnrecognized(telegramId); // новая запись: прежняя нераспознанная фраза больше не ждёт ручного ввода
  const userId = await getUserId(telegramId);
  let userCategories = [];
  // Свои категории показываем модели всегда. На free запись в такую категорию уйдёт в «Остальное», но с пояснением
  // («Свои категории доступны в подписке…»): иначе человек не поймёт, почему запись попала не туда
  if (userId) {
    const { data } = await supabase
      .from('categories')
      .select('name, type, synonyms')
      .eq('user_id', userId)
      .eq('is_active', true);
    userCategories = data ?? [];
  }

  // Короткая запись «развлечения 400» или «золотое яблоко 3400»: категория известна, ИИ не нужен.
  // Сначала личная память человека (он сам так записывал раньше), потом общий справочник слов.
  const recalled = await recallPhrase(supabase, userId, effectiveText, todayStr());
  const quick = recalled ?? quickParse(effectiveText, userCategories, todayStr());
  if (quick) {
    console.log(recalled ? '[memory] из памяти' : '[quick] без ИИ', JSON.stringify({ text: effectiveText, category: quick.category }));
    await processAndSave(bot, chatId, telegramId, quick, effectiveText);
    return;
  }

  // Дневной лимит запросов к ИИ (голосовое уже учтено при распознавании)
  if (!msg.fromVoice) {
    const gate = await reserveAi(supabase, telegramId, 'text');
    if (!gate.ok) { await denyAi(bot, chatId, gate); return; }
  }

  let parsed;
  try {
    parsed = await parseWithRetry((opts) => callLLM(effectiveText, userCategories, opts), effectiveText);
  } catch (err) {
    console.error('OpenAI error:', err.message);
    if (await replyIfQuota(err, bot, chatId)) return;
    await bot.sendMessage(chatId, TEXTS.processingError);
    return;
  }

  if (!Array.isArray(parsed) && parsed.error) {
    if (
      parsed.error === 'clarification_needed' &&
      parsed.clarification_type === 'wb_category' &&
      !mentionsMarketplace(effectiveText)
    ) {
      // Модель ошиблась: маркетплейс в сообщении не назван — вопрос про него не нужен.
      // Если в сообщении настоящее слово и сумма, записываем в «Остальное» с кнопкой «Исправить», а не гоним в ручной ввод
      const parts = splitAmountAndWords(effectiveText);
      const wbAmount = Number(parsed.amount) > 0 ? Number(parsed.amount) : (parts ? parseAmount(parts.amountText) : NaN);
      if (parts && Number.isFinite(wbAmount) && wbAmount > 0 && !looksLikeMash(effectiveText)) {
        console.log('[llm] wb_category без названия маркетплейса → Остальное', JSON.stringify(effectiveText));
        await processAndSave(bot, chatId, telegramId, {
          type: parsed.type === 'income' ? 'income' : 'expense',
          amount: wbAmount,
          category: 'Остальное',
          comment: parts.words.trim().slice(0, 60),
          transaction_date: parsed.transaction_date ?? todayStr(),
          confidence: 'low',
          uncertain: true,
        }, effectiveText);
        return;
      }
      console.log('[llm] wb_category без названия маркетплейса → не распознано', JSON.stringify(effectiveText));
      rememberUnrecognized(telegramId, { text: effectiveText, reason: null });
      await bot.sendMessage(chatId, TEXTS.unrecognized, MANUAL_ERROR_KEYBOARD);
      return;
    }
    if (parsed.error === 'clarification_needed' && parsed.clarification_type === 'wb_category') {
      // Fix 5: если в сообщении есть слова про возврат — не спрашиваем про WB
      const isReturn = /возврат|вернули|вернул|refund/i.test(effectiveText);
      if (isReturn && parsed.amount) {
        await processAndSave(bot, chatId, telegramId, {
          type: 'income',
          amount: parsed.amount,
          category: 'Возврат денег',
          comment: 'возврат товара',
          transaction_date: parsed.transaction_date ?? todayStr(),
        }, effectiveText);
        return;
      }
      userStates.set(telegramId, {
        awaitingCategory: true,
        clarificationType: 'wb_category',
        rawMessage: effectiveText,
        amount: parsed.amount ?? null,
        type: parsed.type ?? 'expense',
        transaction_date: parsed.transaction_date ?? todayStr(),
        createdAt: Date.now(),
      });
      const options = parsed.options ?? ['Одежда и обувь', 'Товары в дом', 'Техника и мебель', 'Красота и уход за собой', 'Остальное'];
      await bot.sendMessage(chatId, parsed.message, { reply_markup: inlineKeyboard(options) });
      return;
    }
    if (parsed.error === 'clarification_needed') {
      await bot.sendMessage(chatId, parsed.message, MANUAL_ERROR_KEYBOARD);
      return;
    }
    // Сырой ответ модели попадает в лог сервера — так видно, почему запись не распозналась
    console.log('[llm] не распознано', JSON.stringify({ text: effectiveText, result: parsed }));
    if (parsed.error === 'no_amount') {
      await bot.sendMessage(chatId, TEXTS.noAmount, MANUAL_ERROR_KEYBOARD);
      return;
    }
    rememberUnrecognized(telegramId, { text: effectiveText, reason: parsed.reason });
    await bot.sendMessage(chatId, TEXTS.unrecognized, MANUAL_ERROR_KEYBOARD);
    return;
  }

  // Слово настоящее, но категорию модель не нашла: запись ушла в «Остальное», скажем об этом и дадим исправить
  if (!Array.isArray(parsed) && parsed.category === 'Остальное' && parsed.confidence === 'low') {
    // Случайный набор букв («ывапр 100») не запись: говорим «не распознал», а не пишем в «Остальное»
    if (looksLikeMash(effectiveText)) {
      console.log('[llm] случайный набор букв → не распознано', JSON.stringify(effectiveText));
      rememberUnrecognized(telegramId, { text: effectiveText, reason: 'gibberish' });
      await bot.sendMessage(chatId, TEXTS.unrecognized, MANUAL_ERROR_KEYBOARD);
      return;
    }
    parsed.uncertain = true;
  }

  await processAndSave(bot, chatId, telegramId, parsed, effectiveText);
}
