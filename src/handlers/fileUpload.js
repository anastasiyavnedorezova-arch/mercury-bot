import fs from 'fs';
import path from 'path';
import https from 'https';
import OpenAI from 'openai';
import { supabase } from '../db.js';
import { userStates } from '../state.js';
import { getUserAccess } from '../utils/access.js';
import { saveTransaction } from './message.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const STATEMENT_SYSTEM_PROMPT = `Ты — парсер банковских выписок. Проанализируй изображение(я) банковской выписки и извлеки все транзакции.

Верни ТОЛЬКО валидный JSON массив объектов. Никакого текста до или после.
Если транзакций не найдено — верни пустой массив [].

Формат каждой транзакции:
{
  "transaction_date": "YYYY-MM-DD",
  "description": "описание операции как в выписке",
  "amount": число (всегда положительное),
  "type": "expense" | "income",
  "category": "точное название категории из списка ниже",
  "comment": "название магазина или места если указано, иначе null",
  "confidence": "high" | "low"
}

Используй "confidence": "low" если не уверен в сумме, дате или категории.

КАТЕГОРИИ ДОХОДОВ:
Зарплата, Фриланс и подработка, Продажа и соцвыплаты, Проценты по вкладу,
Инвестиционный доход, Кэшбек и бонусы, Подарки мне, Возврат денег, Долг мне вернули

КАТЕГОРИИ РАСХОДОВ:
Продукты, Кафе, рестораны, Кофе на вынос, Доставка еды,
Жильё, Дом и быт, Техника и мебель,
Транспорт, Авто,
Здоровье, Красота, Спорт,
Одежда и обувь, Путешествия, Отдых и развлечения, Обучение, Подписки, Подарки другим,
Кредиты и займы, Налоги, Комиссии, Долг я дал, Благотворительность, Связь и интернет, Цель,
Дети, Животные, Другое`;

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

async function downloadTelegramFile(bot, fileId) {
  const file = await bot.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const ext = path.extname(file.file_path) || '.jpg';
  const tmpPath = path.join('/tmp', `stmt_${Date.now()}${ext}`);
  await downloadFile(url, tmpPath);
  return { tmpPath, filePath: file.file_path };
}

function mimeFromExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.pdf') return 'application/pdf';
  return 'image/jpeg';
}

function splitMessage(text, maxLen = 4096) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let current = '';
  for (const line of text.split('\n')) {
    if ((current + '\n' + line).length > maxLen) {
      if (current) parts.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) parts.push(current);
  return parts;
}

async function analyzeStatement(base64Content, mimeType) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: STATEMENT_SYSTEM_PROMPT },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${base64Content}`,
              detail: 'high',
            },
          },
        ],
      },
    ],
    max_tokens: 4000,
    temperature: 0,
  });

  const raw = response.choices[0].message.content.trim();
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(cleaned);
}

async function checkDuplicates(userId, transactions) {
  const result = [];
  for (const tx of transactions) {
    const { count } = await supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('transaction_date', tx.transaction_date)
      .eq('amount', tx.amount);
    result.push({ ...tx, isDuplicate: count > 0 });
  }
  return result;
}

function buildSummaryText(transactions) {
  const newOnes = transactions.filter((t) => !t.isDuplicate);
  const dupCount = transactions.length - newOnes.length;
  const show = transactions.slice(0, 20);

  let text = `📄 Нашёл ${transactions.length} транзакций в выписке:\n\n`;
  for (const tx of show) {
    const emoji = tx.type === 'income' ? '📈' : '📉';
    const dup = tx.isDuplicate ? ' ⚠️дубль' : '';
    const comment = tx.comment ? ` (${tx.comment})` : '';
    text += `${emoji} ${tx.transaction_date} — ${tx.category}: ${tx.amount} ₽${comment}${dup}\n`;
  }
  if (transactions.length > 20) {
    text += `\n...и ещё ${transactions.length - 20} транзакций\n`;
  }
  if (dupCount > 0) {
    text += `\n⚠️ ${dupCount} уже записаны ранее — пропустим их.\n`;
  }
  if (newOnes.length === 0) {
    text += '\nВсе транзакции уже были записаны ранее.';
  } else {
    text += `\nЗаписать ${newOnes.length} новых транзакций?`;
  }
  return text;
}

