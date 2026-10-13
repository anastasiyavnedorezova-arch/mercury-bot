// Движок вёрстки писем: из описания блоков собирает HTML (таблицы + инлайн-стили, работает в Gmail, Mail.ru,
// Яндекс.Почте, Apple Mail) и текстовую версию. Содержание писем — в letters.js.
import { escapeHtml } from '../utils/email.js';

const FONT = 'Arial, Helvetica, sans-serif';
const BTN_FONT = "Manrope, Arial, Helvetica, sans-serif";

export const COLORS = {
  card: '#EEF2F6',
  text: '#000000',
  gray: '#6B7280',
  blue: '#4C9AFF',
  green: '#2FBF71',
  dark: '#1E2A38',
  red: '#E5484D',
  footer: '#9CA3AF',
};

// ── Конструкторы блоков ───────────────────────────────────────────────────

// Кусок текста с оформлением: b — жирный, i — курсив, s — зачёркнутый, c — цвет, z — размер, href — ссылка
export const t = (text, o = {}) => ({ text, ...o });

// Абзац. o: align ('left' | 'center'), size (16), lh (межстрочный, по умолчанию size × 1.2), color
export const P = (runs, o = {}) => ({ type: 'p', runs: Array.isArray(runs) ? runs : [runs], ...o });

// Кнопки. items: [{ label, url|null, bg }]. Без url кнопка рисуется, но не кликабельна (платёжная ссылка ещё не подключена).
export const buttons = (items) => ({ type: 'buttons', items });

// Карточка с серой подложкой. o: bg, pad (32), radius (24)
export const card = (children, o = {}) => ({ type: 'card', children, ...o });

// Две колонки цитат: rows — массив строк по две цитаты
export const quotes = (rows) => ({ type: 'quotes', rows });

// Баннер-картинка 600×350 (файл лежит в public/email/banners/)
export const banner = (file, alt) => ({ type: 'banner', file, alt });

// ── HTML ──────────────────────────────────────────────────────────────────

function runHtml(r) {
  const run = typeof r === 'string' ? { text: r } : r;
  const st = [];
  if (run.c) st.push(`color:${run.c}`);
  if (run.b) st.push('font-weight:700');
  if (run.i) st.push('font-style:italic');
  if (run.s) st.push('text-decoration:line-through');
  if (run.z) st.push(`font-size:${run.z}px`, `line-height:${run.lh ?? Math.round(run.z * 1.5)}px`);
  let inner = escapeHtml(run.text).replace(/\n/g, '<br>');
  if (run.href) {
    const color = run.c ?? COLORS.blue;
    return `<a href="${escapeHtml(run.href)}" style="color:${color};text-decoration:underline;${st.filter((x) => !x.startsWith('color:')).join(';')}">${inner}</a>`;
  }
  return st.length ? `<span style="${st.join(';')}">${inner}</span>` : inner;
}

function pHtml(p, last) {
  const size = p.size ?? 16;
  const lh = p.lh ?? Math.round(size * 1.2 * 10) / 10;
  const style = [
    `margin:0 0 ${last ? 0 : 12}px`,
    `font-family:${FONT}`,
    `font-size:${size}px`,
    `line-height:${lh}px`,
    `color:${p.color ?? COLORS.text}`,
    `text-align:${p.align ?? 'left'}`,
  ];
  if (p.b) style.push('font-weight:700');
  if (p.i) style.push('font-style:italic');
  return `<p style="${style.join(';')}">${p.runs.map(runHtml).join('')}</p>`;
}

function buttonsHtml(b) {
  const cells = b.items.map((it) => {
    const style = [
      'display:inline-block',
      `background:${it.bg}`,
      'color:#ffffff',
      `font-family:${BTN_FONT}`,
      'font-size:14px',
      'font-weight:600',
      'line-height:20px',
      'letter-spacing:0.14px',
      'text-decoration:none',
      'padding:10px 20px',
      'mso-padding-alt:10px 20px',
      'border-radius:10px',
      'margin:6px',
    ].join(';');
    return it.url
      ? `<a href="${escapeHtml(it.url)}" style="${style}">${escapeHtml(it.label)}</a>`
      : `<span style="${style}">${escapeHtml(it.label)}</span>`;
  });
  return `<div style="text-align:center;padding:6px 0 0">${cells.join(' ')}</div>`;
}

