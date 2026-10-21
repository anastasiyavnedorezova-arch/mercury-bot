/* Баннер cookie, счётчик Яндекс Метрики и метки источника (utm). Подключается на страницах сайта.
 *  - Метрика загружается ТОЛЬКО после нажатия «Принять»; Вебвизор, карта кликов и аналитика форм выключены.
 *  - В Метрику уходят только имена целей (register, pay_start, paid, bot_click): без почты, сумм и текстов.
 *  - Метки источника (utm_*, домен сайта, с которого пришли) запоминаются в браузере, чтобы сохранить их при регистрации.
 *  - Выбор хранится в localStorage (finnik_consent). Изменить выбор: любая ссылка с атрибутом data-cookie-settings. */
(function (root) {
  'use strict';

  var COUNTER_ID = 113714004;
  var CONSENT_KEY = 'finnik_consent';
  var UTM_KEY = 'finnik_utm';
  var UTM_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  var GOALS = { register: 1, pay_start: 1, paid: 1, bot_click: 1 };

  // ── Вспомогательные функции (без обращения к странице, их проверяют тесты) ──
  function cleanValue(v) {
    return String(v == null ? '' : v).replace(/[\u0000-\u001f<>"'`]/g, '').trim().slice(0, 100);
  }

  // Метки из адреса страницы и домен сайта-источника. Возвращает объект или null, если ничего нет.
  function parseUtm(search, referrer, ownHost, pathname) {
    var out = {};
    var any = false;
    var params;
    try { params = new URLSearchParams(search || ''); } catch (e) { params = null; }
    if (params) {
      UTM_FIELDS.forEach(function (k) {
        var v = cleanValue(params.get(k));
        if (v) { out[k] = v; any = true; }
      });
    }
    var refHost = '';
    try { if (referrer) refHost = new URL(referrer).hostname.replace(/^www\./, ''); } catch (e) { refHost = ''; }
    var own = String(ownHost || '').replace(/^www\./, '');
    if (refHost && refHost !== own && refHost.slice(-own.length - 1) !== '.' + own) out.ref = cleanValue(refHost);
    if (!any && !out.ref) return null;
    if (pathname) out.landing = cleanValue(pathname);
    return out;
  }

  // Что сохранить: метки рекламной ссылки заменяют прежние, иначе остаются прежние, иначе берём источник-домен.
  function mergeUtm(existing, found) {
    if (!found) return existing || null;
    var hasUtm = UTM_FIELDS.some(function (k) { return !!found[k]; });
    if (hasUtm) return found;
    return existing || found;
  }

  function normalizeChoice(raw) {
    try {
      var o = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (o && (o.choice === 'all' || o.choice === 'necessary')) return o.choice;
    } catch (e) { /* нет выбора */ }
    return null;
  }

  // Параметр ссылки на бота (t.me/...?start=...): u_<источник>_<канал>_<кампания> или r_<сайт>.
  // Только a-z и 0-9 (так просит Telegram), поэтому в метках рекламы лучше писать латиницей.
  function startParam(utm) {
    if (!utm) return '';
    function tok(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16); }
    var parts = [tok(utm.utm_source), tok(utm.utm_medium), tok(utm.utm_campaign)];
    if (parts[0]) {
      while (parts.length > 1 && !parts[parts.length - 1]) parts.pop();
      if (parts.some(function (p) { return !p; })) parts = [parts[0]];
      return 'u_' + parts.join('_');
    }
    var r = tok(String(utm.ref || '').replace(/\./g, ''));
    return r ? 'r_' + r : '';
  }

  var api = { startParam: startParam, cleanValue: cleanValue, parseUtm: parseUtm, mergeUtm: mergeUtm, normalizeChoice: normalizeChoice, COUNTER_ID: COUNTER_ID, GOALS: GOALS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof document === 'undefined' || !root || root.finnikConsent) return;

  // ── Работа в браузере ──
  var metrikaLoaded = false;

  function store(key, value) {
    try { if (value === undefined) return root.localStorage.getItem(key); root.localStorage.setItem(key, value); } catch (e) { return null; }
    return null;
  }

  function loadMetrika() {
    if (metrikaLoaded) return;
    metrikaLoaded = true;
    root['disableYaCounter' + COUNTER_ID] = false;
    (function (m, e, t, r, i, k, a) {
      m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
      m[i].l = 1 * new Date();
      for (var j = 0; j < document.scripts.length; j++) { if (document.scripts[j].src === r) { return; } }
      k = e.createElement(t); a = e.getElementsByTagName(t)[0]; k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);
    })(root, document, 'script', 'https://mc.yandex.ru/metrika/tag.js?id=' + COUNTER_ID, 'ym');
    root.ym(COUNTER_ID, 'init', {
      clickmap: false, webvisor: false, trackLinks: true, accurateTrackBounce: true,
      referrer: document.referrer, url: location.href
    });
  }

  function stopMetrika() {
    root['disableYaCounter' + COUNTER_ID] = true;
    metrikaLoaded = false;
    try {
      document.cookie.split(';').forEach(function (c) {
        var name = c.split('=')[0].trim();
        if (name.indexOf('_ym') !== 0) return;
        var host = location.hostname;
        [host, '.' + host, '.' + host.split('.').slice(-2).join('.')].forEach(function (d) {
          document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=' + d;
        });
        document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
      });
    } catch (e) { /* не страшно */ }
  }

  function currentChoice() { return normalizeChoice(store(CONSENT_KEY)); }

  function applyChoice(choice) {
    if (choice === 'all') loadMetrika(); else stopMetrika();
  }

  // Цель в Метрике: только если человек согласился и счётчик загружен
  function goal(name) {
    if (!GOALS[name] || currentChoice() !== 'all' || !metrikaLoaded || typeof root.ym !== 'function') return;
    try { root.ym(COUNTER_ID, 'reachGoal', name); } catch (e) { /* не мешаем странице */ }
  }

  // ── Метки источника ──
  function captureUtm() {
    var found = parseUtm(location.search, document.referrer, location.hostname, location.pathname);
    var existing = null;
    try { existing = JSON.parse(store(UTM_KEY) || 'null'); } catch (e) { existing = null; }
    var next = mergeUtm(existing, found);
    if (next && next !== existing) {
      if (!next.at) next.at = new Date().toISOString();
      store(UTM_KEY, JSON.stringify(next));
    }
  }

  function getUtm() {
    try { return JSON.parse(store(UTM_KEY) || 'null'); } catch (e) { return null; }
  }

  // ── Баннер ──
  var banner = null;

  function injectStyle() {
    if (document.getElementById('finnik-consent-style')) return;
    var st = document.createElement('style');
    st.id = 'finnik-consent-style';
    st.textContent =
      '#finnik-consent{position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483000;max-width:720px;margin:0 auto;' +
      'background:#fff;border:1px solid #E2E8F0;border-radius:16px;box-shadow:0 8px 32px rgba(30,42,56,.18);padding:16px 18px;' +
      'font-family:Manrope,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#2D3748;display:flex;gap:16px;align-items:center}' +
      '#finnik-consent p{margin:0;font-size:14px;line-height:20px;flex:1}' +
      '#finnik-consent a{color:#1E2A38;text-decoration:underline}' +
      '#finnik-consent .fc-btns{display:flex;gap:8px;flex-shrink:0}' +
      '#finnik-consent button{font:inherit;font-size:14px;font-weight:600;line-height:20px;border-radius:12px;padding:10px 16px;cursor:pointer;' +
      'min-height:44px;white-space:nowrap}' +
      '#finnik-consent .fc-accept{background:#1E2A38;color:#fff;border:1px solid #1E2A38}' +
      '#finnik-consent .fc-reject{background:#fff;color:#1E2A38;border:1px solid #CBD5E1}' +
      '#finnik-consent button:focus-visible{outline:3px solid #4C9AFF;outline-offset:2px}' +
      '@media (max-width:640px){#finnik-consent{flex-direction:column;align-items:stretch;gap:12px;left:12px;right:12px;bottom:12px}' +
      '#finnik-consent .fc-btns{flex-direction:column}#finnik-consent button{width:100%}}';
    document.head.appendChild(st);
  }

  function closeBanner() {
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
  }

  function choose(choice) {
    store(CONSENT_KEY, JSON.stringify({ v: 1, choice: choice, at: new Date().toISOString() }));
    closeBanner();
    applyChoice(choice);
  }

  function openBanner() {
    if (banner) return;
    injectStyle();
    banner = document.createElement('div');
    banner.id = 'finnik-consent';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Настройки cookie');

    var p = document.createElement('p');
    p.appendChild(document.createTextNode('Мы используем cookie и счётчик Яндекс Метрики, чтобы понимать, как люди пользуются сайтом. Счётчик включится, только если ты согласишься. Подробнее в '));
    var a = document.createElement('a');
    a.href = '/legal/cookies';
    a.textContent = 'Политике cookies';
    p.appendChild(a);
    p.appendChild(document.createTextNode('.'));

    var btns = document.createElement('div');
    btns.className = 'fc-btns';
    var reject = document.createElement('button');
    reject.type = 'button'; reject.className = 'fc-reject'; reject.textContent = 'Только необходимые';
    reject.addEventListener('click', function () { choose('necessary'); });
    var accept = document.createElement('button');
    accept.type = 'button'; accept.className = 'fc-accept'; accept.textContent = 'Принять';
    accept.addEventListener('click', function () { choose('all'); });
    btns.appendChild(reject);
    btns.appendChild(accept);

    banner.appendChild(p);
    banner.appendChild(btns);
    document.body.appendChild(banner);
  }

  root.finnikConsent = { open: openBanner, get: currentChoice, getUtm: getUtm, goal: goal };
  root.finnikGoal = goal;

  function init() {
    captureUtm();
    var c = currentChoice();
    if (c) applyChoice(c); else openBanner();

    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('a,[data-cookie-settings]') : null;
      if (!el) return;
      if (el.hasAttribute('data-cookie-settings')) { e.preventDefault(); closeBanner(); openBanner(); return; }
      var href = el.getAttribute('href') || '';
      if (/t\.me\/FinnikMoneyBot/i.test(href)) {
        // Источник перехода передаём боту (если у ссылки нет своего параметра start)
        var sp = startParam(getUtm());
        if (sp && href.indexOf('start=') === -1) el.setAttribute('href', href + (href.indexOf('?') === -1 ? '?' : '&') + 'start=' + sp);
        goal('bot_click');
      }
    }, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(typeof window !== 'undefined' ? window : undefined);
