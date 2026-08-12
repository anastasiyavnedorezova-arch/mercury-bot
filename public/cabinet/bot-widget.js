import { getToken, authHeaders } from './layout.js';

let widgetMounted = false;
let widgetPolling = false;
let widgetInitialized = false;

const WIDGET_STYLES = `
.bot-widget-overlay { display:none; position:fixed; inset:0; z-index:9999; }
.bot-widget-overlay.is-open { display:flex; }
.bot-widget-backdrop { position:absolute; inset:0; background:rgba(0,0,0,0.4); }
.bot-widget-page{position:relative;flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;background:#F5F7FA;width:100%;height:100%;height:100dvh;}
.bot-widget-chat-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 20px;border-bottom:1px solid #E2E8F0;background:#fff;flex-shrink:0}
.bot-widget-chat-header__info{display:flex;align-items:center;gap:12px;min-width:0}
.bot-widget-close-btn{width:36px;height:36px;border-radius:50%;background:transparent;border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:background 150ms}
.bot-widget-close-btn:hover{background:#F3F4F6}
.bot-widget-avatar{width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0}
.bot-widget-name{font-size:16px;font-weight:600;color:#2D3748}
.bot-widget-status{font-size:12px;font-weight:500;color:#22C55E}
.bot-widget-chat-area{flex:1;overflow-y:auto;overflow-x:hidden;padding:16px;display:flex;flex-direction:column;gap:0;scroll-behavior:smooth;background:#F5F7FA}
.bot-widget-chat-area::-webkit-scrollbar{width:4px}
.bot-widget-chat-area::-webkit-scrollbar-thumb{background:#E2E8F0;border-radius:4px}
.bot-widget-bubble-wrap{display:flex;flex-direction:column;margin-bottom:10px}
.bot-widget-bubble-wrap.from-bot{align-items:flex-start}
.bot-widget-bubble-wrap.from-user{align-items:flex-end}
.bot-widget-bubble{position:relative;padding:8px 14px;border-radius:18px;font-size:14px;font-weight:400;line-height:20px;max-width:85%;word-break:break-word;white-space:pre-wrap}
.bot-widget-bubble.bot{background:#EEF2F6;color:#2D3748;border-bottom-left-radius:4px}
.bot-widget-bubble.user{background:#4C9AFF;color:#fff;border-bottom-right-radius:4px}
.bot-widget-bubble.bot::before{content:'';position:absolute;left:-8px;bottom:6px;width:0;height:0;border-top:10px solid transparent;border-right:10px solid #EEF2F6;border-bottom:0 solid transparent}
.bot-widget-bubble.user::before{content:'';position:absolute;right:-8px;bottom:6px;width:0;height:0;border-top:10px solid transparent;border-left:10px solid #4C9AFF;border-bottom:0 solid transparent}
.bot-widget-cta-wrap{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;padding-left:0}
.bot-widget-cta-btn{height:40px;padding:10px 16px;background:#fff;border:1px solid #E2E8F0;border-radius:10px;font-family:'Manrope',sans-serif;font-size:14px;font-weight:600;line-height:20px;color:#2D3748;cursor:pointer;white-space:nowrap;transition:background 150ms,border-color 150ms}
.bot-widget-cta-btn:hover{background:#EEF2F6;border-color:#CBD5E1}
.bot-widget-cta-btn:active{transform:scale(.98)}
.bot-widget-input-bar{display:flex;align-items:center;gap:10px;padding:12px 16px;flex-shrink:0;border-top:1px solid #E2E8F0;background:#fff}
.bot-widget-chat-input{flex:1;padding:10px 14px;background:#fff;border:1px solid #CBD5E1;border-radius:12px;font-family:'Manrope',sans-serif;font-size:16px;font-weight:400;line-height:24px;color:#2D3748;outline:none;transition:border-color 200ms,box-shadow 200ms;resize:none}
.bot-widget-chat-input::placeholder{color:#9CA3AF}
.bot-widget-chat-input:focus{border-color:#4C9AFF;box-shadow:0 0 0 3px rgba(76,154,255,.15)}
.bot-widget-send-btn{width:44px;height:44px;border-radius:50%;background:#4C9AFF;display:flex;align-items:center;justify-content:center;border:none;cursor:pointer;flex-shrink:0;transition:background 150ms}
.bot-widget-send-btn:hover{background:#3B82F6}
.bot-widget-send-btn svg{display:block}
.bot-widget-icon-btn{width:44px;height:44px;border-radius:50%;background:#EAF2FF;border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;transition:background 150ms}
.bot-widget-icon-btn:hover{background:#D8E8FF}
.bot-widget-icon-btn img{display:block;width:24px;height:24px}
.bot-widget-typing-wrap{display:flex;flex-direction:column;align-items:flex-start;margin-bottom:10px}
.bot-widget-typing-indicator{display:flex;align-items:center;gap:4px;padding:10px 14px;background:#EEF2F6;border-radius:18px;border-bottom-left-radius:4px;width:fit-content}
.bot-widget-typing-dot{width:7px;height:7px;border-radius:50%;background:#6B7280;animation:botWidgetBlink 1.2s ease-in-out infinite}
.bot-widget-typing-dot:nth-child(2){animation-delay:.2s}
.bot-widget-typing-dot:nth-child(3){animation-delay:.4s}
@keyframes botWidgetBlink{0%,80%,100%{opacity:.25}40%{opacity:1}}
@media (max-width: 768px){
  .bot-widget-chat-input{font-size:16px}
  .bot-widget-page{width:100%!important;height:100%!important;height:100dvh!important;border-radius:0!important;}
  .bot-widget-backdrop{display:none;}
}
@media (min-width: 901px) {
  .bot-widget-overlay.is-open { align-items:center; justify-content:flex-end; padding:40px 40px 40px 0; }
  .bot-widget-page {
    width: 530px; max-width: 530px;
    height: calc(100vh - 80px); height: calc(100dvh - 80px);
    border-radius: 20px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.25);
    overflow: hidden;
  }
  .bot-widget-chat-header { border-radius: 20px 20px 0 0; }
}
`;