function cardHtml(c) {
  const pad = c.pad ?? 32;
  const radius = c.radius ?? 24;
  const bg = c.bg ?? COLORS.card;
  const lastIdx = c.children.length - 1;
  const inner = c.children
    .map((ch, i) => (ch.type === 'buttons' ? buttonsHtml(ch) : pHtml(ch, i === lastIdx)))
    .join('\n');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${bg}" style="background:${bg};border-radius:${radius}px"><tr><td class="pad-${pad}" style="padding:${pad}px">
${inner}
</td></tr></table>`;
}

function quotesHtml(q) {
  const rows = q.rows
    .map((row, ri) => {
      const bottom = ri === q.rows.length - 1 ? 0 : 12;
      const cells = row
        .map((text, ci) => {
          const padding = ci === 0 ? `0 6px ${bottom}px 0` : `0 0 ${bottom}px 6px`;
          return `<td class="q-cell" width="50%" valign="top" style="width:50%;padding:${padding}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.blue}" style="background:${COLORS.blue};border-radius:16px"><tr><td style="padding:20px;font-family:${FONT};font-size:14px;line-height:16.8px;font-style:italic;color:#ffffff">${escapeHtml(text)}</td></tr></table>
</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('\n');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>`;
}

function bannerHtml(b, bannerBase) {
  return `<img src="${escapeHtml(`${bannerBase}/${b.file}`)}" width="600" height="350" alt="${escapeHtml(b.alt)}" style="display:block;width:100%;max-width:600px;height:auto;border:0;outline:none;text-decoration:none">`;
}

function blockHtml(b, bannerBase) {
  switch (b.type) {
    case 'banner': return bannerHtml(b, bannerBase);
    case 'card': return cardHtml(b);
    case 'quotes': return quotesHtml(b);
    default: throw new Error(`unknown block ${b.type}`);
  }
}

/**
 * @param {object} o
 * @param {string} o.subject
 * @param {string} [o.preheader]  короткий текст, который почта показывает рядом с темой
 * @param {Array}  o.blocks
 * @param {string[]} o.footerLines  уже готовые HTML-строки подвала
 * @param {string} o.bannerBase     откуда грузить баннеры, без слэша на конце
 */
export function layoutHtml({ subject, preheader, blocks, footerHtml, bannerBase }) {
  const rows = blocks
    .map((b) => `<tr><td style="padding-bottom:12px">${blockHtml(b, bannerBase)}</td></tr>`)
    .join('\n');
  const pre = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">${escapeHtml(preheader)}${'&nbsp;&zwnj;'.repeat(40)}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="ru" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(subject)}</title>
<style>
@media only screen and (max-width:620px){
  .pad-32{padding:20px !important}
  .q-cell{display:block !important;width:100% !important;padding:0 0 12px !important}
}
</style>
</head>
<body style="margin:0;padding:0;background:#ffffff">
${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="background:#ffffff"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
${rows}
<tr><td style="padding:8px 20px 0;text-align:center;font-family:${FONT};font-size:12px;line-height:17px;color:${COLORS.footer}">${footerHtml}</td></tr>
</table>
</td></tr></table>
</body>
</html>`;
}

// ── Текстовая версия ──────────────────────────────────────────────────────

function runText(r) {
  const run = typeof r === 'string' ? { text: r } : r;
  const text = run.tx ?? run.text; // tx — особая запись для текстовой версии (например, вместо зачёркивания)
  return run.href && !run.href.startsWith('mailto:') ? `${text} (${run.href})` : text;
}

function blockText(b) {
  if (b.type === 'banner') return '';
  if (b.type === 'quotes') return b.rows.flat().map((q) => q).join('\n\n');
  if (b.type === 'card') {
    return b.children
      .map((ch) => {
        if (ch.type === 'buttons') {
          return ch.items.filter((it) => it.url).map((it) => `${it.label}: ${it.url}`).join('\n');
        }
        return ch.runs.map(runText).join('');
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

export function layoutText({ blocks, footerText }) {
  return `${blocks.map(blockText).filter(Boolean).join('\n\n')}\n\n--\n${footerText}\n`;
}
