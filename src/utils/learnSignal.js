// «Научи бота» (патч 50): когда бот не распознал запись, а человек добавил её вручную, можно предложить передать фразу разработчику.
// Спрашиваем только если из фразы есть чему учиться: настоящее слово или название, которое бот не знает.
// Бессмыслицу, опечатки, чужой язык и раскладку, одну сумму и вопросы не спрашиваем.

const VOWELS = /[аеёиоуыэюя]/i;
const ROWS = ['йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбю'];
const WORD = /[A-Za-zА-Яа-яЁё]+(?:-[A-Za-zА-Яа-яЁё]+)*/g;
const UNITS = /^(?:р|руб|рублей|рубля|рубль|тыс|тысяч|тк|к|k|млн)$/i;
const MAX_LEN = 100;
const MAX_WORDS = 8;

// Причины, по которым ИИ не распознал запись, и в которых учиться нечему
const NOT_LEARNABLE_REASONS = new Set(['typo', 'gibberish', 'foreign', 'other']);

export const REMEMBER_MS = 15 * 60 * 1000;

const isCyr = (w) => /[А-Яа-яЁё]/.test(w);
const isLat = (w) => /[A-Za-z]/.test(w);

// Подряд идущие буквы с одного ряда клавиатуры («йцукен», «фывап», «нгшщ») — случайный набор
function keyboardMash(word, run = 4) {
  const w = word.toLowerCase().replace(/ё/g, 'е');
  for (const row of ROWS) {
    const rev = [...row].reverse().join('');
    for (let i = 0; i + run <= w.length; i++) {
      const part = w.slice(i, i + run);
      if (row.includes(part) || rev.includes(part)) return true;
    }
  }
  return false;
}

function goodCyrillicWord(w) {
  const letters = w.replace(/-/g, '');
  return letters.length >= 3 && VOWELS.test(letters) && !/(.)\1{3,}/i.test(letters) && !keyboardMash(letters);
}

// Откровенный случайный набор («ывапр», «ффффф», «йцукен»): такую фразу не записываем в «Остальное», она не запись.
// Нарочно строже, чем analyzePhrase: настоящие сокращения без гласных («мфц», «днс») сюда не попадают.
export function looksLikeMash(text) {
  const words = (String(text ?? '').match(WORD) ?? []).filter((w) => !UNITS.test(w));
  return words.some((w) => isCyr(w) && !isLat(w) && (/(.)\1{3,}/i.test(w) || keyboardMash(w, 5)));
}

// Слова фразы без сумм, ё → е, нижний регистр: по ним сравниваем фразы между собой
export function phraseKey(text) {
  return (String(text ?? '').match(WORD) ?? []).filter((w) => !UNITS.test(w)).map((w) => w.toLowerCase().replace(/ё/g, 'е')).join(' ');
}

// → { ok: true } или { ok: false, why }
export function analyzePhrase(text, aiReason) {
  const t = String(text ?? '').trim();
  if (!t) return { ok: false, why: 'empty' };
  if (t.startsWith('/')) return { ok: false, why: 'command' };
  if (t.includes('?')) return { ok: false, why: 'question' };
  if (t.length > MAX_LEN) return { ok: false, why: 'too_long' };
  // Единицы суммы («р», «руб», «тыс», «к») словами не считаем
  const words = (t.match(WORD) ?? []).filter((w) => !UNITS.test(w));
  if (!words.length) return { ok: false, why: 'no_word' };
  if (words.length > MAX_WORDS) return { ok: false, why: 'too_long' };
  if (words.some((w) => isCyr(w) && isLat(w))) return { ok: false, why: 'mixed_alphabet' };
  if (!words.some(isCyr)) return { ok: false, why: 'foreign' };
  // Латинские «слова» без гласных («rjgbk», «ghbdtn»): русский текст, набранный в английской раскладке
  if (words.some((w) => isLat(w) && w.replace(/-/g, '').length >= 3 && !/[aeiouy]/i.test(w))) return { ok: false, why: 'layout' };
  if (!words.filter(isCyr).some(goodCyrillicWord)) return { ok: false, why: 'gibberish' };
  const reason = String(aiReason ?? '').trim().toLowerCase();
  if (NOT_LEARNABLE_REASONS.has(reason)) return { ok: false, why: `ai_${reason}` };
  return { ok: true };
}

// Фраза, не распознанная ботом, ждёт, пока человек запишет её вручную (в памяти процесса)
const recent = new Map();

export function rememberUnrecognized(telegramId, info, now = Date.now()) {
  recent.set(String(telegramId), { text: info.text, reason: info.reason ?? null, at: now });
}
export function clearUnrecognized(telegramId) {
  recent.delete(String(telegramId));
}
export function takeUnrecognized(telegramId, now = Date.now()) {
  const key = String(telegramId);
  const item = recent.get(key);
  recent.delete(key);
  return item && now - item.at <= REMEMBER_MS ? item : null;
}

export const LEARN_ASK_TEXT = (phrase) =>
  `Хочешь, передам эту фразу разработчикам? 🤓\n«${phrase}»\n` +
  'Я пока не смог её распознать, а с твоей помощью смогу стать лучше 🙏';
export const LEARN_THANKS_TEXT = 'Круто! Я всё передал, спасибо! 🙏';
export const LEARN_DECLINED_TEXT = 'Хорошо, как скажешь 🙂';

export const learnKeyboard = (signalId) => ({
  reply_markup: {
    inline_keyboard: [[
      { text: 'Да, передать', callback_data: `learn:yes:${signalId}` },
      { text: 'Нет, не надо', callback_data: `learn:no:${signalId}` },
    ]],
  },
});
