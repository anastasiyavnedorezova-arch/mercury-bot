// Общие тексты и хелперы бота (Telegram и веб-чат)
import { CUSTOM_LOCKED_NOTE } from './categoryAccess.js';

// ── Маркетплейсы ─────────────────────────────────────────────────────────
// Уточняющий вопрос «что пришло с маркетплейса» уместен только если пользователь
// сам назвал маркетплейс. \b в JS не работает с кириллицей, поэтому границы слов — через lookaround.
const MARKETPLACE_WORDS = [
  'wildberr?ies?', 'вайлдбе?р+из', 'вайлдберис', 'вб', 'wb',
  'ozon', 'озон', 'lamoda', 'ламода',
  'яндекс[\\s.\\-]*маркет', 'я\\.?\\s?маркет',
];
const MARKETPLACE_RE = new RegExp(
  `(?<![\\p{L}\\d])(${MARKETPLACE_WORDS.join('|')})(?![\\p{L}\\d])`,
  'iu'
);

export function mentionsMarketplace(text) {
  return MARKETPLACE_RE.test(String(text ?? ''));
}

// ── Веб-чат или Telegram ─────────────────────────────────────────────────
// Веб-адаптер (src/webBotAdapter.js) помечен isWeb: true
export function isWebBot(bot) {
  return bot?.isWeb === true;
}

const RECORD_HINT_TG =
  'Напиши мне о своей трате или доходе в свободной форме\n' +
  'или запиши голосовое — я распознаю его 🎤\n' +
  'Например: «продукты 1800», «такси 450», «зарплата 120000»';

// В веб-чате голосовые и фото пока не поддерживаются — про них не пишем
const RECORD_HINT_WEB =
  'Напиши мне о своей трате или доходе в свободной форме ✍️\n' +
  'Например: «продукты 1800», «такси 450», «зарплата 120000»';

export function recordHint(bot) {
  return isWebBot(bot) ? RECORD_HINT_WEB : RECORD_HINT_TG;
}

// ── Форматирование ───────────────────────────────────────────────────────
const MONTHS_RU = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

export function formatRuDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  if (!m) return String(iso ?? '');
  return `${Number(m[3])} ${MONTHS_RU[Number(m[2]) - 1]}`;
}

export function formatRub(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n);
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// ── Подтверждение записи ─────────────────────────────────────────────────
const OPENERS = {
  expense: ['Записал ✅', 'Готово, записал 👌', 'Есть, записал 🙌', 'Принято ✅'],
  income: ['Ура, доход записан 🎉', 'Записал поступление 💰', 'Отлично, записал 💛'],
  goal: ['Отложено на цель 🎯 Так держать!', 'Записал взнос на цель 🎯 Молодец!', 'Копилка пополнена 🎯 Отличный шаг!'],
};
const LINE_EMOJI = { expense: '💸', income: '💰', goal: '🎯' };

// category_saved — категория, которая реально попала в базу (может отличаться от ответа модели)
function categoryLabel(item) {
  const category = item.category_saved ?? item.category;
  return item.comment ? `${category} (${item.comment})` : category;
}

function entryLine(item) {
  const emoji = LINE_EMOJI[item.type] ?? '💸';
  if (item.type === 'goal') {
    return item.goal?.name
      ? `${emoji} ${formatRub(item.amount)} ₽ — на цель «${item.goal.name}»`
      : `${emoji} ${formatRub(item.amount)} ₽ — в копилку`;
  }
  const sign = item.type === 'income' ? '+' : '';
  return `${emoji} ${sign}${formatRub(item.amount)} ₽ — ${categoryLabel(item)}`;
}

// «Накоплено 12 000 из 150 000 ₽ (8%)» — после взноса на цель
export function goalProgressLine(goal) {
  if (!goal) return '';
  return goal.target > 0
    ? `Накоплено ${formatRub(goal.saved)} из ${formatRub(goal.target)} ₽ (${goal.percent}%)`
    : `Накоплено ${formatRub(goal.saved)} ₽`;
}

export function buildConfirmationText(item) {
  const opener = pick(OPENERS[item.type] ?? OPENERS.expense);
  const progress = item.type === 'goal' && item.goal ? `\n📊 ${goalProgressLine(item.goal)}` : '';
  const note = item.category_locked ? `\n${CUSTOM_LOCKED_NOTE}` : '';
  return `${opener}\n${entryLine(item)}\n📅 ${formatRuDate(item.transaction_date)}${progress}${note}`;
}

