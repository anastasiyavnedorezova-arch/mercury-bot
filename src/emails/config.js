// Настройки писем, которые меняются руками.

// Ссылки на оплату для кнопок «Оплатить 1 / 6 / 12 мес». Пока платёжная система не подключена — null:
// кнопка рисуется, но не кликабельна. Когда подключим оплату, сюда вписываем ссылки (или адреса страниц оплаты).
export const PAY_URLS = { 1: null, 6: null, 12: null };

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
// LETTERS_ALLOW_NO_PAY_LINKS=true — разрешить письма с кнопками «Оплатить» без ссылок оплаты (только для тестов).
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

export function paymentsReady() {
  if (String(process.env.LETTERS_ALLOW_NO_PAY_LINKS).toLowerCase() === 'true') return true;
  return Boolean(PAY_URLS[1] && PAY_URLS[6] && PAY_URLS[12]);
}
