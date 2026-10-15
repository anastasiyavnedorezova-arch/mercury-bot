// Настройки писем, которые меняются руками.

// Ссылки для кнопок «Оплатить 1 / 6 / 12 мес» в письмах: открывают профиль в кабинете, а он создаёт платёж ЮKassa
// (если человек не вошёл — сначала предложит войти и вернёт обратно). Адрес зависит от APP_BASE_URL.
export const payUrl = (months) => `${baseUrl()}/cabinet/profile?pay=${months}`;
export const PAY_URLS = {
  get 1() { return payUrl(1); },
  get 6() { return payUrl(6); },
  get 12() { return payUrl(12); },
};

// Письмо №2.2 («Почитай, что пишут») содержит отзывы пользователей. Отправляется только если владелец подтвердил,
// что это настоящие отзывы реальных людей. Подтверждено 13.10.2026: отзывы настоящих тестовых пользователей.
// Появятся новые или изменятся тексты отзывов — убедиться, что они тоже настоящие.
export const TESTIMONIALS_CONFIRMED = true;

export function baseUrl() {
  return (process.env.APP_BASE_URL || 'https://finnikbot.ru').replace(/\/+$/, '');
}

export const SUPPORT_EMAIL = 'hello@finnikbot.ru';

// ── Режим работы отправки (переменные окружения; по умолчанию письма НЕ отправляются) ──────────────────────
// LETTERS_MODE=off|dry|on  — off: ничего; dry: только пишет в лог, кому и что отправил бы; on: отправляет.
// LETTERS_ONLY_TO=a@x.ru,b@y.ru — если задано, письма уходят только на эти адреса (защита на стейдже).
// LETTERS_CHAIN_START=2026-10-14T00:00:00+03:00 — кто зарегистрировался раньше, считается «старым аккаунтом»
//   и получает только письма про срок пробного периода (№4.1, №4.2, №5). Без этой переменной «новых» нет.
// LETTERS_ALLOW_NO_PAY_LINKS=true — разрешить письма с кнопками «Оплатить», даже если ключи ЮKassa не заданы (только для тестов).
export function lettersMode() {
  const m = String(process.env.LETTERS_MODE || 'off').toLowerCase();
  return ['off', 'dry', 'on'].includes(m) ? m : 'off';
}

export function lettersOnlyTo() {
  const raw = String(process.env.LETTERS_ONLY_TO || '').trim();
  return raw ? new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) : null;
}

export function chainStart() {
  const raw = process.env.LETTERS_CHAIN_START;
  const d = raw ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

// Письма с кнопками «Оплатить» можно слать, только когда оплата реально работает (заданы ключи ЮKassa).
export function paymentsReady() {
  if (String(process.env.LETTERS_ALLOW_NO_PAY_LINKS).toLowerCase() === 'true') return true;
  return Boolean(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY);
}

// Можно ли прямо сейчас отправить письмо на этот адрес (для писем, которые уходят не из цепочки, например «Подписка активирована»)
export function maySendTo(email) {
  if (lettersMode() !== 'on') return false;
  const only = lettersOnlyTo();
  return !only || only.has(String(email ?? '').trim().toLowerCase());
}
