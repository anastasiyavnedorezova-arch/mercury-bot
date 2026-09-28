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
import { mentionsMarketplace, isWebBot, buildConfirmationText, buildMultiConfirmationText, TEXTS } from '../utils/botTexts.js';

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

async function getUserId(externalId) {
  const { data } = await supabase
    .from('users')
    .select('id')
    .eq('external_id', String(externalId))
    .single();
  return data?.id ?? null;
}

// Ищет категорию по названию среди системных и категорий самого пользователя
// (своя категория приоритетнее системной). Не найдена — «Остальное».
// Раньше поиск шёл по имени среди ВСЕХ пользователей через .single(): при одинаковых названиях
// у разных людей запись уходила в «Остальное» или в чужую категорию.
async function resolveCategory(userId, name) {
  const { data: rows } = await supabase
    .from('categories')
    .select('id, name, user_id')
    .eq('name', name)
    .eq('is_active', true);
  const list = rows ?? [];
  const found = list.find((r) => r.user_id === userId) ?? list.find((r) => r.user_id === null);
  if (found) return { id: found.id, name: found.name };

  console.warn('[resolveCategory] Category not found:', name, '— falling back to Остальное');
  const { data: fallback } = await supabase
    .from('categories')
    .select('id, name')
    .eq('name', 'Остальное')
    .is('user_id', null)
    .limit(1)
    .maybeSingle();
  return { id: fallback?.id ?? null, name: fallback?.name ?? 'Остальное' };
}

export async function saveTransaction(userId, parsed, rawMessage) {
  const category = await resolveCategory(userId, parsed.category);
  parsed.category_saved = category.name; // категория, которая реально попала в базу — её показываем пользователю
  const { data, error } = await supabase.from('transactions').insert({
    user_id: userId,
    type: parsed.type,
    amount: parsed.amount,
    category_id: category.id,
    comment: parsed.comment ?? null,
    transaction_date: parsed.transaction_date,
    raw_message: rawMessage,
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
}

const FAQ_SYSTEM_PROMPT = `Ты — дружелюбный помощник финансового бота Финник 💛
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
  });
  return response.choices[0].message.content.trim();
}

async function callLLM(userText, userCategories = []) {
  const today = new Date().toISOString().split('T')[0];
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: getSystemPrompt(userCategories) },
      // Дата и сообщение — на разных строках: в записи «Сегодня 2026-09-27. 3917 …» модель могла принять «27. 3917» за число
      { role: 'user', content: `Сегодня ${today}.\nСообщение пользователя: ${userText}` },
    ],
    temperature: 0,
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

async function processAndSave(bot, chatId, telegramId, parsed, rawMessage) {
  const userId = await getUserId(telegramId);
  if (!userId) {
    await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start для регистрации.');
    return;
  }

  const access = await getUserAccess(userId);
  console.log(`[access] telegramId=${telegramId} userId=${userId} access=${access}`);

  if (Array.isArray(parsed)) {
    let savedCount = 0;
    for (const item of parsed) {
      const id = await saveTransaction(userId, item, rawMessage);
      if (id !== null) savedCount++;
    }
    if (savedCount === 0) {
      await bot.sendMessage(chatId,
        TEXTS.saveFailedMany,
        MENU_KEYBOARD
      );
      return;
    }
    const text = buildMultiConfirmationText(parsed);
    await bot.sendMessage(chatId, text, MENU_KEYBOARD);
  } else {
    const txId = await saveTransaction(userId, parsed, rawMessage);
    if (txId === null) {
      await bot.sendMessage(chatId,
        TEXTS.saveFailed,
        MENU_KEYBOARD
      );
      return;
    }
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
    await bot.sendMessage(chatId, TEXTS.noAmountInState);
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
    transaction_date: new Date().toISOString().split('T')[0],
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
  return true;
}

export async function handleManualCallback(bot, query) {
  const chatId = query.message.chat.id;
  const telegramId = query.from.id;
  const action = query.data;

  await bot.answerCallbackQuery(query.id);

  if (action === 'manual:start') {
    userStates.set(telegramId, { manualStep: 'type', createdAt: Date.now() });
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
  const { data } = await supabase
    .from('categories')
    .select('name')
    .or(`user_id.is.null,user_id.eq.${userId}`)
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
  if (await handleTxEditState(bot, msg)) return;
  if (await handleGoalState(bot, msg)) return;
  if (await handleBudgetState(bot, msg)) return;
  if (await handleHistoryState(bot, msg)) return;
  if (await handleFeedbackMessage(bot, msg)) return;
  if (await handleSubscriptionEmailState(bot, msg)) return;
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
      await bot.sendMessage(chatId, TEXTS.faqFailed);
    }
    return;
  }

  // ── Определяем effectiveText в зависимости от pending-состояния ───────────

  let effectiveText = pendingAnswerText ?? text;

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
    await bot.sendMessage(chatId, TEXTS.processingError);
    return;
  }

  if (!Array.isArray(parsed) && parsed.error) {
    if (
      parsed.error === 'clarification_needed' &&
      parsed.clarification_type === 'wb_category' &&
      !mentionsMarketplace(effectiveText)
    ) {
      // Модель ошиблась: маркетплейс в сообщении не назван — вопрос про него не нужен
      console.log('[llm] wb_category без названия маркетплейса → не распознано', JSON.stringify(effectiveText));
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
      const options = parsed.options ?? ['Одежда и обувь', 'Товары в дом', 'Техника и мебель', 'Красота и уход за собой', 'Остальное'];
      await bot.sendMessage(chatId, parsed.message, { reply_markup: inlineKeyboard(options) });
      return;
    }
    if (parsed.error === 'clarification_needed') {
      await bot.sendMessage(chatId, parsed.message, MANUAL_ERROR_KEYBOARD);
      return;
    }
    // Сырой ответ модели попадает в лог Railway — так видно, почему запись не распозналась
    console.log('[llm] не распознано', JSON.stringify({ text: effectiveText, result: parsed }));
    if (parsed.error === 'no_amount') {
      await bot.sendMessage(chatId, TEXTS.noAmount, MANUAL_ERROR_KEYBOARD);
      return;
    }
    await bot.sendMessage(chatId, TEXTS.unrecognized, MANUAL_ERROR_KEYBOARD);
    return;
  }

  await processAndSave(bot, chatId, telegramId, parsed, effectiveText);
}
