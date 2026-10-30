import fs from 'fs';
import path from 'path';
import https from 'https';
import OpenAI from 'openai';
import { supabase } from '../db.js';
import { userStates } from '../state.js';
import { getUserAccess } from '../utils/access.js';
import { saveTransaction } from './message.js';
import { todayStr } from '../utils/dateTz.js';
import { reserveAi, denyAi } from '../utils/aiLimit.js';
import { replyIfQuota } from '../utils/openaiErrors.js';
import { telegramFileUrl } from '../utils/endpoints.js';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, hintsForPrompt, canonicalCategory, refineStatementItem } from '../utils/categoryHints.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export function getStatementPrompt() {
  const today = todayStr();
  return `Ты — парсер банковских выписок. Проанализируй изображение(я) банковской выписки и извлеки все транзакции.

Сегодня ${today}. Используй текущий год для определения дат транзакций.
Если в выписке написано просто "вчера" или "сегодня" — используй соответствующие даты относительно сегодня.
Если указан только день и месяц без года — используй текущий год.

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
  "confidence": "high" | "low",
  "own_transfer": true | false
}

"own_transfer": true — только если это перевод между СВОИМИ счетами или картами самого владельца выписки (в выписке написано «между своими счетами», «перевод на накопительный счёт», «пополнение вклада с карты» и т.п.). Перевод другому человеку (имя и первая буква фамилии, СБП по номеру телефона) — это НЕ own_transfer: false. Во всех остальных случаях false.

Используй "confidence": "low" если не уверен в сумме, дате или категории.

КАТЕГОРИИ ДОХОДОВ (пиши название ровно так):
${INCOME_CATEGORIES.join('\n')}

КАТЕГОРИИ РАСХОДОВ (пиши название ровно так):
${EXPENSE_CATEGORIES.join('\n')}

Любое название не из этих списков система не поймёт, а запись уйдёт в «Остальное». «Остальное» — только для РАСХОДА, если ни одна категория расходов не подходит. Для ДОХОДА (непонятное пополнение, поступление без пояснений) используй «Другие доходы», никогда не «Остальное».
Налоговая служба (ФНС), налоги, штрафы, ГИБДД — «Налоги и штрафы». Золотое яблоко, Летуаль, Рив Гош — «Красота и уход за собой», не «Продукты».

СЛОВА И НАЗВАНИЯ ПО КАТЕГОРИЯМ:
${hintsForPrompt()}`;
}

// Текст перед разбором. Для фото — с пометкой про тестовый режим (курсивом), для файла — короткий.
export const STATEMENT_WAIT_PHOTO = '📄 Анализирую выписку...\n<i>Анализ выписки по фото находится в тестовом режиме, я только учусь правильно разбирать изображения 🤓 Если я сделаю ошибку, отправь, пожалуйста, обращение разработчикам, чтобы меня научили лучше 💛</i>';
export const STATEMENT_WAIT_FILE = '📄 Анализирую выписку, подожди немного...';

export function statementWaitMessage(fileType) {
  if (fileType === 'photo') {
    return {
      text: STATEMENT_WAIT_PHOTO,
      options: {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '💬 Написать разработчикам', callback_data: 'menu:feedback' }]] },
      },
    };
  }
  return { text: STATEMENT_WAIT_FILE, options: undefined };
}

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
  const url = telegramFileUrl(file.file_path);
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
          { type: 'text', text: getStatementPrompt() },
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

