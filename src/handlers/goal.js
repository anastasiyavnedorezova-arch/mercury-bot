import { supabase } from '../db.js';
import { getUserAccess } from '../utils/access.js';
import { userStates } from '../state.js';
import { calculateMonthlyPayment } from '../utils/goalCalc.js';
import { parseAmount } from '../utils/parseAmount.js';

// ── Константы и форматирование ────────────────────────────────────────────────

const MONTHS_RU = {
  'январь': 0, 'января': 0,
  'февраль': 1, 'февраля': 1,
  'март': 2, 'марта': 2,
  'апрель': 3, 'апреля': 3,
  'май': 4, 'мая': 4,
  'июнь': 5, 'июня': 5,
  'июль': 6, 'июля': 6,
  'август': 7, 'августа': 7,
  'сентябрь': 8, 'сентября': 8,
  'октябрь': 9, 'октября': 9,
  'ноябрь': 10, 'ноября': 10,
  'декабрь': 11, 'декабря': 11,
};

const MONTHS_RU_NAMES = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

const MENU_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]],
  },
};

function formatNum(n) {
  return Math.round(n).toLocaleString('ru-RU');
}

function formatGoalDate(dateStr) {
  const [year, month] = dateStr.split('-');
  return `${MONTHS_RU_NAMES[parseInt(month, 10) - 1]} ${year}`;
}

function pluralGoal(n) {
  if (n === 1) return 'цель';
  if (n >= 2 && n <= 4) return 'цели';
  return 'целей';
}

function parseRuDate(text) {
  const parts = text.trim().toLowerCase().split(/\s+/);
  if (parts.length < 2) return null;
  const year = parseInt(parts[parts.length - 1], 10);
  if (isNaN(year) || year < 2025 || year > 2100) return null;
  const monthPart = parts.slice(0, -1).join(' ');
  const monthIdx = MONTHS_RU[monthPart];
  if (monthIdx === undefined) return null;
  return new Date(year, monthIdx, 1);
}

// ── DB-хелперы ────────────────────────────────────────────────────────────────

async function getUserId(telegramId) {
  const { data } = await supabase
    .from('users')
    .select('id')
    .eq('external_id', String(telegramId))
    .eq('channel', 'telegram')
    .single();
  return data?.id ?? null;
}

async function getActiveGoals(userId) {
  const { data } = await supabase
    .from('goals')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  return data ?? [];
}

// ── Карточка цели: текст + кнопки ────────────────────────────────────────────

function goalCardText(goal, total, maxCount) {
  return (
    `У тебя установлена ${total} ${pluralGoal(total)} из ${maxCount}.\n\n` +
    `🎯 Твоя цель: ${goal.name}\n` +
    `📅 Срок: ${formatGoalDate(goal.target_date)}\n` +
    `💰 Нужно накопить: ${formatNum(goal.future_value)} ₽ (с учётом инфляции)\n` +
    `💡 Нужно откладывать: ${formatNum(goal.monthly_payment)} ₽/мес\n\n` +
    `Что хочешь сделать?`
  );
}

// canAdd — лимит не достигнут, показываем кнопку добавления
function goalCardKeyboard(goal, canAdd) {
  const id = goal.id;
  const keyboard = [
    [
      { text: '📊 Оценить прогресс', callback_data: `goal:progress:${id}` },
      { text: '✏️ Изменить', callback_data: `goal:edit:${id}` },
    ],
    [{ text: '🗑 Удалить', callback_data: `goal:delete:${id}` }],
  ];
  if (canAdd) {
    keyboard.push([{ text: '➕ Добавить новую цель', callback_data: 'goal:add_new' }]);
  } else {
    keyboard.push([{ text: '☰ Главное меню', callback_data: 'menu:main' }]);
  }
  return { reply_markup: { inline_keyboard: keyboard } };
}

// ── Точка входа: /goal и menu:goal ────────────────────────────────────────────

