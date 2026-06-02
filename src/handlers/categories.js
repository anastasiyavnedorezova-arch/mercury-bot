import { queryOne, queryAll, queryCount, run } from '../db.js';
import { userStates } from '../state.js';

const MENU_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]],
  },
};

async function getUserId(telegramId) {
  const { data } = await queryOne(
    `SELECT id FROM users WHERE external_id = $1 AND channel = 'telegram'`,
    [String(telegramId)]
  );
  return data?.id ?? null;
}

export async function showCategories(bot, chatId, telegramId) {
  const userId = await getUserId(telegramId);
  if (!userId) {
    await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start 🙏');
    return;
  }

  await bot.sendMessage(chatId, '📂 Категории', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 Мои категории', callback_data: 'my_categories' }],
        [{ text: '🗂 Все категории', callback_data: 'show_all_categories' }],
        [{ text: '➕ Добавить категорию', callback_data: 'add_category' }],
        [{ text: '☰ Главное меню', callback_data: 'menu:main' }],
      ],
    },
  });
}

async function showMyCategories(bot, chatId, telegramId) {
  const userId = await getUserId(telegramId);
  if (!userId) return;

  const { data: userCats } = await queryAll(
    `SELECT id, name, type FROM categories
     WHERE user_id = $1 AND is_system = false AND is_active = true
     ORDER BY name`,
    [userId]
  );

  const keyboard = [];

  if (userCats?.length) {
    let text = '📂 Твои категории:\n\n';
    for (const cat of userCats) {
      text += `• ${cat.name} (${cat.type === 'expense' ? 'расход' : 'доход'})\n`;
      keyboard.push([{ text: `🗑 Удалить «${cat.name}»`, callback_data: `delete_category:${cat.id}` }]);
    }
    keyboard.push([
      { text: '➕ Добавить категорию', callback_data: 'add_category' },
      { text: '☰ Главное меню', callback_data: 'menu:main' },
    ]);
    await bot.sendMessage(chatId, text.trim(), { reply_markup: { inline_keyboard: keyboard } });
  } else {
    await bot.sendMessage(chatId, 'Пользовательских категорий пока нет.', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Добавить категорию', callback_data: 'add_category' }],
          [{ text: '☰ Главное меню', callback_data: 'menu:main' }],
        ],
      },
    });
  }
}

async function showAllCategories(bot, chatId) {
  const text =
`📋 <b>Все категории Меркури:</b>

💰 <b>ДОХОДЫ:</b>
<b>Доход за работу и выплаты:</b> Зарплата, Фриланс и подработка, Продажа и соцвыплаты
<b>Доходность вложений и кешбек:</b> Проценты по вкладу, Инвестиционный доход, Кэшбек и бонусы
<b>Подарки и возвраты:</b> Подарки мне, Возврат денег, Долг мне вернули

💸 <b>РАСХОДЫ:</b>
<b>Еда:</b> Продукты, Кафе и рестораны, Кофе на вынос, Доставка еды
<b>Жильё и дом:</b> Жильё, Товары в дом, Техника и мебель
<b>Транспорт:</b> Транспорт, Авто
<b>Здоровье и красота:</b> Здоровье, Красота и уход за собой, Спорт
<b>Досуг и развлечения:</b> Одежда и обувь, Путешествия, Отдых и развлечения, Обучение, Подписки, Подарки другим
<b>Финансы и обязательства:</b> Кредиты и займы, Налоги и штрафы, Комиссии, Долг я дал, Благотворительность, Связь и интернет, Цель
<b>Другое:</b> Дети, Животные, Остальное`;

  await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '➕ Добавить свою категорию', callback_data: 'add_category' }],
        [{ text: '☰ Главное меню', callback_data: 'menu:main' }],
      ],
    },
  });
}

export async function handleCategoriesCallback(bot, query) {
  const chatId = query.message.chat.id;
  const telegramId = query.from.id;
  const action = query.data;

  await bot.answerCallbackQuery(query.id);

  if (action === 'my_categories') {
    await showMyCategories(bot, chatId, telegramId);
    return;
  }

  if (action === 'show_all_categories') {
    await showAllCategories(bot, chatId);
    return;
  }

  if (action === 'add_category') {
    await bot.sendMessage(chatId, 'Это расход или доход?', {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Расход', callback_data: 'add_cat_type:expense' },
          { text: 'Доход', callback_data: 'add_cat_type:income' },
        ]],
      },
    });
    return;
  }

  if (action.startsWith('add_cat_type:')) {
    const type = action.split(':')[1];

    const { data: groups } = await queryAll(
      `SELECT id, name FROM category_groups WHERE type = $1 ORDER BY name`,
      [type]
    );

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

  if (action.startsWith('add_cat_group:')) {
    const parts = action.split(':');
    const groupId = parts[1];
    const type = parts[2];

    userStates.set(telegramId, { awaitingCategoryName: true, groupId, type });
    await bot.sendMessage(chatId, 'Напиши название новой категории 👇');
    return;
  }

  if (action.startsWith('delete_category:')) {
    const categoryId = action.split(':')[1];
    const userId = await getUserId(telegramId);
    if (!userId) return;

    const { data: cat } = await queryOne(
      `SELECT id, name FROM categories
       WHERE id = $1 AND is_system = false AND user_id = $2`,
      [categoryId, userId]
    );

    if (!cat) {
      await bot.sendMessage(chatId, 'Категория не найдена 🤔', MENU_KEYBOARD);
      return;
    }

    await bot.sendMessage(
      chatId,
      `Удалить категорию «${cat.name}»?\nЗаписи с этой категорией останутся.`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Удалить', callback_data: `confirm_delete:${cat.id}` },
            { text: 'Отмена', callback_data: 'cancel_delete' },
          ]],
        },
      }
    );
    return;
  }

  if (action.startsWith('confirm_delete:')) {
    const categoryId = action.split(':')[1];
    const userId = await getUserId(telegramId);
    if (!userId) return;

    await run(
      `UPDATE categories SET is_active = false
       WHERE id = $1 AND is_system = false AND user_id = $2`,
      [categoryId, userId]
    );

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

  const { count } = await queryCount(
    `SELECT COUNT(*) FROM categories
     WHERE user_id = $1 AND name = $2 AND is_active = true`,
    [userId, name]
  );

  if (count > 0) {
    await bot.sendMessage(chatId, 'Такая категория уже существует 🤔\nПопробуй другое название:');
    return true;
  }

  userStates.delete(telegramId);

  await run(
    `INSERT INTO categories (group_id, user_id, name, type, is_system, is_active, synonyms)
     VALUES ($1, $2, $3, $4, false, true, '{}')`,
    [groupId, userId, name, type]
  );

  await bot.sendMessage(
    chatId,
    `Категория «${name}» добавлена ✅\n` +
    `Теперь можешь использовать её при записи трат.\n` +
    `Например: «${name} 1500»`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '➕ Добавить ещё', callback_data: 'add_category' },
          { text: '☰ Главное меню', callback_data: 'menu:main' },
        ]],
      },
    }
  );

  return true;
}
