import { supabase } from '../db.js';
import { getUserAccess } from '../utils/access.js';
import { userStates } from '../state.js';

const PAYWALL_TEXT =
  'Редактирование доступно в подписке. Хочешь активировать 30 дней бесплатно? 💛';

const TYPE_RU = { expense: 'расход', income: 'доход', goal: 'цель' };

const MENU_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]],
  },
};

async function fetchAndShowTx(bot, chatId, txId) {
  const { data } = await supabase
    .from('transactions')
    .select('amount, type, transaction_date, categories(name)')
    .eq('id', txId)
    .single();

  if (!data) {
    await bot.sendMessage(chatId, 'Запись обновлена ✅', MENU_KEYBOARD);
    return;
  }

  const text =
    `✅ Исправлено!\n\n` +
    `📅 Дата: ${data.transaction_date}\n` +
    `📌 Тип: ${TYPE_RU[data.type] ?? data.type}\n` +
    `📂 Категория: ${data.categories?.name ?? '—'}\n` +
    `💸 Сумма: ${data.amount} ₽`;

  await bot.sendMessage(chatId, text, MENU_KEYBOARD);
}

async function getUserId(telegramId) {
  const { data } = await supabase
    .from('users')
    .select('id')
    .eq('external_id', String(telegramId))
    .eq('channel', 'telegram')
    .single();
  return data?.id ?? null;
}

// Возвращает false и отправляет paywall-сообщение, если доступ 'free'.
async function checkAccess(bot, chatId, telegramId) {
  const userId = await getUserId(telegramId);
  if (!userId) return false;
  const access = await getUserAccess(userId);
  if (access === 'free') {
    await bot.sendMessage(chatId, PAYWALL_TEXT);
    return false;
  }
  return true;
}

// Вызывается из handleMessage когда state.awaitingTxEdit установлен.
// Возвращает true если состояние было обработано.
export async function handleTxEditState(bot, msg) {
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;
  const text = msg.text;

  const state = userStates.get(telegramId);
  if (!state?.awaitingTxEdit) return false;

  if (!text) {
    await bot.sendMessage(chatId, 'Отправь текстовое сообщение 🙏');
    return true;
  }

  userStates.delete(telegramId);
  const { awaitingTxEdit: field, transactionId: txId } = state;

  if (field === 'amount') {
    const amount = parseFloat(text.replace(',', '.'));
    if (isNaN(amount) || amount <= 0) {
      await bot.sendMessage(chatId, 'Не распознал сумму. Напиши числом, например: 2500 🙏');
      return true;
    }
    await supabase.from('transactions').update({ amount }).eq('id', txId);
    await fetchAndShowTx(bot, chatId, txId);
    return true;
  }

  if (field === 'date') {
    const match = text.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!match) {
      await bot.sendMessage(
        chatId,
        'Не распознал дату. Напиши в формате ДД.ММ.ГГГГ, например 25.03.2026 🙏'
      );
      return true;
    }
    const [, dd, mm, yyyy] = match;
    const dateObj = new Date(`${yyyy}-${mm}-${dd}`);
    if (isNaN(dateObj.getTime())) {
      await bot.sendMessage(chatId, 'Дата некорректная. Попробуй ещё раз 🙏');
      return true;
    }
    await supabase
      .from('transactions')
      .update({ transaction_date: `${yyyy}-${mm}-${dd}` })
      .eq('id', txId);
    await fetchAndShowTx(bot, chatId, txId);
    return true;
  }

  return false;
}