const WIDGET_HTML = `
  <div class="bot-widget-backdrop" id="botWidgetBackdrop"></div>
  <main class="bot-widget-page">
    <div class="bot-widget-chat-header">
      <div class="bot-widget-chat-header__info">
        <img src="/images/bot-face.svg" class="bot-widget-avatar" alt="Mercury Bot"/>
        <div>
          <div class="bot-widget-name">Меркури</div>
          <div class="bot-widget-status">онлайн</div>
        </div>
      </div>
      <button class="bot-widget-close-btn" id="botWidgetCloseBtn" aria-label="Закрыть чат">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6L18 18" stroke="#4B5563" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="bot-widget-chat-area" id="botWidgetChatArea"></div>
    <div class="bot-widget-input-bar">
      <button class="bot-widget-icon-btn" id="botWidgetMenuBtn" aria-label="Главное меню">
        <img src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNNCA2SDIwTTQgMTJIMjBNNCAxOEgyMCIgc3Ryb2tlPSIjNEM5QUZGIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPjwvc3ZnPg==" width="24" height="24" alt=""/>
      </button>
      <input class="bot-widget-chat-input" id="botWidgetChatInput" type="text" placeholder="Написать сообщение..." autocomplete="off"/>
      <button class="bot-widget-send-btn" id="botWidgetSendBtn" aria-label="Отправить">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M5 12H19M19 12L13 6M19 12L13 18" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
  </main>
`;

function removeTyping() {
  document.querySelectorAll('.bot-widget-typing-wrap').forEach(el => el.remove());
}

function renderMessages(messages) {
  removeTyping();
  const area = document.getElementById('botWidgetChatArea');
  for (const msg of messages) {
    if (msg.type !== 'message' && msg.type !== 'edit') continue;
    const text = msg.text || '';
    const keyboard = msg.opts?.reply_markup?.inline_keyboard || [];

    const wrap = document.createElement('div');
    wrap.className = 'bot-widget-bubble-wrap from-bot';
    const bubble = document.createElement('div');
    bubble.className = 'bot-widget-bubble bot';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    area.appendChild(wrap);

    if (keyboard.length > 0) {
      const ctaWrap = document.createElement('div');
      ctaWrap.className = 'bot-widget-cta-wrap';
      for (const row of keyboard) {
        for (const btn of row) {
          const b = document.createElement('button');
          b.className = 'bot-widget-cta-btn bot-widget-inline-btn';
          b.textContent = btn.text;
          b.callback_data = btn.callback_data || '';
          b.onclick = () => handleInlineButton(b);
          ctaWrap.appendChild(b);
        }
      }
      area.appendChild(ctaWrap);
    }
  }
  area.scrollTop = area.scrollHeight;
}