export async function showGoal(bot, chatId, telegramId) {
  const userId = await getUserId(telegramId);
  if (!userId) {
    await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start 🙏');
    return;
  }

  const [goals, access] = await Promise.all([
    getActiveGoals(userId),
    getUserAccess(userId),
  ]);

  if (goals.length === 0) {
    userStates.set(telegramId, { awaitingGoal: 'name' });
    await bot.sendMessage(
      chatId,
      `🎯 Давай поставим финансовую цель!\n\n` +
      `Как она называется? Например: «Купить квартиру», ` +
      `«Накопить подушку безопасности», «Новая машина» 👇`
    );
    return;
  }

  const maxCount = access === 'free' ? 1 : 3;
  const canAdd = goals.length < maxCount;

  if (goals.length === 1) {
    await bot.sendMessage(chatId, goalCardText(goals[0], 1, maxCount), goalCardKeyboard(goals[0], canAdd));
    return;
  }

  // Несколько целей — показываем список одним сообщением
  let text = `У тебя ${goals.length} ${pluralGoal(goals.length)} из ${maxCount}:\n\n`;
  for (const g of goals) {
    text += `🎯 ${g.name} — ${formatGoalDate(g.target_date)}, ${formatNum(g.monthly_payment)} ₽/мес\n`;
  }
  text += '\nВыбери цель для управления:';

  const keyboard = goals.map(g => [{ text: `🎯 ${g.name}`, callback_data: `goal:show:${g.id}` }]);
  if (canAdd) keyboard.push([{ text: '➕ Добавить новую цель', callback_data: 'goal:add_new' }]);
  keyboard.push([{ text: '☰ Главное меню', callback_data: 'menu:main' }]);

  await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

// ── Сохранение цели и отправка подтверждения ──────────────────────────────────

async function saveGoalAndConfirm(bot, chatId, userId, state, yieldRate) {
  const { futureValue: fv, monthlyPayment: monthly } = calculateMonthlyPayment({
    targetAmount: state.amount,
    initialSaved: state.saved,
    targetDate: state.date,
    yieldRate: yieldRate ?? null,
  });

  let monthlyNoYield;
  if (yieldRate) {
    ({ monthlyPayment: monthlyNoYield } = calculateMonthlyPayment({
      targetAmount: state.amount,
      initialSaved: state.saved,
      targetDate: state.date,
      yieldRate: null,
    }));
  }

  await supabase.from('goals').insert({
    user_id: userId,
    name: state.name,
    target_amount: state.amount,
    future_value: Math.round(fv),
    initial_saved: state.saved,
    monthly_payment: Math.round(monthly),
    target_date: state.date,
    inflation_rate: 0.06,
    yield_rate: yieldRate ?? null,
    status: 'active',
    last_recalculated_at: new Date().toISOString(),
  });

  let confirmText =
    `🎯 Цель поставлена!\n\n` +
    `Название: ${state.name}\n` +
    `Срок: ${formatGoalDate(state.date)}\n` +
    `Стоимость сегодня: ${formatNum(state.amount)} ₽\n` +
    `Стоимость с учётом инфляции: ${formatNum(fv)} ₽\n` +
    `Уже накоплено: ${formatNum(state.saved)} ₽\n\n`;

  if (yieldRate) {
    const savings = monthlyNoYield - monthly;
    confirmText +=
      `💡 С доходностью ${Math.round(yieldRate * 100)}%: ${formatNum(monthly)} ₽/мес\n` +
      `💡 Без доходности: ${formatNum(monthlyNoYield)} ₽/мес\n` +
      `Экономия: ${formatNum(savings)} ₽/мес\n\n`;
  } else {
    confirmText += `💰 Нужно откладывать: ${formatNum(monthly)} ₽/мес\n\n`;
  }

  confirmText += `Чтобы фиксировать пополнения копилки — пиши мне «на цель [сумма]» 💪`;

  await bot.sendMessage(chatId, confirmText, MENU_KEYBOARD);
}

// ── Диалог создания/редактирования цели (вызывается из handleMessage) ─────────

export async function handleGoalState(bot, msg) {
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  const state = userStates.get(telegramId);
  if (!state) return false;

  // ── Ветка создания новой цели ─────────────────────────────────────────────

  if (state.awaitingGoal) {
    const step = state.awaitingGoal;

    if (step === 'name') {
      userStates.set(telegramId, { ...state, awaitingGoal: 'date', name: text });
      await bot.sendMessage(
        chatId,
        `Отлично! Когда хочешь достичь этой цели?\n` +
        `Напиши месяц и год, например: март 2030 👇`
      );
      return true;
    }

    if (step === 'date') {
      const targetDate = parseRuDate(text);
      if (!targetDate) {
        await bot.sendMessage(chatId, 'Не распознал дату. Напиши месяц и год, например: март 2030 👇');
        return true;
      }
      if (targetDate <= new Date()) {
        await bot.sendMessage(chatId, 'Дата должна быть в будущем. Попробуй ещё раз 👇');
        return true;
      }
      const yyyy = targetDate.getFullYear();
      const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
      userStates.set(telegramId, { ...state, awaitingGoal: 'amount', date: `${yyyy}-${mm}-01` });
      await bot.sendMessage(chatId, `Сколько стоит эта цель в сегодняшних ценах?\nНапиши сумму в рублях 👇`);
      return true;
    }

    if (step === 'amount') {
      const amount = parseAmount(text);
      if (!amount || amount <= 0) {
        await bot.sendMessage(chatId, 'Не смог распознать сумму. Напиши числом, например: 3000000 или 3 миллиона 👇');
        return true;
      }
      userStates.set(telegramId, { ...state, awaitingGoal: 'saved', amount });
      await bot.sendMessage(chatId, `Сколько уже накоплено на эту цель?\nЕсли ничего — напиши 0 👇`);
      return true;
    }

    if (step === 'saved') {
      const saved = parseAmount(text);
      if (saved === null || saved < 0) {
        await bot.sendMessage(chatId, 'Не смог распознать сумму. Напиши числом, например: 3000000 или 3 миллиона 👇');
        return true;
      }

      if (saved >= state.amount) {
        userStates.delete(telegramId);
        await bot.sendMessage(
          chatId,
          'Похоже ты уже достиг(ла) цели! 🎉 Хочешь поставить новую?',
          {
            reply_markup: {
              inline_keyboard: [[
                { text: 'Поставить новую цель', callback_data: 'goal:new' },
                { text: '☰ Главное меню', callback_data: 'menu:main' },
              ]],
            },
          }
        );
        return true;
      }

      // Проверка лимита тарифа
      const userId = await getUserId(telegramId);
      if (!userId) {
        userStates.delete(telegramId);
        await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start 🙏');
        return true;
      }

      const [access, goals] = await Promise.all([
        getUserAccess(userId),
        getActiveGoals(userId),
      ]);
      const limit = access === 'free' ? 1 : 3;

      if (goals.length >= limit) {
        userStates.delete(telegramId);
        await bot.sendMessage(
          chatId,
          `У тебя уже ${goals.length} активных цели — это максимум для твоего тарифа.`
        );
        return true;
      }

      // Для trial/active — спросить про доходность
      if (access === 'trial' || access === 'active') {
        userStates.set(telegramId, { ...state, awaitingGoal: 'yield_question', saved, userId });
        await bot.sendMessage(
          chatId,
          `Планируешь копить с доходностью? Например, если откладываешь ` +
          `на вклад или инвестируешь 📈`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: '📈 Да, с доходностью', callback_data: 'goal:with_yield' },
                { text: 'Нет, без доходности', callback_data: 'goal:no_yield' },
              ]],
            },
          }
        );
        return true;
      }

      // Для free — расчёт без доходности и сохранение
      userStates.delete(telegramId);
      await saveGoalAndConfirm(bot, chatId, userId, { ...state, saved }, null);
      return true;
    }

    if (step === 'yield_question') {
      // Пользователь написал текст вместо нажатия кнопки
      await bot.sendMessage(chatId, 'Нажми одну из кнопок выше 👆');
      return true;
    }

    if (step === 'yield_rate') {
      const yieldPct = parseAmount(text);
      if (!yieldPct || yieldPct <= 0) {
        await bot.sendMessage(chatId, 'Введи число больше нуля, например: 10 👇');
        return true;
      }
      if (yieldPct > 35) {
        await bot.sendMessage(chatId, 'Максимум 35%. Введи реалистичную доходность 👇');
        return true;
      }

      const yieldRate = yieldPct / 100;
      const userId = state.userId;

      let warningText = '';
      if (yieldPct < 6) {
        warningText =
          `⚠️ Доходность ниже инфляции — цель дорожает быстрее чем растут твои взносы.\n\n`;
      }

      userStates.delete(telegramId);

      if (warningText) await bot.sendMessage(chatId, warningText);
      await saveGoalAndConfirm(bot, chatId, userId, state, yieldRate);
      return true;
    }
  }

  // ── Ветка редактирования поля цели ────────────────────────────────────────

  if (state.awaitingGoalEdit) {
    const { awaitingGoalEdit: field, goalId } = state;

    if (field === 'name') {
      await supabase.from('goals').update({ name: text }).eq('id', goalId);
      userStates.delete(telegramId);
      await bot.sendMessage(chatId, `Название изменено на «${text}» ✅`);
      return true;
    }

    if (field === 'amount') {
      const amount = parseAmount(text);
      if (!amount || amount <= 0) {
        await bot.sendMessage(chatId, 'Не смог распознать сумму. Напиши числом, например: 3000000 или 3 миллиона 👇');
        return true;
      }
      const { data: goal } = await supabase.from('goals').select('*').eq('id', goalId).single();
      let calc;
      try {
        calc = calculateMonthlyPayment({
          targetAmount: amount,
          initialSaved: goal.initial_saved ?? 0,
          targetDate: goal.target_date,
          yieldRate: goal.yield_rate ?? null,
        });
      } catch (e) {
        await bot.sendMessage(chatId, `${e.message} 🎉`);
        return true;
      }
      await supabase.from('goals')
        .update({ target_amount: amount, future_value: calc.futureValue, monthly_payment: calc.monthlyPayment, last_recalculated_at: new Date().toISOString() })
        .eq('id', goalId);
      userStates.delete(telegramId);
      await bot.sendMessage(chatId, `Сумма цели изменена. Новый взнос: ${formatNum(calc.monthlyPayment)} ₽/мес ✅`);
      return true;
    }

    if (field === 'date') {
      const targetDate = parseRuDate(text);
      if (!targetDate) {
        await bot.sendMessage(chatId, 'Не распознал дату. Напиши месяц и год, например: март 2030 👇');
        return true;
      }
      if (targetDate <= new Date()) {
        await bot.sendMessage(chatId, 'Дата должна быть в будущем. Попробуй ещё раз 👇');
        return true;
      }
      const yyyy = targetDate.getFullYear();
      const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
      const newDate = `${yyyy}-${mm}-01`;
      const { data: goal } = await supabase.from('goals').select('*').eq('id', goalId).single();
      let calc;
      try {
        calc = calculateMonthlyPayment({
          targetAmount: goal.target_amount,
          initialSaved: goal.initial_saved ?? 0,
          targetDate: newDate,
          yieldRate: goal.yield_rate ?? null,
        });
      } catch (e) {
        await bot.sendMessage(chatId, `${e.message} 🎉`);
        return true;
      }
      await supabase.from('goals')
        .update({ target_date: newDate, future_value: calc.futureValue, monthly_payment: calc.monthlyPayment, last_recalculated_at: new Date().toISOString() })
        .eq('id', goalId);
      userStates.delete(telegramId);
      await bot.sendMessage(chatId, `Срок изменён на ${formatGoalDate(newDate)}. Новый взнос: ${formatNum(calc.monthlyPayment)} ₽/мес ✅`);
      return true;
    }

    if (field === 'saved') {
      const saved = parseAmount(text);
      if (saved === null || saved < 0) {
        await bot.sendMessage(chatId, 'Не смог распознать сумму. Напиши числом, например: 3000000 или 3 миллиона 👇');
        return true;
      }
      const { data: goal } = await supabase.from('goals').select('*').eq('id', goalId).single();
      let calc;
      try {
        calc = calculateMonthlyPayment({
          targetAmount: goal.target_amount,
          initialSaved: saved,
          targetDate: goal.target_date,
          yieldRate: goal.yield_rate ?? null,
        });
      } catch (e) {
        await bot.sendMessage(chatId, `${e.message} 🎉`);
        return true;
      }
      await supabase.from('goals')
        .update({ initial_saved: saved, future_value: calc.futureValue, monthly_payment: calc.monthlyPayment, last_recalculated_at: new Date().toISOString() })
        .eq('id', goalId);
      userStates.delete(telegramId);
      await bot.sendMessage(chatId, `Накопленная сумма обновлена. Новый взнос: ${formatNum(calc.monthlyPayment)} ₽/мес ✅`);
      return true;
    }
  }

  return false;
}