export function buildSummaryText(transactions) {
  const newOnes = transactions.filter((t) => !t.isDuplicate);
  const toSave = newOnes.filter((t) => !t.ownTransfer);
  const transferCount = newOnes.length - toSave.length;
  const dupCount = transactions.length - newOnes.length;
  const show = transactions.slice(0, 20);

  let text = `📄 Нашёл ${transactions.length} транзакций в выписке:\n\n`;
  let num = 0; // номера только у тех, что не дубли: по ним человек правит категории
  for (const tx of show) {
    const emoji = tx.type === 'income' ? '📈' : '📉';
    const dup = tx.isDuplicate ? ' ⚠️дубль' : '';
    const comment = tx.comment ? ` (${tx.comment})` : '';
    const label = tx.isDuplicate ? '' : `${++num}. `;
    if (tx.ownTransfer && !tx.isDuplicate) {
      text += `${label}↔️ ${tx.transaction_date} — перевод между своими счетами: ${tx.amount} ₽ — не записываю\n`;
      continue;
    }
    text += `${label}${emoji} ${tx.transaction_date} — ${tx.category}: ${tx.amount} ₽${comment}${dup}\n`;
  }
  if (transactions.length > 20) {
    text += `\n...и ещё ${transactions.length - 20} транзакций\n`;
  }
  if (dupCount > 0) {
    text += `\n⚠️ ${dupCount} уже записаны ранее — пропустим их.\n`;
  }
  if (transferCount > 0) {
    text += `\n↔️ Переводы между своими счетами не записываю: это не доход и не расход. Если это не так, напиши, например: «запиши 3 как доход».\n`;
  }
  if (newOnes.length === 0) {
    text += '\nВсе транзакции уже были записаны ранее.';
  } else if (toSave.length === 0) {
    text += '\nЗаписывать нечего: остались только переводы между своими счетами.';
  } else {
    text += `\nЗаписать ${toSave.length} новых транзакций?\nЧтобы поправить категорию, напиши номер и категорию, например: «2 — Налоги и штрафы». Чтобы не записывать строку, напиши: «не записывай 3». Можно сразу несколько.`;
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
        'Оформи подписку — и я смогу разбирать скриншоты и выписки из банка 💛',
      {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Оформить подписку', callback_data: 'buy_subscription' },
          ]],
        },
      }
    );
    return;
  }

  const gate = await reserveAi(supabase, telegramId, 'statement');
  if (!gate.ok) { await denyAi(bot, chatId, gate); return; }

  await bot.sendChatAction(chatId, 'typing');
  const wait = statementWaitMessage(fileType);
  await bot.sendMessage(chatId, wait.text, wait.options);

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
    rawTransactions = (await analyzeStatement(base64Content, mimeType))
      .map(refineStatementItem)
      .map((tx) => ({ ...tx, ownTransfer: tx.own_transfer === true }));
    console.log(`[fileUpload] Found ${rawTransactions.length} transactions for user ${telegramId}`);
  } catch (err) {
    console.error('[fileUpload] Vision error:', err.message);
    if (await replyIfQuota(err, bot, chatId)) return;
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

const CONFIRM_KEYBOARD = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '✅ Записать', callback_data: 'file_confirm' },
        { text: '❌ Отменить', callback_data: 'file_cancel' },
      ],
      [{ text: '🔄 Показать снова', callback_data: 'file_show_again' }],
    ],
  },
};

const KNOWN_CATEGORIES = new Set([...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES]);

function categoryKind(category) {
  if (INCOME_CATEGORIES.includes(category)) return 'income';
  if (EXPENSE_CATEGORIES.includes(category)) return 'expense';
  return null;
}

function fmtNums(nums) {
  return nums.join(', ');
}

// Список после правок. changes — что именно изменили, чтобы человек видел результат своих слов.
export function buildUpdatedSummary(transactions, changes = {}) {
  let text = 'Обновил список 👇\n';
  const lines = [];
  for (const c of changes.changed ?? []) lines.push(`• ${c.n} — ${c.category}${c.type ? (c.type === 'income' ? ' (доход)' : ' (расход)') : ''}`);
  if (changes.removed?.length) lines.push(`• не записываю: ${fmtNums(changes.removed)} (номера в списке ниже пересчитаны)`);
  if (changes.restored?.length) lines.push(`• возвращаю в запись: ${fmtNums(changes.restored)}`);
  for (const u of changes.unknown ?? []) lines.push(`• не знаю категорию «${u.category}»${typeof u.n === 'number' ? ` (строка ${u.n})` : ''}, оставил как было`);
  if (lines.length) text += `\n${lines.join('\n')}\n`;

  text += '\nГотовы к записи:\n';
  transactions.forEach((tx, i) => {
    if (tx.ownTransfer) {
      text += `${i + 1}. ↔️ ${tx.transaction_date} — перевод между своими счетами — ${tx.amount} ₽ (не записываю)\n`;
      return;
    }
    const comment = tx.comment ? ` (${tx.comment})` : '';
    const typeLabel = tx.type === 'income' ? ' (доход)' : ' (расход)';
    text += `${i + 1}. ${tx.transaction_date} — ${tx.category} — ${tx.amount} ₽${comment}${typeLabel}\n`;
  });
  text += '\nВсё верно? Записываю?';
  return text;
}

