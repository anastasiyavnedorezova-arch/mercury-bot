// Сохраняет все письма в HTML-файлы, чтобы посмотреть их в браузере (двойной клик по файлу).
//   node tools/email/render_previews.mjs [папка_вывода] [папка_с_баннерами]
// По умолчанию: ./email-previews и public/email/banners
import fs from 'node:fs';
import path from 'node:path';
import { LETTER_KEYS, LETTERS, renderLetter } from '../../src/emails/letters.js';

process.env.JWT_SECRET ||= 'preview-only';
const out = path.resolve(process.argv[2] ?? 'email-previews');
const banners = path.resolve(process.argv[3] ?? 'public/email/banners');
fs.mkdirSync(out, { recursive: true });

const rows = [];
for (const key of LETTER_KEYS) {
  const { html, subject } = renderLetter(key, {
    userId: '00000000-0000-4000-8000-000000000000',
    bannerBase: `file://${banners}`,
    unsubUrl: 'https://finnikbot.ru/unsubscribe',
  });
  const file = `${key}.html`;
  fs.writeFileSync(path.join(out, file), html);
  rows.push(`<li><a href="${file}">${LETTERS[key].number} ${LETTERS[key].title}</a> — <i>${subject}</i></li>`);
}
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Письма Финника</title><ul style="font:16px/2 Arial">${rows.join('')}</ul>`);
console.log(`Готово: ${out}/index.html`);