export async function handleFileUpload(bot, msg, fileType) {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;

  // Get user
  const { data: userData } = await supabase
    .from('users')
    .select('id')
    .eq('external_id', String(telegramId))
    .eq('channel', 'telegram')
    .single();

  if (!userData?.id) {
    await bot.sendMessage(chatId, 'Не нашёл твой аккаунт. Напиши /start 🙏');
    return;
  }

  const userId = userData.id;
  const access = await getUserAccess(userId);

  if (access === 'free') {
    await bot.sendMessage(
      chatId,
      '📊 Загрузка банковских выписок доступна в платной подписке.\n\n' +
        'Попробуй 7 дней бесплатно!',
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔓 Попробовать бесплатно', callback_data: 'buy_subscription' },
          ]],
        },
      }
    );
    return;
  }

  await bot.sendChatAction(chatId, 'typing');
  await bot.sendMessage(chatId, '📄 Анализирую выписку, подожди немного...');

  // Download file
  let tmpPath;
  let mimeType;

  try {
    if (fileType === 'photo') {
      const photo = msg.photo[msg.photo.length - 1];
      const downloaded = await downloadTelegramFile(bot, photo.file_id);
      tmpPath = downloaded.tmpPath;
      mimeType = 'image/jpeg';
    } else {
      const doc = msg.document;
      const downloaded = await downloadTelegramFile(bot, doc.file_id);
      tmpPath = downloaded.tmpPath;
      mimeType = doc.mime_type === 'application/pdf'
        ? 'application/pdf'
        : mimeFromExt(downloaded.tmpPath);
    }
  } catch (err) {
    console.error('[fileUpload] Download error:', err.message);
    await bot.sendMessage(chatId, 'Не смог загрузить файл. Попробуй ещё раз 🙏');
    return;
  }

  const base64Content = fs.readFileSync(tmpPath).toString('base64');
  fs.unlink(tmpPath, () => {});

  // Analyze via GPT-4o
  let rawTransactions = [];
  try {
    rawTransactions = await analyzeStatement(base64Content, mimeType);
    console.log(`[fileUpload] Found ${rawTransactions.length} transactions for user ${telegramId}`);
  } catch (err) {
    console.error('[fileUpload] Vision error:', err.message);
    await bot.sendMessage(chatId,
      'Не смог распознать выписку. Попробуй скриншот или другой файл 🙏');
    return;
  }

  if (!Array.isArray(rawTransactions) || rawTransactions.length === 0) {
    await bot.sendMessage(chatId,
      'Не нашёл транзакций в файле. Убедись, что это банковская выписка 🤔');
    return;
  }

  // Duplicate check
  const transactions = await checkDuplicates(userId, rawTransactions);
  const newTransactions = transactions.filter((t) => !t.isDuplicate);

  // Build summary
  const summaryText = buildSummaryText(transactions);

  // Clear previous timeout
  const prevState = userStates.get(telegramId);
  if (prevState?.fileTimeoutId) clearTimeout(prevState.fileTimeoutId);

  if (newTransactions.length === 0) {
    await bot.sendMessage(chatId, summaryText, {
      reply_markup: { inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]] },
    });
    return;
  }

  // 30-min timeout
  const timeoutId = setTimeout(async () => {
    userStates.delete(telegramId);
    await bot.sendMessage(chatId, 'Время ожидания истекло. Выписка не сохранена.', {
      reply_markup: { inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]] },
    });
  }, 30 * 60 * 1000);

  userStates.set(telegramId, {
    awaitingFileConfirmation: true,
    pendingTransactions: newTransactions,
    summaryText,
    userId,
    fileTimeoutId: timeoutId,
  });

  const confirmKeyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Записать', callback_data: 'file_confirm' },
          { text: '❌ Отменить', callback_data: 'file_cancel' },
        ],
      ],
    },
  };

  const parts = splitMessage(summaryText);
  for (let i = 0; i < parts.length - 1; i++) {
    await bot.sendMessage(chatId, parts[i]);
  }
  await bot.sendMessage(chatId, parts[parts.length - 1], confirmKeyboard);
}

export async function handleFileConfirmation(bot, msg) {
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;
  const state = userStates.get(telegramId);

  if (!state?.awaitingFileConfirmation) return false;

  await bot.sendMessage(chatId, 'Используй кнопки чтобы подтвердить или отменить сохранение.', {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Записать', callback_data: 'file_confirm' },
          { text: '❌ Отменить', callback_data: 'file_cancel' },
        ],
        [{ text: '🔁 Показать снова', callback_data: 'file_show_again' }],
      ],
    },
  });
  return true;
}

export async function handleFileCallback(bot, query) {
  const chatId = query.message.chat.id;
  const telegramId = query.from.id;
  const action = query.data;
  const state = userStates.get(telegramId);

  await bot.answerCallbackQuery(query.id);

  if (action === 'file_cancel') {
    if (state?.fileTimeoutId) clearTimeout(state.fileTimeoutId);
    userStates.delete(telegramId);
    await bot.sendMessage(chatId, 'Выписка не сохранена.', {
      reply_markup: { inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]] },
    });
    return;
  }

  if (action === 'file_show_again') {
    if (!state?.summaryText) {
      await bot.sendMessage(chatId, 'Данные не найдены. Загрузи файл заново.');
      return;
    }
    const parts = splitMessage(state.summaryText);
    for (let i = 0; i < parts.length - 1; i++) {
      await bot.sendMessage(chatId, parts[i]);
    }
    await bot.sendMessage(chatId, parts[parts.length - 1], {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Записать', callback_data: 'file_confirm' },
            { text: '❌ Отменить', callback_data: 'file_cancel' },
          ],
        ],
      },
    });
    return;
  }

  if (action === 'file_confirm') {
    if (!state?.pendingTransactions?.length) {
      await bot.sendMessage(chatId, 'Данные не найдены. Загрузи выписку заново.');
      userStates.delete(telegramId);
      return;
    }

    if (state.fileTimeoutId) clearTimeout(state.fileTimeoutId);
    userStates.delete(telegramId);

    await bot.sendChatAction(chatId, 'typing');

    let savedCount = 0;
    for (const tx of state.pendingTransactions) {
      try {
        await saveTransaction(
          state.userId,
          {
            type: tx.type,
            amount: tx.amount,
            category: tx.category,
            comment: tx.comment ?? null,
            transaction_date: tx.transaction_date,
          },
          tx.description ?? null
        );
        savedCount++;
      } catch (err) {
        console.error('[fileUpload] Save error:', err.message);
      }
    }

    await bot.sendMessage(
      chatId,
      `✅ Записал ${savedCount} транзакций из выписки!`,
      { reply_markup: { inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]] } }
    );
  }
}
