// Слова, по которым запись относится к категории без ИИ или с подсказкой для ИИ (патч 49).
// Один справочник на три места: быстрый разбор коротких записей («развлечения 400»), инструкция для ИИ
// (текстовые и голосовые записи) и разбор выписок. Названия категорий — ровно как в базе.

export const EXPENSE_CATEGORIES = [
  'Продукты', 'Кафе и рестораны', 'Кофе на вынос', 'Доставка еды',
  'Жильё', 'Товары в дом', 'Техника и мебель',
  'Транспорт', 'Авто',
  'Здоровье', 'Красота и уход за собой', 'Спорт',
  'Одежда и обувь', 'Путешествия', 'Отдых и развлечения', 'Обучение', 'Подписки', 'Подарки другим',
  'Кредиты и займы', 'Налоги и штрафы', 'Комиссии', 'Долг я дал', 'Благотворительность', 'Связь и интернет', 'Цель',
  'Дети', 'Животные', 'Остальное',
];

export const INCOME_CATEGORIES = [
  'Зарплата', 'Фриланс и подработка', 'Продажа и соцвыплаты', 'Проценты по вкладу', 'Инвестиционный доход',
  'Кэшбек и бонусы', 'Подарки мне', 'Возврат денег', 'Долг мне вернули',
];