// Правки человека к списку из выписки. Номера в ответе модели — как в списке для человека (с единицы).
// Возвращает {updated, changed, removed, restored, unknown}; номера в changed/removed/restored — как были ДО правки.
export function applyStatementCorrectionsDetailed(pending, parsed) {
  let updated = pending.map((tx) => ({ ...tx }));
  const changed = [];
  const unknown = [];
  const updates = Array.isArray(parsed?.updates) ? parsed.updates : [];
  const updatedIndexes = new Set(updates.map((u) => u.index - 1));

  // Шаг 1: applyToAll — только записи с категорией «Остальное» и без индивидуальных правок; тип меняется только вместе с категорией
  if (parsed?.applyToAll && parsed.applyToAll.category) {
    const category = canonicalCategory(parsed.applyToAll.category);
    if (KNOWN_CATEGORIES.has(category)) {
      updated.forEach((tx, i) => {
        if (updatedIndexes.has(i) || tx.ownTransfer) return;
        if (tx.category === 'Остальное' || tx.category === 'Другое' || tx.category === 'Другие доходы') {
          tx.category = category;
          const kind = categoryKind(category);
          if (kind) tx.type = kind;
          changed.push({ n: i + 1, category, type: tx.type });
        }
      });
    } else {
      unknown.push({ n: '—', category: parsed.applyToAll.category });
    }
  }

  // Шаг 2: индивидуальные правки — приоритет выше applyToAll
  for (const upd of updates) {
    const at = typeof upd.index === 'number' ? upd.index - 1 : -1;
    const tx = updated[at];
    if (!tx) continue;
    let touched = false;
    if (upd.category) {
      const category = canonicalCategory(upd.category);
      if (KNOWN_CATEGORIES.has(category)) {
        tx.category = category;
        touched = true;
        // тип следует за категорией, если человек не назвал тип сам
        const kind = categoryKind(category);
        if (!upd.type && kind) tx.type = kind;
      } else {
        unknown.push({ n: upd.index, category: upd.category });
      }
    }
    if (upd.type === 'income' || upd.type === 'expense') { tx.type = upd.type; touched = true; }
    if (upd.comment !== undefined) { tx.comment = upd.comment; touched = true; }
    if (touched) {
      tx.ownTransfer = false; // человек сам правит строку — значит, её надо записать
      changed.push({ n: upd.index, category: tx.category, type: tx.type });
    }
  }

  // Шаг 3: «верни в запись» для переводов между своими счетами
  const restored = [];
  for (const n of Array.isArray(parsed?.restore) ? parsed.restore : []) {
    const tx = typeof n === 'number' ? updated[n - 1] : null;
    if (tx?.ownTransfer) { tx.ownTransfer = false; restored.push(n); }
  }

  // Шаг 4: «не записывай» — убираем строки (в конце, чтобы номера выше считались по исходному списку)
  const removed = [...new Set((Array.isArray(parsed?.remove) ? parsed.remove : []).filter((n) => Number.isInteger(n) && n >= 1 && n <= updated.length))].sort((x, y) => x - y);
  if (removed.length) {
    const drop = new Set(removed.map((n) => n - 1));
    updated = updated.filter((_, i) => !drop.has(i));
  }
  const removedSet = new Set(removed);
  return {
    updated,
    changed: changed.filter((c) => !removedSet.has(c.n)),
    removed,
    restored: restored.filter((n) => !removedSet.has(n)),
    unknown,
  };
}

export function applyStatementCorrections(pending, parsed) {
  return applyStatementCorrectionsDetailed(pending, parsed).updated;
}