async function initChat() {
  try {
    const res = await fetch('/api/bot/init', { method: 'POST', headers: authHeaders() });
    if (res.status === 401) {
      window.location.href = '/cabinet/login?redirect=' + encodeURIComponent(window.location.pathname);
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    if (data.ok && data.messages) {
      renderMessages(data.messages);
    }
    startPolling();
  } catch(e) {
    console.error('[bot-widget] initChat error:', e);
  }
}

function startPolling() {
  if (widgetPolling) return;
  widgetPolling = true;
  pollLoop();
}

async function pollLoop() {
  while (widgetPolling) {
    try {
      const res = await fetch('/api/bot/poll', { headers: authHeaders() });
      if (res.status === 401) {
        window.location.href = '/cabinet/login?redirect=' + encodeURIComponent(window.location.pathname);
        return;
      }
      if (!res.ok) throw new Error('poll failed: ' + res.status);
      const data = await res.json();
      if (data.messages?.length) {
        renderMessages(data.messages);
      }
    } catch(e) {
      console.warn('[bot-widget] poll retry after error:', e.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function sendMessage() {
  const input = document.getElementById('botWidgetChatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  const area = document.getElementById('botWidgetChatArea');

  const wrap = document.createElement('div');
  wrap.className = 'bot-widget-bubble-wrap from-user';
  const bubble = document.createElement('div');
  bubble.className = 'bot-widget-bubble user';
  bubble.textContent = text;
  wrap.appendChild(bubble);
  area.appendChild(wrap);

  const typingId = 'botWidgetTyping-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const typingWrap = document.createElement('div');
  typingWrap.className = 'bot-widget-typing-wrap';
  typingWrap.id = typingId;
  typingWrap.innerHTML = '<div class="bot-widget-typing-indicator"><div class="bot-widget-typing-dot"></div><div class="bot-widget-typing-dot"></div><div class="bot-widget-typing-dot"></div></div>';
  area.appendChild(typingWrap);
  area.scrollTop = area.scrollHeight;

  try {
    const res = await fetch('/api/bot/send', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ text }),
    });
    if (res.status === 401) {
      removeTyping();
      window.location.href = '/cabinet/login?redirect=' + encodeURIComponent(window.location.pathname);
      return;
    }
  } catch(e) {
    console.error('[bot-widget] sendMessage error:', e);
    removeTyping();
  }
}

async function handleInlineButton(btn) {
  document.querySelectorAll('.bot-widget-inline-btn').forEach(b => { b.disabled = true; });

  const area = document.getElementById('botWidgetChatArea');

  const ctaWrap = btn.closest('.bot-widget-cta-wrap');
  if (ctaWrap) ctaWrap.remove();

  const uWrap = document.createElement('div');
  uWrap.className = 'bot-widget-bubble-wrap from-user';
  const uBubble = document.createElement('div');
  uBubble.className = 'bot-widget-bubble user';
  uBubble.textContent = btn.textContent;
  uWrap.appendChild(uBubble);
  area.appendChild(uWrap);

  const typingId = 'botWidgetTyping-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const typingWrap = document.createElement('div');
  typingWrap.className = 'bot-widget-typing-wrap';
  typingWrap.id = typingId;
  typingWrap.innerHTML = '<div class="bot-widget-typing-indicator"><div class="bot-widget-typing-dot"></div><div class="bot-widget-typing-dot"></div><div class="bot-widget-typing-dot"></div></div>';
  area.appendChild(typingWrap);
  area.scrollTop = area.scrollHeight;

  try {
    const res = await fetch('/api/bot/callback', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ callback_data: btn.callback_data }),
    });
    if (res.status === 401) {
      window.location.href = '/cabinet/login?redirect=' + encodeURIComponent(window.location.pathname);
      return;
    }
    const data = await res.json();
    if (data.messages?.length) {
      renderMessages(data.messages);
    } else {
      removeTyping();
    }
  } catch(e) {
    console.error('[bot-widget] callback error:', e);
    removeTyping();
  }
}

function mountWidget() {
  if (widgetMounted) return;
  widgetMounted = true;

  const styleTag = document.createElement('style');
  styleTag.id = 'bot-widget-styles';
  styleTag.textContent = WIDGET_STYLES;
  document.head.appendChild(styleTag);

  const overlay = document.createElement('div');
  overlay.className = 'bot-widget-overlay';
  overlay.id = 'botWidgetOverlay';
  overlay.innerHTML = WIDGET_HTML;
  document.body.appendChild(overlay);

  document.getElementById('botWidgetSendBtn').addEventListener('click', sendMessage);
  document.getElementById('botWidgetChatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  document.getElementById('botWidgetCloseBtn').addEventListener('click', closeBotWidget);
  document.getElementById('botWidgetBackdrop').addEventListener('click', closeBotWidget);
  document.getElementById('botWidgetMenuBtn').addEventListener('click', () => {
    const fakeBtn = document.createElement('button');
    fakeBtn.textContent = '☰ Главное меню';
    fakeBtn.callback_data = 'menu:main';
    handleInlineButton(fakeBtn);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const overlayEl = document.getElementById('botWidgetOverlay');
      if (overlayEl && overlayEl.classList.contains('is-open')) closeBotWidget();
    }
  });
}

export function openBotWidget() {
  if (!getToken()) {
    window.location.href = '/cabinet/login?redirect=' + encodeURIComponent(window.location.pathname);
    return;
  }
  mountWidget();
  document.getElementById('botWidgetOverlay').classList.add('is-open');
  document.body.style.overflow = 'hidden';
  if (!widgetInitialized) {
    widgetInitialized = true;
    initChat();
  }
}

export function closeBotWidget() {
  const overlay = document.getElementById('botWidgetOverlay');
  if (overlay) overlay.classList.remove('is-open');
  document.body.style.overflow = '';
}

export function initBotWidgetTrigger() {
  document.querySelectorAll('[data-bot-widget-trigger]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      openBotWidget();
    });
  });
  window.openBotWidget = openBotWidget;
  window.closeBotWidget = closeBotWidget;
}