// words — слова, которыми человек называет саму категорию или покупку: записью считается только фраза целиком
//         («развлечения 400»); brands — магазины, организации, сервисы: узнаются и внутри фразы («золотое яблоко помада 3400»).
// Нарочно нет слов, у которых смысл зависит от контекста (телефон, перевод, доставка, вода, вб/озон).
export const HINTS = [
  { category: 'Продукты', type: 'expense',
    words: ['продукты', 'продуктовый', 'супермаркет', 'молоко', 'хлеб', 'яйца', 'овощи', 'фрукты'],
    brands: [['Пятёрочка', 'пятерочка'], ['Магнит', 'магнит'], ['ВкусВилл', 'вкусвилл'], ['Перекрёсток', 'перекресток'],
      ['Лента', 'лента'], ['Ашан', 'ашан'], ['Дикси', 'дикси'], ['Азбука вкуса', 'азбука вкуса'],
      ['Самокат', 'самокат'], ['Яндекс Лавка', 'яндекс лавка']] },
  { category: 'Кафе и рестораны', type: 'expense',
    words: ['кафе', 'ресторан', 'рестораны', 'обед', 'ужин', 'кафе и рестораны', 'бизнес ланч'],
    brands: [['Макдональдс', 'макдональдс'], ['Макдональдс', 'макдак'], ['Бургер Кинг', 'бургер кинг'], ['KFC', 'kfc'], ['KFC', 'кфс'],
      ['Subway', 'subway'], ['Subway', 'субвэй'], ['Вкусно и точка', 'вкусно и точка']] },
  { category: 'Кофе на вынос', type: 'expense',
    words: ['кофе', 'кофе на вынос', 'латте', 'капучино', 'американо'],
    brands: [['Кофикс', 'кофикс'], ['Starbucks', 'starbucks']] },
  { category: 'Доставка еды', type: 'expense',
    words: ['доставка еды'],
    brands: [['Яндекс Еда', 'яндекс еда'], ['Delivery Club', 'delivery club']] },
  { category: 'Жильё', type: 'expense',
    words: ['жилье', 'жкх', 'ипотека', 'коммуналка', 'квартплата'], brands: [] },
  { category: 'Товары в дом', type: 'expense',
    words: ['товары в дом', 'товары для дома', 'хозтовары', 'бытовая химия'], brands: [] },
  { category: 'Техника и мебель', type: 'expense',
    words: ['техника', 'мебель', 'техника и мебель', 'холодильник', 'пылесос', 'ноутбук', 'телевизор'],
    brands: [['ДНС', 'днс'], ['М.Видео', 'м видео'], ['М.Видео', 'мвидео'], ['Эльдорадо', 'эльдорадо'], ['Ситилинк', 'ситилинк']] },
  { category: 'Транспорт', type: 'expense',
    words: ['транспорт', 'метро', 'автобус', 'такси', 'проезд', 'каршеринг', 'электричка'],
    brands: [['Яндекс Go', 'яндекс го'], ['Uber', 'uber']] },
  { category: 'Авто', type: 'expense',
    words: ['авто', 'бензин', 'парковка', 'мойка', 'заправка', 'азс', 'шиномонтаж', 'автосервис', 'автомойка', 'осаго', 'каско', 'техосмотр', 'запчасти'], brands: [] },
  { category: 'Здоровье', type: 'expense',
    words: ['здоровье', 'аптека', 'врач', 'стоматолог', 'анализы', 'лекарства', 'клиника', 'витамины', 'бады', 'бад'],
    brands: [['Ригла', 'ригла']] },
  { category: 'Красота и уход за собой', type: 'expense',
    words: ['красота', 'красота и уход', 'красота и уход за собой', 'уход', 'маникюр', 'стрижка', 'косметика', 'косметолог', 'салон красоты', 'парикмахерская'],
    brands: [['Золотое яблоко', 'золотое яблоко'], ['Золотое яблоко', 'зя'], ['Летуаль', 'летуаль'], ['Летуаль', 'лэтуаль'],
      ['Рив Гош', 'рив гош'], ['Рив Гош', 'ривгош'], ['Иль Де Ботэ', 'иль де ботэ'], ['Магнит Косметик', 'магнит косметик']] },
  { category: 'Спорт', type: 'expense',
    words: ['спорт', 'спортзал', 'зал', 'фитнес', 'бассейн', 'тренер', 'тренировка'],
    brands: [['World Class', 'world class']] },
  { category: 'Одежда и обувь', type: 'expense',
    words: ['одежда', 'обувь', 'одежда и обувь', 'шоппинг'], brands: [] },
  { category: 'Путешествия', type: 'expense',
    words: ['путешествия', 'путешествие', 'поездка', 'отель'], brands: [] },
  { category: 'Отдых и развлечения', type: 'expense',
    words: ['развлечения', 'отдых', 'отдых и развлечения', 'досуг', 'кино', 'театр', 'концерт', 'выставка'], brands: [] },
  { category: 'Обучение', type: 'expense',
    words: ['обучение', 'учеба', 'курсы', 'книги', 'книга', 'вебинар', 'репетитор'], brands: [] },
  { category: 'Подписки', type: 'expense',
    words: ['подписка', 'подписки'],
    brands: [['Яндекс Плюс', 'яндекс плюс'], ['Netflix', 'netflix'], ['Spotify', 'spotify'], ['СберПрайм', 'сберпрайм'],
      ['Иви', 'иви'], ['Кинопоиск', 'кинопоиск'], ['Окко', 'окко'], ['Wink', 'wink'], ['YouTube Premium', 'youtube premium'], ['Apple Music', 'apple music']] },
  { category: 'Подарки другим', type: 'expense',
    words: ['подарки', 'подарок'], brands: [] },
  { category: 'Кредиты и займы', type: 'expense',
    words: ['кредит', 'кредиты', 'рассрочка', 'кредиты и займы'], brands: [] },
  { category: 'Налоги и штрафы', type: 'expense',
    words: ['налоги', 'налог', 'штраф', 'штрафы', 'налоги и штрафы', 'ндфл', 'налог ип', 'налоговая'],
    brands: [['ФНС', 'фнс'], ['Федеральная налоговая служба', 'федеральная налоговая служба'], ['ГИБДД', 'гибдд']] },
  { category: 'Комиссии', type: 'expense',
    words: ['комиссия', 'комиссии'], brands: [] },
  { category: 'Благотворительность', type: 'expense',
    words: ['благотворительность', 'пожертвование', 'донат'], brands: [] },
  { category: 'Связь и интернет', type: 'expense',
    words: ['связь', 'интернет', 'связь и интернет', 'мобильная связь'],
    brands: [['МТС', 'мтс'], ['Билайн', 'билайн'], ['Теле2', 'теле2'], ['МегаФон', 'мегафон']] },
  { category: 'Дети', type: 'expense',
    words: ['дети', 'ребенок', 'садик', 'школа', 'кружки'], brands: [] },
  { category: 'Животные', type: 'expense',
    words: ['животные', 'корм', 'ветеринар', 'груминг', 'зоомагазин'], brands: [] },
  { category: 'Долг я дал', type: 'expense',
    words: ['дал в долг', 'дала в долг', 'одолжил', 'одолжила'], brands: [] },
  { category: 'Остальное', type: 'expense',
    words: ['остальное', 'другое', 'прочее'], brands: [] },

  { category: 'Зарплата', type: 'income',
    words: ['зарплата', 'зп', 'аванс', 'оклад'], brands: [] },
  { category: 'Фриланс и подработка', type: 'income',
    words: ['фриланс', 'подработка', 'фриланс и подработка'], brands: [] },
  { category: 'Кэшбек и бонусы', type: 'income',
    words: ['кэшбек', 'кэшбэк', 'кешбэк', 'кешбек', 'кэшбек и бонусы', 'бонусы'], brands: [] },
  { category: 'Проценты по вкладу', type: 'income',
    words: ['проценты по вкладу'], brands: [] },
  { category: 'Инвестиционный доход', type: 'income',
    words: ['дивиденды', 'инвестиционный доход'], brands: [] },
  { category: 'Долг мне вернули', type: 'income',
    words: ['вернули долг', 'вернул долг', 'вернула долг', 'отдали долг', 'отдал долг', 'отдала долг', 'долг вернули', 'возврат долга'], brands: [] },
  { category: 'Возврат денег', type: 'income',
    words: ['возврат', 'возврат денег'], brands: [] },
];