export function buildMultiConfirmationText(items) {
  const n = items.length;
  const head = `Записал ${n} ${plural(n, 'запись', 'записи', 'записей')} ✅`;
  const dates = [...new Set(items.map((i) => i.transaction_date))];
  // По одной строке прогресса на каждую цель (берём последнее значение — оно уже со всеми взносами)
  const goals = new Map();
  for (const i of items) if (i.type === 'goal' && i.goal) goals.set(i.goal.id, i.goal);
  const progress = [...goals.values()].map((g) => `\n📊 «${g.name}»: ${goalProgressLine(g).replace('Накоплено ', '')}`).join('');
  const note = items.some((i) => i.category_locked) ? `\n${CUSTOM_LOCKED_NOTE}` : '';
  if (dates.length === 1) {
    return `${head}\n${items.map((i, k) => `${k + 1}. ${entryLine(i)}`).join('\n')}\n📅 ${formatRuDate(dates[0])}${progress}${note}`;
  }
  return `${head}\n${items.map((i, k) => `${k + 1}. ${entryLine(i)} · ${formatRuDate(i.transaction_date)}`).join('\n')}${progress}${note}`;
}

// Вопрос «на какую цель?» — когда целей несколько и из сообщения не понятно, какая нужна.
export function buildGoalPickText(item) {
  return `На какую цель отложить ${formatRub(item.amount)} ₽? 🎯`;
}

export function buildGoalPickKeyboard(goals) {
  const rows = goals.map((g) => [{ text: `🎯 ${g.name}`.slice(0, 60), callback_data: `goal:contrib:${g.id}` }]);
  rows.push([{ text: 'Не записывать', callback_data: 'goal:contrib_cancel' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

// Кнопки «Исправить / Удалить» для каждой записи из сообщения с несколькими записями.
// ids[k] — id записи в базе для items[k] (null, если запись не сохранилась — для неё кнопок нет).
const MULTI_BUTTONS_LIMIT = 10;

export function buildMultiKeyboard(ids) {
  const rows = [];
  ids.slice(0, MULTI_BUTTONS_LIMIT).forEach((id, k) => {
    if (!id) return;
    rows.push([
      { text: `✏️ Исправить ${k + 1}`, callback_data: `tx:edit:${id}` },
      { text: `🗑 Удалить ${k + 1}`, callback_data: `tx:delete:${id}` },
    ]);
  });
  rows.push([{ text: '☰ Главное меню', callback_data: 'menu:main' }]);
  return { reply_markup: { inline_keyboard: rows } };
}

// Текст для распознавания, когда бот ждал категорию для ранее присланной суммы.
// Ответ без цифр («одежда») — это описание к сумме: склеиваем. Ответ с цифрами
// («4700 справка для Насти») — уже полная запись: сумму из ожидания не добавляем,
// иначе одна трата превращается в две.
export function textForPendingAmount(reply, pendingAmount) {
  const text = String(reply ?? '').trim();
  return /\d/.test(text) ? text : `${text} ${pendingAmount}`;
}

// ── Тексты ошибок и уточнений ────────────────────────────────────────────
export const TEXTS = {
  unrecognized: 'Не смог распознать запись 😥 Попробуй в формате: "Продукты 250"',
  noAmount: 'Не нашёл сумму в сообщении 🤔 Напиши её числом, например: 250',
  manualNoAmount: 'Не смог понять сумму 🤔 Напиши только число, например: 1500 👇',
  noAmountInState: 'Не смог понять сумму 🤔 Напиши запись заново, например: "Продукты 250"',
  processingError: 'Что-то пошло не так на моей стороне 😔 Попробуй ещё раз через минутку',
  saveFailed: 'Не получилось сохранить запись 😔 Попробуй ещё раз, а если повторится — напиши нам через «Обратную связь»',
  saveFailedMany: 'Не получилось сохранить записи 😔 Попробуй ещё раз, а если повторится — напиши нам через «Обратную связь»',
  goalNone: 'Чтобы откладывать на цель, сначала создай её 🎯 Это займёт минуту — я посчитаю, сколько нужно откладывать в месяц.',
  goalPickStale: 'Этот вопрос уже устарел 🙈 Напиши сумму ещё раз, например: «на цель 5000»',
  goalPickCancelled: 'Хорошо, взнос не записываю 👌',
  faqFailed: 'Не получилось ответить 😔 Попробуй задать вопрос ещё раз 🙏',
};
