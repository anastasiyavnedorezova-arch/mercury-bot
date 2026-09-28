// Общие тексты и хелперы бота (Telegram и веб-чат)

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
  if (item.type === 'goal') return `${emoji} ${formatRub(item.amount)} ₽ — в копилку`;
  const sign = item.type === 'income' ? '+' : '';
  return `${emoji} ${sign}${formatRub(item.amount)} ₽ — ${categoryLabel(item)}`;
}

export function buildConfirmationText(item) {
  const opener = pick(OPENERS[item.type] ?? OPENERS.expense);
  return `${opener}\n${entryLine(item)}\n📅 ${formatRuDate(item.transaction_date)}`;
}

export function buildMultiConfirmationText(items) {
  const n = items.length;
  const head = `Записал ${n} ${plural(n, 'запись', 'записи', 'записей')} ✅`;
  const dates = [...new Set(items.map((i) => i.transaction_date))];
  if (dates.length === 1) {
    return `${head}\n${items.map(entryLine).join('\n')}\n📅 ${formatRuDate(dates[0])}`;
  }
  return `${head}\n${items.map((i) => `${entryLine(i)} · ${formatRuDate(i.transaction_date)}`).join('\n')}`;
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
  faqFailed: 'Не получилось ответить 😔 Попробуй задать вопрос ещё раз 🙏',
};
