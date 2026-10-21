// Источник регистрации (метки рекламной ссылки). Нужен для подсчёта, какая реклама приводит пользователей.
// Данные приходят от браузера или из ссылки на бота, поэтому всё проверяется и обрезается.
const KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref', 'landing'];
const UTM_KEYS = KEYS.filter((k) => k.startsWith('utm_'));

const cleanStr = (v, max = 100) =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f<>"'`]/g, '').trim().slice(0, max) : '';

// Из тела запроса регистрации: объект с метками или null
export function sanitizeUtm(input, via = 'web_register') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const k of KEYS) {
    const v = cleanStr(input[k]);
    if (v) out[k] = v;
  }
  if (!UTM_KEYS.some((k) => out[k]) && !out.ref) return null;
  const at = typeof input.at === 'string' ? new Date(input.at) : null;
  if (at && !Number.isNaN(at.getTime())) out.at = at.toISOString();
  out.via = via;
  return out;
}

// Параметр ссылки на бота: u_<источник>_<канал>_<кампания> или r_<сайт>; символы только a-z и 0-9
// (так же строит ссылку браузерный скрипт public/js/consent.js)
const TOKEN = /^[a-z0-9]{1,16}$/;
export function parseStartPayload(payload) {
  if (typeof payload !== 'string' || payload.length > 64) return null;
  const parts = payload.split('_');
  if (parts[0] === 'u' && parts.length >= 2 && parts.length <= 4 && parts.slice(1).every((p) => TOKEN.test(p))) {
    const [source, medium, campaign] = parts.slice(1);
    const out = { utm_source: source };
    if (medium) out.utm_medium = medium;
    if (campaign) out.utm_campaign = campaign;
    out.via = 'tg_start';
    return out;
  }
  if (parts[0] === 'r' && parts.length === 2 && TOKEN.test(parts[1])) return { ref: parts[1], via: 'tg_start' };
  return null;
}
