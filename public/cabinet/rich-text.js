// Текст бота в виджете и в веб-чате: ссылки, почты и простое оформление без innerHTML.
// Бот пишет для Telegram: ссылки вида [текст](https://…), теги <b>…</b> при parse_mode=HTML.
// Telegram их разбирает сам, а виджет показывал как есть — по ссылке на оплату нельзя было нажать.
// Разбираем текст в список кусочков (parseRichText) и собираем из них DOM (appendRichText).
// Ссылки — только http/https и mailto, всё остальное остаётся обычным текстом.

const TOKEN = new RegExp([
  '\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)',                         // 1,2: [текст](url)
  '<a\\s+href="(https?:\\/\\/[^"\\s]+)">([^<]*)<\\/a>',                      // 3,4: <a href="url">текст</a>
  '<(b|strong)>([^<]*)<\\/(?:b|strong)>',                                   // 5,6: <b>текст</b>
  '<(i|em)>([^<]*)<\\/(?:i|em)>',                                              // 7,8: <i>текст</i>
  '<code>([^<]*)<\\/code>',                                                   // 9: <code>текст</code>
  '(https?:\\/\\/[^\\s<>"]+)',                                                // 10: голая ссылка
  '([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,})',    // 11: почта
].join('|'), 'g');

const TRAILING = /[.,;:!?)\]»'"]+$/;

// \_ \* \[ … — экранирование из Markdown; &lt; &gt; &amp; — из HTML-режима
function unescapeText(s) {
  return s
    .replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

export function parseRichText(input) {
  const text = String(input ?? '');
  const out = [];
  const pushText = (t) => { if (t) out.push({ type: 'text', text: unescapeText(t) }); };
  let last = 0;
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text)) !== null) {
    pushText(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) out.push({ type: 'link', text: unescapeText(m[1]), href: m[2] });
    else if (m[3] !== undefined) out.push({ type: 'link', text: unescapeText(m[4]), href: m[3] });
    else if (m[5] !== undefined) out.push({ type: 'b', text: unescapeText(m[6]) });
    else if (m[7] !== undefined) out.push({ type: 'i', text: unescapeText(m[8]) });
    else if (m[9] !== undefined) out.push({ type: 'code', text: unescapeText(m[9]) });
    else if (m[10] !== undefined) {
      // знаки препинания в конце («…оплаты.») к ссылке не относятся
      const tail = (m[10].match(TRAILING) || [''])[0];
      const url = m[10].slice(0, m[10].length - tail.length);
      out.push({ type: 'link', text: url, href: url });
      last -= tail.length;
    } else if (m[11] !== undefined) out.push({ type: 'link', text: m[11], href: `mailto:${m[11]}` });
  }
  pushText(text.slice(last));
  return out;
}

export function appendRichText(el, input, doc = el.ownerDocument) {
  for (const t of parseRichText(input)) {
    if (t.type === 'text') { el.appendChild(doc.createTextNode(t.text)); continue; }
    const node = doc.createElement(t.type === 'link' ? 'a' : t.type === 'b' ? 'strong' : t.type === 'i' ? 'em' : 'code');
    node.textContent = t.text;
    if (t.type === 'link') {
      node.setAttribute('href', t.href);
      if (!t.href.startsWith('mailto:')) { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
    }
    el.appendChild(node);
  }
}