// Нижний регистр, ё → е, кавычки и знаки убираем, пробелы схлопываем
export function normalizePhrase(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'`’“”.,;:!?()\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const WORD_MAP = new Map();   // фраза → { category, type }
const BRAND_LIST = [];        // { tokens, name, category, type }, длинные раньше коротких
for (const h of HINTS) {
  for (const w of h.words) WORD_MAP.set(normalizePhrase(w), { category: h.category, type: h.type });
  for (const [name, key] of h.brands) {
    BRAND_LIST.push({ tokens: normalizePhrase(key).split(' '), name, category: h.category, type: h.type });
  }
}
BRAND_LIST.sort((a, b) => b.tokens.length - a.tokens.length);

const findSub = (tokens, sub) => {
  for (let i = 0; i + sub.length <= tokens.length; i++) {
    if (sub.every((t, j) => tokens[i + j] === t)) return i;
  }
  return -1;
};

// Слова, рядом с которыми магазин уже ничего не решает: «макдак доставка» — это может быть доставка еды
const AMBIGUOUS = new Set(['доставка', 'доставкой', 'заказ', 'вода', 'перевод', 'вернули', 'вернул', 'подарили', 'продала', 'продал', 'телефон']);

// Что это за слова: { category, type, comment } или null, если однозначно сказать нельзя.
// «развлечения» → Отдых и развлечения; «золотое яблоко помада» → Красота (комментарий «Золотое яблоко»);
// «макдак доставка» → null (за «доставку» может отвечать другая категория, пусть решит ИИ).
export function matchHint(text) {
  const phrase = normalizePhrase(text);
  if (!phrase) return null;
  const exact = WORD_MAP.get(phrase);
  if (exact) return { category: exact.category, type: exact.type, comment: null };
  const tokens = phrase.split(' ');
  for (const b of BRAND_LIST) {
    const at = findSub(tokens, b.tokens);
    if (at < 0) continue;
    const rest = [...tokens.slice(0, at), ...tokens.slice(at + b.tokens.length)];
    if (rest.length > 3) return null;
    if (rest.some((t) => t === 'и' || t === 'на' || AMBIGUOUS.has(t))) return null;           // несколько трат или «кофе на вынос» у магазина — решает ИИ
    const other = WORD_MAP.get(rest.join(' '));
    if (rest.length && other && other.category !== b.category) return null; // остаток называет другую категорию
    if (rest.some((t) => WORD_MAP.has(t) && WORD_MAP.get(t).category !== b.category)) return null;
    return { category: b.category, type: b.type, comment: b.name };
  }
  return null;
}

// Сумма в начале или в конце фразы: «развлечения 400», «400 развлечения», «1 500 р. налоги», «5к налоги».
const AMOUNT = String.raw`\d{1,3}(?:\s\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const UNIT = String.raw`(?:\s*(?:тыс(?:яч(?:а|и)?)?\.?|тк|[кk]))?(?:\s*(?:₽|р\.?|руб(?:л(?:ей|я|ь))?\.?))?`;
const AMOUNT_RE = `(${AMOUNT})${UNIT}`;
const LEAD = new RegExp(`^${AMOUNT_RE}\\s+(\\D+)$`, 'i');
const TAIL = new RegExp(`^(\\D+?)\\s+${AMOUNT_RE}$`, 'i');

// Короткая запись без ИИ. Возвращает { amountText, words } или null, если это не «слова + одна сумма».
export function splitAmountAndWords(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 80) return null;
  let m = TAIL.exec(t);
  if (m) return { words: m[1], amountText: t.slice(m[1].length).trim() };
  m = LEAD.exec(t);
  if (m) return { words: m[2], amountText: t.slice(0, t.length - m[2].length).trim() };
  return null;
}

// Для инструкции ИИ: те же слова списком по категориям
export function hintsForPrompt() {
  const lines = [];
  for (const h of HINTS) {
    const parts = [...h.words, ...h.brands.map(([, key]) => key)];
    lines.push(`- ${h.category}: ${[...new Set(parts)].join(', ')}`);
  }
  return lines.join('\n');
}

// Магазин или организация где угодно в тексте (для выписок: описание длинное, лишних слов много)
export function matchBrandInText(text) {
  const tokens = normalizePhrase(text).split(' ').filter(Boolean);
  for (const b of BRAND_LIST) {
    if (findSub(tokens, b.tokens) >= 0) return { category: b.category, type: b.type, comment: b.name };
  }
  return null;
}

// Прежние и сокращённые названия, которыми ИИ мог ответить, → название в базе
const LEGACY_NAMES = new Map([
  ['налоги', 'Налоги и штрафы'], ['налог', 'Налоги и штрафы'], ['красота', 'Красота и уход за собой'],
  ['дом и быт', 'Товары в дом'], ['другое', 'Остальное'], ['кафе', 'Кафе и рестораны'], ['рестораны', 'Кафе и рестораны'],
  ['кафе, рестораны', 'Кафе и рестораны'], ['жилье', 'Жильё'],
]);
const KNOWN = new Map([...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES].map((c) => [normalizePhrase(c), c]));

export function canonicalCategory(name) {
  const key = normalizePhrase(name).replace(/\s*,\s*/g, ', ');
  return KNOWN.get(key) ?? LEGACY_NAMES.get(String(name ?? '').trim().toLowerCase().replace(/ё/g, 'е')) ?? LEGACY_NAMES.get(key) ?? name;
}

// Выписка: приводим названия категорий к базе и поправляем то, что справочник знает точно.
// Магазин или организация (ФНС, Золотое яблоко) определяют категорию расхода всегда; общие слова — только вместо «Остальное».
export function refineStatementItem(tx) {
  const out = { ...tx, category: canonicalCategory(tx.category) };
  if (out.type !== 'expense') return out;
  const brand = matchBrandInText(`${tx.description ?? ''} ${tx.comment ?? ''}`);
  if (brand) {
    out.category = brand.category;
    if (!out.comment) out.comment = brand.comment;
    return out;
  }
  if (out.category === 'Остальное') {
    const hint = matchHint(tx.description ?? '');
    if (hint && hint.type === 'expense') out.category = hint.category;
  }
  return out;
}

// Сверка списка категорий в коде с системными категориями в базе (имена должны совпадать буква в букву)
export function compareWithDb(dbNames) {
  const inDb = new Set(dbNames);
  const inCode = new Set([...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES]);
  return {
    missingInDb: [...inCode].filter((n) => !inDb.has(n)),
    notInCode: [...inDb].filter((n) => !inCode.has(n)),
  };
}