export async function handleTransactionCallback(bot, query) {
  const chatId = query.message.chat.id;
  const telegramId = query.from.id;
  const action = query.data; // 'tx:verb:arg1:arg2'

  await bot.answerCallbackQuery(query.id);

  const parts = action.split(':');
  const verb = parts[1];

  // ── [Исправить] ───────────────────────────────────────────────────────────

  if (verb === 'edit') {
    const txId = parts[2];
    if (!(await checkAccess(bot, chatId, telegramId))) return;

    await bot.sendMessage(chatId, 'Что хочешь исправить?', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Сумму', callback_data: `tx:amount:${txId}` },
            { text: 'Категорию', callback_data: `tx:category:${txId}` },
          ],
          [
            { text: 'Дату', callback_data: `tx:date:${txId}` },
            { text: 'Тип операции', callback_data: `tx:type:${txId}` },
          ],
        ],
      },
    });
    return;
  }

  // ── [Сумму] ───────────────────────────────────────────────────────────────

  if (verb === 'amount') {
    const txId = parts[2];
    if (!(await checkAccess(bot, chatId, telegramId))) return;

    userStates.set(telegramId, { awaitingTxEdit: 'amount', transactionId: txId });
    await bot.sendMessage(chatId, 'Напиши новую сумму числом 👇');
    return;
  }

  // ── [Категорию] ───────────────────────────────────────────────────────────

  if (verb === 'category') {
    const txId = parts[2];
    if (!(await checkAccess(bot, chatId, telegramId))) return;

    userStates.set(telegramId, { awaitingTxCategoryEdit: true, transactionId: txId });

    const { data: groups } = await supabase
      .from('category_groups')
      .select('id, name')
      .order('name');

    if (!groups?.length) {
      await bot.sendMessage(chatId, 'Не удалось загрузить категории 🙏');
      return;
    }

    const rows = [];
    for (let i = 0; i < groups.length; i += 2) {
      rows.push(
        groups.slice(i, i + 2).map((g) => ({
          text: g.name,
          callback_data: `tx:cg:${g.id}`,
        }))
      );
    }

    await bot.sendMessage(chatId, 'Выбери группу категорий:', {
      reply_markup: { inline_keyboard: rows },
    });
    return;
  }

  // ── Выбор группы → показать категории ────────────────────────────────────

  if (verb === 'cg') {
    const groupId = parts[2];
    const state = userStates.get(telegramId);
    if (!state?.awaitingTxCategoryEdit) return;

    const { data: cats } = await supabase
      .from('categories')
      .select('id, name')
      .eq('group_id', groupId)
      .order('name');

    if (!cats?.length) {
      await bot.sendMessage(chatId, 'В этой группе нет категорий 🙏');
      return;
    }

    const rows = [];
    for (let i = 0; i < cats.length; i += 2) {
      rows.push(
        cats.slice(i, i + 2).map((c) => ({
          text: c.name,
          callback_data: `tx:cc:${c.id}`,
        }))
      );
    }

    await bot.sendMessage(chatId, 'Выбери категорию:', {
      reply_markup: { inline_keyboard: rows },
    });
    return;
  }

  // ── Выбор категории → обновить в БД ──────────────────────────────────────

  if (verb === 'cc') {
    const categoryId = parts[2];
    const state = userStates.get(telegramId);
    if (!state?.awaitingTxCategoryEdit) return;

    const txId = state.transactionId;
    userStates.delete(telegramId);

    await supabase.from('transactions').update({ category_id: categoryId }).eq('id', txId);
    await fetchAndShowTx(bot, chatId, txId);
    return;
  }

  // ── [Дату] ────────────────────────────────────────────────────────────────

  if (verb === 'date') {
    const txId = parts[2];
    if (!(await checkAccess(bot, chatId, telegramId))) return;

    userStates.set(telegramId, { awaitingTxEdit: 'date', transactionId: txId });
    await bot.sendMessage(
      chatId,
      'Напиши дату в формате ДД.ММ.ГГГГ, например 25.03.2026 👇'
    );
    return;
  }

  // ── [Тип операции] ────────────────────────────────────────────────────────

  if (verb === 'type') {
    const txId = parts[2];
    if (!(await checkAccess(bot, chatId, telegramId))) return;

    await bot.sendMessage(chatId, 'Выбери тип операции:', {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Расход', callback_data: `tx:type_pick:expense:${txId}` },
          { text: 'Доход', callback_data: `tx:type_pick:income:${txId}` },
        ]],
      },
    });
    return;
  }

  // ── Применить тип операции ────────────────────────────────────────────────

  if (verb === 'type_pick') {
    const type = parts[2]; // 'expense' или 'income'
    const txId = parts[3];

    await supabase.from('transactions').update({ type }).eq('id', txId);
    await fetchAndShowTx(bot, chatId, txId);
    return;
  }

  // ── [Удалить] — запросить подтверждение ───────────────────────────────────

  if (verb === 'delete') {
    const txId = parts[2];
    if (!(await checkAccess(bot, chatId, telegramId))) return;

    await bot.sendMessage(chatId, 'Удалить эту запись безвозвратно?', {
      reply_markup: {
        inline_keyboard: [[
          { text: '🗑 Удалить безвозвратно', callback_data: `tx:confirm_delete:${txId}` },
          { text: 'Оставить', callback_data: 'tx:cancel_delete' },
        ]],
      },
    });
    return;
  }

  // ── Подтверждение удаления ────────────────────────────────────────────────

  if (verb === 'confirm_delete') {
    const txId = parts[2];

    await supabase.from('transactions').delete().eq('id', txId);
    await bot.sendMessage(chatId, 'Запись удалена ✅');
    return;
  }

  // ── Отмена удаления ───────────────────────────────────────────────────────

  if (verb === 'cancel_delete') {
    await bot.sendMessage(chatId, 'Запись сохранена 💛');
    return;
  }
}
