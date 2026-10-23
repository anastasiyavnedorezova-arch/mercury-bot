// Страница входа: кнопка Telegram иногда не прогружается — подсказываем перезагрузить страницу (23.10.2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const login = fs.readFileSync(new URL('../public/cabinet/login.html', import.meta.url), 'utf8');

test('вход: под кнопкой Telegram подсказка «Если кнопка не отображается, перезагрузи страницу»', () => {
  assert.equal((login.match(/Если кнопка не отображается, перезагрузи страницу/g) || []).length, 1);
  // подсказка стоит сразу после блока с кнопкой (social-row), внутри панели входа
  const row = login.indexOf('<div class="social-row">');
  const hint = login.indexOf('<p class="social-hint">');
  const reset = login.indexOf('PANEL: RESET PASSWORD');
  assert.ok(row > 0 && hint > row && hint < reset);
});
