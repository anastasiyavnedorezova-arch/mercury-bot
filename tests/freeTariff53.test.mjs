// Патч 53 (27.10.2026): что видит человек на тарифе free — без повторного пробного периода, замочек в меню, окно тарифов.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { budgetPaywall, featurePaywall, freeTariffScreen } from '../src/utils/paywall.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const buttons = (kb) => kb.inline_keyboard.flat().map((b) => b.callback_data);

test('пробный период уже был: предлагаем только подписку', () => {
  for (const make of [budgetPaywall, featurePaywall, freeTariffScreen]) {
    const w = make(true);
    assert.ok(buttons(w.keyboard).includes('buy_subscription'), make.name);
    assert.ok(!buttons(w.keyboard).includes('onboarding:activate_trial'), make.name);
    assert.ok(!/бесплатно|пробн/i.test(w.text), `${make.name}: ${w.text}`);
  }
});

test('пробного ещё не было: предлагаем пробный период', () => {
  for (const make of [budgetPaywall, featurePaywall, freeTariffScreen]) {
    const w = make(false);
    assert.ok(buttons(w.keyboard).includes('onboarding:activate_trial'), make.name);
    assert.match(w.text, /30 дней/);
  }
  assert.ok(buttons(freeTariffScreen(false).keyboard).includes('buy_subscription'));
  assert.ok(buttons(budgetPaywall(true).keyboard).includes('menu:main'));
});

test('экран тарифа free перечисляет то же, что и раньше', () => {
  const t = freeTariffScreen(true).text;
  for (const s of ['Твой тариф: Бесплатный', '1 финансовая цель', 'редактирование и удаление записей', 'бюджет и алерты', 'свои категории']) assert.ok(t.includes(s), s);
  for (const s of [t, budgetPaywall(true).text, featurePaywall(true).text]) assert.ok(!/\bвы\b|ите\b|ете\b/i.test(s), s);
});

test('бот: три места про платные функции берут тексты из paywall и проверяют, был ли пробный', () => {
  for (const f of ['src/handlers/budget.js', 'src/handlers/analytics.js', 'src/handlers/subscription.js']) {
    const s = read(f);
    assert.ok(s.includes('hadTrial(supabase, userId)'), f);
    assert.ok(!s.includes("text: 'Активировать пробный период'"), `${f}: кнопка пробного периода должна быть только в paywall.js`);
  }
  assert.ok(read('src/handlers/analytics.js').includes('showPaywall(bot, chatId, userId)'));
});

test('свои категории показываются модели и на free, чтобы запись получила пояснение', () => {
  const m = read('src/handlers/message.js');
  assert.ok(!m.includes('customCategoriesAllowed'));
  assert.match(m, /if \(userId\) \{\s*const \{ data \} = await supabase\s*\.from\('categories'\)/);
});

test('кабинет: на free страница бюджета открывается, карточка закрыта размытием, как на дашборде; окно тарифов по ссылке из целей', () => {
  const budget = read('public/cabinet/budget.html');
  assert.ok(!budget.includes("window.location.replace('/cabinet/dashboard')"), 'без подписки больше не перебрасываем на дашборд');
  assert.ok(budget.includes('var hasAccess = subStatus') && budget.includes('renderLockedCard()'));
  assert.ok(budget.includes('Разблокируй функционал в подписке') && budget.includes('backdrop-filter: blur(3px)') && budget.includes('rgba(0,0,0,0.40)'));
  assert.ok(budget.includes("'<h2 class=\"section-subtitle\">История</h2>' +"), 'таблица «История» остаётся');
  const layout = read('public/cabinet/layout.js');
  assert.ok(!layout.includes('lockSubscriptionPages'), 'пункт меню «Мой бюджет» не блокируем');
  const goals = read('public/cabinet/goals.html');
  assert.ok(goals.includes('href="/cabinet/profile?plans=1"') && !goals.includes('openBotWidget();">Оплатить подписку'));
  const profile = read('public/cabinet/profile.html');
  assert.ok(profile.includes("qs.get('plans')") && profile.includes('__plansModalName') && profile.includes("'modalSubscribe'"));
});
