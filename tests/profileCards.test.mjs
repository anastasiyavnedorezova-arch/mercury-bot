// Страница профиля: правки карточек «Личные данные», «Telegram», «Тариф» (23.10.2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../public/cabinet/profile.html', import.meta.url), 'utf8');
const body = html.slice(html.indexOf('<!-- TOP CARDS GRID -->'), html.indexOf('<!-- DANGER ZONE -->'));
const script = html.slice(html.indexOf('function renderProfile'), html.indexOf('async function activateTrial'));

test('профиль: в карточках нет даты регистрации, иконки Telegram и «Осталось»', () => {
  assert.ok(!body.includes('Дата регистрации'));
  assert.ok(!body.includes('tg-avatar') && !body.includes('<svg'));
  assert.ok(!body.includes('Осталось') && !html.includes('subLeft') && !html.includes('personalCreated'));
});

test('профиль: карточка «Подписка» переименована в «Тариф», поле «Действующий тариф»', () => {
  assert.match(body, /<span class="card-title">Тариф<\/span>/);
  assert.ok(!body.includes('<span class="card-title">Подписка</span>'));
  assert.match(body, /Действующий тариф:/);
});

test('профиль: тариф — «Пробный период» или «Подписка (N мес)»', () => {
  assert.ok(script.includes("subPlan.textContent = 'Пробный период'"));
  assert.ok(script.includes("'Подписка (' + (sub.period_months || 1) + ' мес)'"));
  assert.ok(!script.includes('Пробный тариф'));
});

test('профиль: «Редактировать» и «Отключить» — с синей обводкой #4C9AFF, ховер #EAF2FF', () => {
  assert.match(html, /\.mini-btn-outline\{[^}]*color:#4C9AFF;border:1px solid #4C9AFF\}/);
  assert.match(html, /\.mini-btn-outline:hover\{background:#EAF2FF\}/);
  assert.match(body, /class="mini-btn mini-btn-outline" onclick="openEditProfile\(\)"/);
  assert.match(script, /'Отключить';\s*tgBtn\.className = 'mini-btn mini-btn-outline'/);
});

test('профиль: «Подключить» и кнопка тарифа — зелёные, ховер #28A862', () => {
  assert.match(html, /\.mini-btn-green\{background:#2FBF71;color:#fff\}/);
  assert.match(html, /\.mini-btn-green:hover\{background:#28A862\}/);
  assert.match(script, /'Подключить';\s*tgBtn\.className = 'mini-btn mini-btn-green'/);
  assert.equal((script.match(/subBtn\.className = 'mini-btn mini-btn-green'/g) || []).length, 4);
  assert.ok(script.includes("'Оплатить подписку'") && script.includes("'Продлить подписку'"));
  // обработчик подключения по-прежнему узнаёт кнопку по тексту
  assert.ok(html.includes("this.textContent.trim() === 'Подключить'"));
});

test('профиль: значения в карточках — Manrope 16px / 600 / 24px, цвет #2D3748', () => {
  assert.ok(html.includes(".profile-top-grid .field-value{align-self:stretch;color:#2D3748;font-size:16px;font-family:'Manrope',sans-serif;font-weight:600;line-height:24px;word-wrap:break-word}"));
});
