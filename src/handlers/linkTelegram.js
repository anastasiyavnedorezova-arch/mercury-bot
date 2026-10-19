// Подключение Telegram к аккаунту с сайта: человек нажал на ссылку из профиля (t.me/бот?start=link_…).
// Показываем, к какому аккаунту подключаем, и только после кнопки «Подключить» переносим данные.
// Модуль не обращается к базе и к меню напрямую: их передаёт вызывающий код (start.js, callbackDispatcher.js),
// так его проверяют тесты без боевых настроек.
import { peekLinkToken, linkTelegram, TOKEN_RE } from '../accounts/linkTelegram.js';

const MENU = [{ text: '☰ Главное меню', callback_data: 'menu:main' }];
const SUPPORT = 'Если не получается, напиши нам через «Обратная связь» в меню 🙏';

export const LINK_TEXTS = {
  invalid: 'Эта ссылка не подходит. Открой профиль на сайте и нажми «Подключить Telegram» ещё раз 🙏',
  used: 'Эта ссылка уже использована. Если Telegram ещё не подключён, получи новую в профиле на сайте 🙏',
  expired: 'Ссылка устарела (она действует 15 минут). Получи новую в профиле на сайте и нажми на неё ещё раз 🙏',
  no_user: 'Не нашёл аккаунт, к которому относится эта ссылка. Получи новую в профиле на сайте 🙏',
  other_connected: 'К этому аккаунту уже подключён другой Telegram. Сначала отключи его в профиле на сайте.',
  telegram_has_login: `У этого Telegram уже есть свой аккаунт со входом по почте, поэтому объединить автоматически не получится, чтобы ты не потерял(а) доступ. ${SUPPORT}`,
  db: `Не получилось подключить Telegram. Попробуй ещё раз через минуту. ${SUPPORT}`,
  bad_telegram_id: `Не получилось определить твой Telegram. ${SUPPORT}`,
};

const plural = (n, one, few, many) => {
  const m = n % 100;
  const d = n % 10;
  return m >= 11 && m <= 14 ? many : d === 1 ? one : d >= 2 && d <= 4 ? few : many;
};

/** /start link_… : показываем подтверждение. Возвращает true, если это была ссылка подключения. */
export async function handleLinkStart(bot, msg, payload, { db }) {
  if (!TOKEN_RE.test(payload ?? '')) return false;
  const chatId = msg.chat.id;
  const peek = await peekLinkToken(db, payload, { telegramId: msg.from.id });
  if (!peek.ok) {
    await bot.sendMessage(chatId, LINK_TEXTS[peek.reason] ?? LINK_TEXTS.invalid);
    return true;
  }
  const extra = peek.ownRecords > 0
    ? `\n\nВ этом боте у тебя уже есть записи (${peek.ownRecords}). Они тоже перейдут в этот аккаунт, ничего не потеряется.`
    : '';
  await bot.sendMessage(
    chatId,
    `Подключить этот Telegram к аккаунту ${peek.maskedEmail}?\n\nПосле этого бот и сайт будут работать с одними и теми же данными.${extra}`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Подключить', callback_data: `link:ok:${payload}` }],
          [{ text: 'Отмена', callback_data: 'link:cancel' }],
        ],
      },
    }
  );
  return true;
}

/** Кнопки link:ok:<токен> и link:cancel. Обрабатываются до проверки согласия: человек мог ещё не принимать его в боте. */
export async function handleLinkCallback(bot, query, { db, showConsentScreen, showMainMenu }) {
  const chatId = query.message.chat.id;
  const action = query.data;
  await bot.answerCallbackQuery(query.id).catch(() => {});

  if (action === 'link:cancel') {
    await bot.sendMessage(chatId, 'Хорошо, ничего не подключаю. Ссылку можно получить в профиле на сайте в любой момент.', { reply_markup: { inline_keyboard: [MENU] } });
    return;
  }
  const token = action.slice('link:ok:'.length);
  const r = await linkTelegram(db, {
    token,
    telegramId: query.from.id,
    tgUsername: query.from.username || query.from.first_name || null,
  });
  if (!r.ok) {
    await bot.sendMessage(chatId, LINK_TEXTS[r.reason] ?? LINK_TEXTS.db);
    return;
  }
  const m = r.moved;
  const parts = [];
  if (m?.transactions) parts.push(`${m.transactions} ${plural(m.transactions, 'запись', 'записи', 'записей')}`);
  if (m?.goals) parts.push(`${m.goals} ${plural(m.goals, 'цель', 'цели', 'целей')}`);
  await bot.sendMessage(
    chatId,
    r.already
      ? 'Этот Telegram уже подключён к твоему аккаунту 💛'
      : `Готово! Telegram подключён 🎉${r.merged && parts.length ? `\n\nПеренёс в твой аккаунт: ${parts.join(', ')}.` : ''}\n\nТеперь бот и сайт показывают одни и те же данные.`
  );
  const { data: u } = await db.from('users').select('terms_accepted_at').eq('id', r.userId).maybeSingle();
  if (u && !u.terms_accepted_at) await showConsentScreen(bot, chatId);
  else await showMainMenu(bot, chatId);
}
