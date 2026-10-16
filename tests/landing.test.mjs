// Лендинг (патч 5): порядок блоков, кнопки, тарифы, модалка, «ты», картинки.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync('public/index.html', 'utf8');
const css = fs.readFileSync('public/css/hero.css', 'utf8');

const idx = (needle) => {
  const i = html.indexOf(needle);
  assert.ok(i >= 0, `нет на странице: ${needle}`);
  return i;
};

// видимый текст: без скриптов, JSON-LD, комментариев и тегов
function visibleText(src) {
  return src
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ');
}

test('порядок блоков: hero → преимущества → как работает → … → доверие → FAQ', () => {
  const order = ['id="hero"', 'id="features"', 'id="how"', 'id="start"', 'id="forwhom"', 'id="pricing"', 'id="subscription"', 'id="trust"', 'id="faq"'];
  const pos = order.map(idx);
  assert.deepEqual([...pos].sort((a, b) => a - b), pos);
});

test('hero: янтарная кнопка F59E0B; кнопка в тарифах тёмная 1E2A38', () => {
  assert.match(html, /<button class="btn btn--amber js-open-channel-modal"[^>]*>Попробовать бесплатно<\/button>/);
  assert.match(css, /\.btn--amber\s*\{[^}]*background:\s*#F59E0B/i);
  const free = html.slice(idx('Бесплатный тариф'), idx('Подписка на 1, 6 или 12 месяцев'));
  assert.match(free, /class="btn btn--dark btn--full js-open-channel-modal"/);
  assert.match(css, /\.btn--dark\s*\{[^}]*background:\s*var\(--dark\)/);
  const vars = fs.readFileSync('public/css/variables.css', 'utf8');
  assert.match(vars, /--c-dark:\s*#1E2A38/i);
});

test('преимущества: новый заголовок и описание цели с инфляцией', () => {
  const f = html.slice(idx('id="features"'), idx('id="how"'));
  assert.match(f, /Не просто трекер расходов, а полноценный финансовый помощник:/);
  assert.ok(!f.includes('в одном чат-боте'));
  assert.match(f, /сколько откладывать каждый месяц с учетом инфляции/);
  assert.match(f, /Голос пока доступен в Telegram, скоро появится и в виджете на сайте/);
});

test('«для кого»: заголовок с названием сервиса, alt картинки без старого имени', () => {
  assert.match(html, /<h2 class="forwhom__title">\s*Сервис Финник · Деньги подойдет тем, кто <span class="forwhom__title-blue">хочет навести порядок в личных финансах<\/span>/);
  assert.ok(!html.includes('Меркури'));
});

test('тарифы: жирная строка, собственные категории первыми, сноска про Telegram', () => {
  assert.match(html, /<strong class="pricing__card-plus">Все, что в бесплатном тарифе плюс:<\/strong>/);
  assert.match(css, /\.pricing__card-plus\s*\{[^}]*font-weight:\s*700/);
  const sub = html.slice(idx('Подписка на 1, 6 или 12 месяцев'), idx('id="openPricingModal"'));
  const cats = sub.indexOf('Создание собственных категорий');
  const media = sub.indexOf('Распознавание фото и банковских выписок*');
  assert.ok(cats > 0 && media > cats, 'категории должны идти перед распознаванием фото');
  assert.ok(!sub.includes('аудио сообщений'), 'голос бесплатный — в подписке его не указываем');
  assert.match(html, /Запись доходов и расходов текстом и голосом\*/);
  assert.match(html, /<p class="pricing__note">\* Голос и распознавание фото пока работают только в Telegram, скоро появятся и в виджете на сайте<\/p>/);
});

test('модалка тарифов: все карточки одинаково белые, наведение — фон и кнопка меняются', () => {
  const modal = html.slice(idx('id="pricingModal"'), idx('id="channelModal"'));
  assert.equal((modal.match(/class="modal-plan2"/g) || []).length, 3);
  assert.ok(!modal.includes('modal-plan2--highlight'));
  assert.ok(!modal.includes('modal-plan2__btn--accent'));
  assert.ok(!css.includes('.modal-plan2--highlight'));
  assert.match(css, /\.modal-plan2\s*\{[^}]*background:\s*#fff/);
  assert.match(css, /@media \(hover: hover\)\s*\{\s*\.modal-plan2:hover\s*\{\s*background:\s*#F5F7FA;\s*border-color:\s*#CBD5E1;\s*\}\s*\.modal-plan2:hover \.modal-plan2__btn\s*\{\s*background:\s*#4C9AFF;/);
});

test('блок доверия: новый заголовок по центру, без подзаголовка, картинка и карточка на одном уровне', () => {
  const t = html.slice(idx('id="trust"'), idx('id="faq"'));
  assert.match(t, /<h2 class="trust__title">Финник · Деньги&nbsp;— это шаг к твоему спокойствию в&nbsp;личных финансах<\/h2>/);
  assert.ok(!t.includes('trust__desc'));
  assert.ok(!t.includes('Понятный и аккуратный подход'));
  assert.ok(t.indexOf('trust__title') < t.indexOf('trust__inner'), 'заголовок над картинкой и карточкой');
  assert.match(css, /\.trust__title\s*\{[^}]*text-align:\s*center/);
  assert.match(css, /\.trust__inner\s*\{[^}]*align-items:\s*center/);
  assert.ok(!css.includes('.trust__desc'));
});

test('лендинг в обращении «ты»: нет «вы/ваш» и повелительных на «-йте/-ите»', () => {
  const text = visibleText(html);
  const vy = text.match(/(^|[^А-Яа-яЁё])(вы|вас|вам|вами|ваш[а-яё]*)(?![А-Яа-яЁё])/gi) || [];
  // «вы сравниваете» в ответе про семейный бюджет — множественное число про семью, допустимо
  const bad = vy;
  const allowed = (text.match(/вы сравниваете/g) || []).length;
  assert.ok(bad.length <= allowed, `найдено «вы…»: ${bad.join('|')}`);
  const imp = text.match(/(^|[^А-Яа-яЁё])[А-Яа-яЁё]+(йте|ите|итесь|йтесь)(?![А-Яа-яЁё])/g) || [];
  const impBad = imp.filter((m) => !/сайте$/.test(m)); // «на сайте» — существительное
  assert.deepEqual(impBad, [], `повелительные на «вы»: ${impBad.join('|')}`);
  assert.ok(!/Телеграмм/.test(text));
});

test('картинки лендинга: PNG нужных пропорций, лежат на месте', () => {
  const expect = {
    'image-hero.png': [1380, 1170], 'image-2.png': [1069, 907], 'image-3.png': [1069, 907], 'image-4.png': [1069, 907],
    'image-5.png': [1069, 907], 'image-6.png': [1074, 912], 'image-trial.png': [1848, 1216], 'image-trust.png': [1074, 912],
  };
  for (const [name, [w, h]] of Object.entries(expect)) {
    const buf = fs.readFileSync(`public/images/${name}`);
    assert.equal(buf.subarray(1, 4).toString(), 'PNG', name);
    assert.equal(buf.readUInt32BE(16), w, `${name} ширина`);
    assert.equal(buf.readUInt32BE(20), h, `${name} высота`);
    assert.ok(html.includes(`images/${name}`), `${name} не подключена`);
  }
});

test('FAQ: два ответа от владелицы продукта', () => {
  assert.match(html, /Достаточно зарегистрировать аккаунт на сайте\. Так ты получишь доступ к Личному Кабинету, где и живет Финник\. Быстрый доступ к чату с ботом можно установить на экран телефона по инструкции в личном кабинете\./);
  assert.match(html, /Раздел сейчас в разработке\. Подпишись при регистрации на рассылку, чтобы не пропустить, когда функция «Семейный бюджет» будет доступна\./);
  assert.ok(!html.includes('Подпишитесь'));
});

test('редактирование записей: текст на сайте совпадает с правилами бота (в боте — только подписка)', () => {
  const free = html.slice(idx('Бесплатный тариф'), idx('Подписка на 1, 6 или 12 месяцев'));
  const sub = html.slice(idx('Подписка на 1, 6 или 12 месяцев'), idx('id="openPricingModal"'));
  assert.ok(!free.includes('Редактирование и удаление записей'));
  assert.match(free, /Удаление записей<br>✔️ Редактирование записей в личном кабинете/);
  assert.match(sub, /Редактирование записей в чате с ботом/);
  assert.match(html, /Удалять записи можно на любом тарифе\. Редактировать записи в личном кабинете можно на любом тарифе, а в чате с ботом — в подписке и в пробном периоде\./);
  // правило бота, на которое опирается текст
  const tx = fs.readFileSync('src/handlers/transaction.js', 'utf8');
  assert.match(tx, /Редактирование доступно в подписке/);
});

test('превью для соцсетей: og:image 1200×630 и twitter:card', () => {
  assert.match(html, /<meta property="og:image" content="https:\/\/finnikbot\.ru\/images\/image-social\.png" \/>/);
  assert.match(html, /<meta property="og:image:width" content="1200" \/>/);
  assert.match(html, /<meta property="og:image:height" content="630" \/>/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
  const buf = fs.readFileSync('public/images/image-social.png');
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
  assert.equal(buf.readUInt32BE(16), 1200);
  assert.equal(buf.readUInt32BE(20), 630);
});