// ── Прогресс по цели ──────────────────────────────────────────────────────────

async function showGoalProgress(bot, chatId, userId, goal) {
  const { data: catData } = await supabase
    .from('categories')
    .select('id')
    .eq('name', 'Цель')
    .single();

  let totalGoalTx = 0;
  if (catData?.id) {
    const { data: txData } = await supabase
      .from('transactions')
      .select('amount')
      .eq('user_id', userId)
      .eq('category_id', catData.id);
    totalGoalTx = txData?.reduce((sum, t) => sum + (t.amount ?? 0), 0) ?? 0;
  }

  const accumulated = (goal.initial_saved ?? 0) + totalGoalTx;
  const percent = Math.min(100, Math.round((accumulated / goal.future_value) * 100));
  const remaining = Math.max(0, goal.future_value - accumulated);

  let text =
    `🎯 ${goal.name}\n\n` +
    `💰 Цель: ${formatNum(goal.future_value)} ₽ (с учётом инфляции)\n` +
    `✅ Уже накоплено: ${formatNum(accumulated)} ₽\n` +
    `📊 Прогресс: ${percent}%\n` +
    `📅 Осталось накопить: ${formatNum(remaining)} ₽\n` +
    `🗓 Срок: ${formatGoalDate(goal.target_date)}\n\n`;

  if (goal.yield_rate) {
    const { monthlyPayment: monthlyNoYield } = calculateMonthlyPayment({
      targetAmount: goal.target_amount,
      initialSaved: goal.initial_saved ?? 0,
      targetDate: goal.target_date,
      yieldRate: null,
    });
    const savings = Math.max(0, monthlyNoYield - goal.monthly_payment);
    text +=
      `💡 С доходностью ${Math.round(goal.yield_rate * 100)}%: ${formatNum(goal.monthly_payment)} ₽/мес\n` +
      `📉 Без доходности: ${formatNum(monthlyNoYield)} ₽/мес\n` +
      `💚 Экономия: ${formatNum(savings)} ₽/мес`;
  } else {
    text += `💡 Нужно откладывать: ${formatNum(goal.monthly_payment)} ₽/мес`;
  }

  await bot.sendMessage(chatId, text, MENU_KEYBOARD);
}

