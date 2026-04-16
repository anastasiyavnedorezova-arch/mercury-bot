import { supabase } from '../db.js';
import { userStates } from '../state.js';

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

export async function showCategories(bot, chatId, telegramId) {
  const userId = await getUserId(telegramId);
  if (!userId) {
    await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start 🙏');
    return;
  }

  const { data: groups } = await supabase
    .from('category_groups')
    .select('id, name, type')
    .order('type')
    .order('name');

  const { data: systemCats } = await supabase
    .from('categories')
    .select('name, group_id')
    .eq('is_system', true)
    .eq('is_active', true)
    .order('name');

  const { data: userCats } = await supabase
    .from('categories')
    .select('id, name, type')
    .eq('user_id', userId)
    .eq('is_system', false)
    .eq('is_active', true)
    .order('name');

  let text = '📂 Твои категории\n\nСистемные (изменить нельзя):\n';

  if (groups && systemCats) {
    const catsByGroup = {};
    for (const cat of systemCats) {
      if (!catsByGroup[cat.group_id]) catsByGroup[cat.group_id] = [];
      catsByGroup[cat.group_id].push(cat.name);
    }
    for (const group of groups) {
      const cats = catsByGroup[group.id];
      if (cats?.length) {
        text += `${group.name}: ${cats.join(', ')}\n`;
      }
    }
  }

  if (userCats?.length) {
    text += '\nТвои категории:\n';
    for (const cat of userCats) {
      text += `• ${cat.name} (${cat.type === 'expense' ? 'расход' : 'доход'})\n`;
    }
  } else {
    text += '\nПользовательских категорий пока нет.';
  }

  const keyboard = [];

  if (userCats?.length) {
    for (const cat of userCats) {
      keyboard.push([
        { text: `🗑 ${cat.name}`, callback_data: `delete_category:${cat.id}` },
      ]);
    }
  }

  keyboard.push([
    { text: '➕ Добавить категорию', callback_data: 'add_category' },
    { text: '☰ Главное меню', callback_data: 'menu:main' },
  ]);

  await bot.sendMessage(chatId, text, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

export async function handleCategoriesCallback(bot, query) {
  const chatId = query.message.chat.id;
  const telegramId = query.from.id;
  const action = query.data;

  await bot.answerCallbackQuery(query.id);

  // ── Добавить категорию: шаг 1 — выбор типа ──────────────────────────────

  if (action === 'add_category') {
    await bot.sendMessage(chatId, 'Это расход или доход?', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Расход', callback_data: 'add_cat_type:expense' },
            { text: 'Доход', callback_data: 'add_cat_type:income' },
          ],
        ],
      },
    });
    return;
  }

  // ── Шаг 2 — выбор группы ────────────────────────────────────────────────

  if (action.startsWith('add_cat_type:')) {
    const type = action.split(':')[1];

    const { data: groups } = await supabase
      .from('category_groups')
      .select('id, name')
      .eq('type', type)
      .order('name');

    if (!groups?.length) {
      await bot.sendMessage(chatId, 'Не нашёл группы для этого типа 🤔', MENU_KEYBOARD);
      return;
    }

    const keyboard = groups.map(g => ([
      { text: g.name, callback_data: `add_cat_group:${g.id}:${type}` },
    ]));
    keyboard.push([{ text: '☰ Главное меню', callback_data: 'menu:main' }]);

    await bot.sendMessage(chatId, 'В какую группу добавить категорию?', {
      reply_markup: { inline_keyboard: keyboard },
    });
    return;
  }

  // ── Шаг 3 — запросить название ───────────────────────────────────────────

  if (action.startsWith('add_cat_group:')) {
    const parts = action.split(':');
    const groupId = parts[1];
    const type = parts[2];

    userStates.set(telegramId, { awaitingCategoryName: true, groupId, type });

    await bot.sendMessage(chatId, 'Напиши название новой категории 👇');
    return;
  }

  // ── Удаление: запрос подтверждения ───────────────────────────────────────

  if (action.startsWith('delete_category:')) {
    const categoryId = action.split(':')[1];
    const userId = await getUserId(telegramId);
    if (!userId) return;

    const { data: cat } = await supabase
      .from('categories')
      .select('id, name')
      .eq('id', categoryId)
      .eq('is_system', false)
      .eq('user_id', userId)
      .maybeSingle();

    if (!cat) {
      await bot.sendMessage(chatId, 'Категория не найдена 🤔', MENU_KEYBOARD);
      return;
    }

    await bot.sendMessage(
      chatId,
      `Удалить категорию «${cat.name}»?\nЗаписи с этой категорией останутся.`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Удалить', callback_data: `confirm_delete:${cat.id}` },
              { text: 'Отмена', callback_data: 'cancel_delete' },
            ],
          ],
        },
      }
    );
    return;
  }

  // ── Подтверждение удаления ───────────────────────────────────────────────

  if (action.startsWith('confirm_delete:')) {
    const categoryId = action.split(':')[1];
    const userId = await getUserId(telegramId);
    if (!userId) return;

    await supabase
      .from('categories')
      .update({ is_active: false })
      .eq('id', categoryId)
      .eq('is_system', false)
      .eq('user_id', userId);

    await bot.sendMessage(chatId, 'Категория удалена ✅');
    await showCategories(bot, chatId, telegramId);
    return;
  }

  if (action === 'cancel_delete') {
    await showCategories(bot, chatId, telegramId);
    return;
  }
}

export async function handleCategoryNameState(bot, msg) {
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;
  const state = userStates.get(telegramId);

  if (!state?.awaitingCategoryName) return false;

  const name = msg.text?.trim();
  if (!name) {
    await bot.sendMessage(chatId, 'Напиши название текстом 👇');
    return true;
  }

  const { groupId, type } = state;
  const userId = await getUserId(telegramId);

  if (!userId) {
    userStates.delete(telegramId);
    await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start 🙏');
    return true;
  }

  // Проверяем дубликат у пользователя
  const { count } = await supabase
    .from('categories')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('name', name)
    .eq('is_active', true);

  if (count > 0) {
    await bot.sendMessage(chatId, 'Такая категория уже существует 🤔\nПопробуй другое название:');
    return true;
  }

  userStates.delete(telegramId);

  await supabase.from('categories').insert({
    group_id: groupId,
    user_id: userId,
    name,
    type,
    is_system: false,
    is_active: true,
    synonyms: '{}',
  });

  await bot.sendMessage(
    chatId,
    `Категория «${name}» добавлена ✅\n` +
    `Теперь можешь использовать её при записи трат.\n` +
    `Например: «${name} 1500»`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '➕ Добавить ещё', callback_data: 'add_category' },
            { text: '☰ Главное меню', callback_data: 'menu:main' },
          ],
        ],
      },
    }
  );

  return true;
}