export async function handleFileTextResponse(bot, msg) {
  const telegramId = msg.from.id;
  const chatId = msg.chat.id;
  const state = userStates.get(telegramId);

  if (!state?.awaitingFileConfirmation) return false;

  const gate = await reserveAi(supabase, telegramId, 'correction');
  if (!gate.ok) { await denyAi(bot, chatId, gate); return true; }

  await bot.sendChatAction(chatId, 'typing');

  const correctionPrompt = `У пользователя есть список транзакций на подтверждение.
Транзакции с номерами (n — номер в списке пользователя, начиная с 1): ${JSON.stringify(state.pendingTransactions.map((t, i) => ({ n: i + 1, ...t })))}

Категории, которые существуют (пиши название ровно так): ${[...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES].join(', ')}

Пользователь написал правки: "${msg.text}"

Разбери что пользователь хочет изменить. Трогай ТОЛЬКО строки, которые пользователь назвал. Остальные не меняй.

Что может попросить пользователь:
1. Поменять категорию или тип строки → updates.
2. Не записывать строку («не записывай 3», «3 и 5 не делай», «удали 3», «убери 5», «пропусти 2», «без 4») → номера в remove. Слова «удалить», «не делай», «не записывай» — это НЕ категория, их нельзя писать в category.
3. Вернуть в запись строку, помеченную как перевод между своими счетами (ownTransfer: true), например «запиши 3 как доход» → номер в restore и запись в updates с нужным type.
4. «Всё остальное в категорию X» → applyToAll.

ВАЖНО по определению type:
- type указывай ТОЛЬКО если пользователь прямо сказал тип или это «возврат», «вернули», «пополнение», «доход», «получил(а)» → "income"; «расход», «потратил(а)», «покупка», «оплата» → "expense".
- "возврат товара", "возврат средств", "вернули деньги" = type: "income", category: "Возврат денег". Это ДОХОД, даже если отправитель — магазин или маркетплейс.
- Если тип не упоминается явно — НЕ пиши поле type, оставь как было.
- Категорию пиши только из списка выше. Если подходящей нет, не пиши category.

Верни JSON:
{
  "updates": [
    { "index": 1, "category": "Возврат денег", "type": "income", "comment": "возврат Озон" },
    { "index": 2, "category": "Товары в дом" }
  ],
  "remove": [3, 5],
  "restore": [],
  "applyToAll": { "category": "Товары в дом" }
}

index и номера в remove/restore — это n транзакции из списка (первая имеет n = 1).
applyToAll — только если пользователь прямо сказал "остальное всё в категорию X": применится к строкам с категорией «Остальное». Если applyToAll не нужен — верни null. Пустые updates, remove, restore — пустые массивы.
Верни ТОЛЬКО валидный JSON без пояснений.`;

  let parsed;
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: correctionPrompt }],
      temperature: 0,
      max_tokens: 3000,
    });
    const raw = response.choices[0].message.content.trim();
    const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error('[fileUpload] Correction LLM error:', err.message);
    if (await replyIfQuota(err, bot, chatId)) return true;
    await bot.sendMessage(chatId,
      'Не смог разобрать правки. Попробуй написать иначе или используй кнопки 🙏',
      CONFIRM_KEYBOARD);
    return true;
  }

  const result = applyStatementCorrectionsDetailed(state.pendingTransactions, parsed);
  const nothing = !result.changed.length && !result.removed.length && !result.restored.length && !result.unknown.length;
  if (nothing) {
    await bot.sendMessage(chatId,
      'Не понял, что поправить 🤔 Напиши, например: «2 — Налоги и штрафы» или «не записывай 3». Или нажми кнопку.',
      CONFIRM_KEYBOARD);
    return true;
  }

  // Все строки убраны — записывать нечего
  if (!result.updated.length) {
    if (state.fileTimeoutId) clearTimeout(state.fileTimeoutId);
    userStates.delete(telegramId);
    await bot.sendMessage(chatId, 'Убрал все строки, выписка не сохранена.', {
      reply_markup: { inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]] },
    });
    return true;
  }

  const summaryText = buildUpdatedSummary(result.updated, result);
  // «Показать снова» должно показывать уже обновлённый список
  userStates.set(telegramId, { ...state, pendingTransactions: result.updated, summaryText });

  const parts = splitMessage(summaryText);
  for (let i = 0; i < parts.length - 1; i++) {
    await bot.sendMessage(chatId, parts[i]);
  }
  await bot.sendMessage(chatId, parts[parts.length - 1], CONFIRM_KEYBOARD);
  return true;
}

export async function handleFileConfirmation(bot, msg) {
  const telegramId = msg.from.id;
  const state = userStates.get(telegramId);
  return state?.awaitingFileConfirmation === true;
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

    const toSave = state.pendingTransactions.filter((tx) => !tx.ownTransfer);
    if (!toSave.length) {
      await bot.sendMessage(chatId, 'Записывать нечего: остались только переводы между своими счетами.', {
        reply_markup: { inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]] },
      });
      return;
    }

    await bot.sendChatAction(chatId, 'typing');

    let savedCount = 0;
    for (const tx of toSave) {
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