// ── Обработчик кнопок goal: ───────────────────────────────────────────────────

export async function handleGoalCallback(bot, query) {
  const chatId = query.message.chat.id;
  const telegramId = query.from.id;
  const action = query.data;
  const parts = action.split(':');

  await bot.answerCallbackQuery(query.id);

  // ── Начать диалог новой/первой цели ───────────────────────────────────────

  if (action === 'goal:new') {
    userStates.set(telegramId, { awaitingGoal: 'name' });
    await bot.sendMessage(
      chatId,
      `🎯 Давай поставим финансовую цель!\n\n` +
      `Как она называется? Например: «Купить квартиру», ` +
      `«Накопить подушку безопасности», «Новая машина» 👇`
    );
    return;
  }

  // ── Добавить новую цель (с проверкой лимита) ─────────────────────────────

  if (action === 'goal:add_new') {
    const userId = await getUserId(telegramId);
    if (!userId) return;
    const [goals, access] = await Promise.all([getActiveGoals(userId), getUserAccess(userId)]);
    const maxCount = access === 'free' ? 1 : 3;
    if (goals.length >= maxCount) {
      await bot.sendMessage(chatId, `У тебя уже ${goals.length} ${pluralGoal(goals.length)} — это максимум для твоего тарифа 💛`);
      return;
    }
    userStates.set(telegramId, { awaitingGoal: 'name' });
    await bot.sendMessage(
      chatId,
      `🎯 Давай поставим ещё одну финансовую цель!\n\n` +
      `Как она называется? Например: «Купить квартиру», ` +
      `«Накопить подушку безопасности», «Новая машина» 👇`
    );
    return;
  }

  // ── Доходность: нет ───────────────────────────────────────────────────────

  if (action === 'goal:no_yield') {
    const state = userStates.get(telegramId);
    if (!state?.userId) return;
    userStates.delete(telegramId);
    await saveGoalAndConfirm(bot, chatId, state.userId, state, null);
    return;
  }

  // ── Доходность: да ────────────────────────────────────────────────────────

  if (action === 'goal:with_yield') {
    const state = userStates.get(telegramId);
    if (!state) return;
    userStates.set(telegramId, { ...state, awaitingGoal: 'yield_rate' });
    await bot.sendMessage(
      chatId,
      `Какую доходность ожидаешь? Напиши число в процентах годовых, например: 10\n\n` +
      `Максимум 35%. Это твой прогноз — бот не даёт инвестиционных рекомендаций 🙏`
    );
    return;
  }

  // ── Показать карточку цели из списка: goal:show:{goalId} ─────────────────

  if (parts[1] === 'show' && parts[2]) {
    const userId = await getUserId(telegramId);
    if (!userId) return;
    const [{ data: goal }, goals, access] = await Promise.all([
      supabase.from('goals').select('*').eq('id', parts[2]).single(),
      getActiveGoals(userId),
      getUserAccess(userId),
    ]);
    if (!goal) {
      await bot.sendMessage(chatId, 'Цель не найдена 🤔');
      return;
    }
    const maxCount = access === 'free' ? 1 : 3;
    await bot.sendMessage(
      chatId,
      goalCardText(goal, goals.length, maxCount),
      goalCardKeyboard(goal, goals.length < maxCount)
    );
    return;
  }

  // ── Прогресс: goal:progress:{goalId} ─────────────────────────────────────

  if (parts[1] === 'progress') {
    const userId = await getUserId(telegramId);
    if (!userId) {
      await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start 🙏');
      return;
    }

    let goal;
    if (parts[2]) {
      const { data } = await supabase.from('goals').select('*').eq('id', parts[2]).single();
      goal = data;
    } else {
      const goals = await getActiveGoals(userId);
      goal = goals[0] ?? null;
    }

    if (!goal) {
      await bot.sendMessage(chatId, 'У тебя пока нет активной цели. Хочешь поставить? 💛', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎯 Поставить цель', callback_data: 'goal:new' }],
            [{ text: '☰ Главное меню', callback_data: 'menu:main' }],
          ],
        },
      });
      return;
    }

    await showGoalProgress(bot, chatId, userId, goal);
    return;
  }

  // ── Изменить: goal:edit:{goalId} — показать меню ─────────────────────────

  if (parts[1] === 'edit' && parts[2]) {
    const goalId = parts[2];
    const { data: goal } = await supabase.from('goals').select('name').eq('id', goalId).single();

    await bot.sendMessage(
      chatId,
      `Что хочешь изменить в цели «${goal?.name ?? ''}»?`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Название', callback_data: `goal:edit_name:${goalId}` },
              { text: 'Сумму цели', callback_data: `goal:edit_amount:${goalId}` },
            ],
            [
              { text: 'Срок', callback_data: `goal:edit_date:${goalId}` },
              { text: 'Сколько накоплено', callback_data: `goal:edit_saved:${goalId}` },
            ],
          ],
        },
      }
    );
    return;
  }

  // ── Редактирование поля: goal:edit_{field}:{goalId} ───────────────────────

  if (parts[1] === 'edit_name') {
    userStates.set(telegramId, { awaitingGoalEdit: 'name', goalId: parts[2] });
    await bot.sendMessage(chatId, 'Напиши новое название цели 👇');
    return;
  }

  if (parts[1] === 'edit_amount') {
    userStates.set(telegramId, { awaitingGoalEdit: 'amount', goalId: parts[2] });
    await bot.sendMessage(chatId, 'Напиши новую стоимость цели в рублях 👇');
    return;
  }

  if (parts[1] === 'edit_date') {
    userStates.set(telegramId, { awaitingGoalEdit: 'date', goalId: parts[2] });
    await bot.sendMessage(chatId, 'Напиши новый срок — месяц и год, например: март 2032 👇');
    return;
  }

  if (parts[1] === 'edit_saved') {
    userStates.set(telegramId, { awaitingGoalEdit: 'saved', goalId: parts[2] });
    await bot.sendMessage(chatId, 'Сколько уже накоплено? Напиши сумму 👇');
    return;
  }

  // ── Удалить: goal:delete:{goalId} — запросить подтверждение ──────────────

  if (parts[1] === 'delete' && parts[2]) {
    const goalId = parts[2];
    const { data: goal } = await supabase.from('goals').select('name').eq('id', goalId).single();

    await bot.sendMessage(
      chatId,
      `Удалить цель «${goal?.name ?? goalId}» безвозвратно?\nВсе данные о пополнениях сохранятся.`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🗑 Да, удалить', callback_data: `goal:confirm_delete:${goalId}` },
            { text: 'Оставить', callback_data: 'goal:cancel_delete' },
          ]],
        },
      }
    );
    return;
  }

  // ── Подтверждение удаления ────────────────────────────────────────────────

  if (parts[1] === 'confirm_delete') {
    await supabase.from('goals').update({ status: 'archived' }).eq('id', parts[2]);
    await bot.sendMessage(chatId, 'Цель удалена ✅');
    return;
  }

  // ── Отмена удаления ───────────────────────────────────────────────────────

  if (action === 'goal:cancel_delete') {
    await bot.sendMessage(chatId, 'Цель сохранена 💛');
    return;
  }
}
