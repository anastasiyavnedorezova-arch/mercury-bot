// Патч 55 (28.10.2026): предупреждение про ФИО и реквизиты в выписках — в Согласии, в FAQ бота и в FAQ кабинета.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('Согласие, п. 5.1: выписки названы прямо, ФИО и реквизиты можно закрыть, профиль не передаётся', () => {
  const t = read('public/legal/consent.html');
  assert.match(t, /Редакция от 28\.10\.2026/);
  assert.match(t, /5\.1\. [^<]*банковских выписок, которые я отправляю сам/);
  assert.match(t, /могут содержать мои ФИО, номера карт и счетов/);
  assert.match(t, /я могу закрыть эти данные до отправки/);
  assert.match(t, /из моего профиля при этом не передаются/);
  assert.match(t, /5\.2\. Мне известно, что данные для распознавания передаются за пределы Российской Федерации, в Нидерланды и США/);
});

test('FAQ бота и FAQ кабинета советуют закрыть ФИО и номера до отправки выписки', () => {
  const msg = read('src/handlers/message.js');
  assert.match(msg, /Перед отправкой лучше закрыть ФИО, номера карт и счетов: для учёта они не нужны\. Файл уходит на распознавание за границу/);
  const faq = read('public/cabinet/faq.html');
  assert.match(faq, /Как загрузить выписку из банка\?/);
  assert.match(faq, /Перед отправкой лучше закрыть ФИО, номера карт и счетов/);
  assert.match(faq, /href="\/legal\/consent">Согласии на обработку персональных данных<\/a>/);
});

test('политика не менялась, редакция 23.10.2026', () => {
  assert.match(read('public/legal/privacy.html'), /Редакция от 23\.10\.2026/);
});
