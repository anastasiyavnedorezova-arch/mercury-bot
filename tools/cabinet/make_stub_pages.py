#!/usr/bin/env python3
"""Генерирует страницы-заглушки кабинета (analytics, family) на базе feedback.html
и подключает «Семейный доступ» в меню всех страниц кабинета.
Запуск из корня репозитория: python3 tools/cabinet/make_stub_pages.py"""
import re, pathlib

CAB = pathlib.Path('public/cabinet')
PAGES = {
    'analytics': dict(title='Аналитика', head='Ведутся технические работы',
                      text='Обещаем, скоро починим'),
    'family': dict(title='Семейный бюджет', head='Раздел в работе',
                   text='Скоро будет доступным!'),
}
CSS = """
        .stub-card { background: #fff; border: 1px solid #E2E8F0; border-radius: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); padding: 40px 24px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px; max-width: 640px; width: 100%; }
        .stub-card__img { width: 100%; max-width: 360px; height: auto; display: block; }
        .stub-card__title { font-size: 24px; font-weight: 700; line-height: 32px; color: #2D3748; margin-top: 8px; }
        .stub-card__text { font-size: 16px; font-weight: 500; line-height: 24px; color: #6B7280; }
        .nav-item.is-active .nav-item__name { color: #4C9AFF; font-weight: 600; }
        @media (max-width: 768px) { .stub-card { padding: 28px 16px; border-radius: 20px; } .stub-card__title { font-size: 20px; line-height: 28px; } .stub-card__img { max-width: 260px; } }
"""

def family_link(s):
    # «Семейный доступ» из «Скоро!» -> кликабельная ссылка на заглушку (подпись «Скоро!» остаётся)
    return re.sub(r'<a href="#"(\s+)class="nav-item is-dis-soon">',
                  lambda m: f'<a href="/cabinet/family"{m.group(1)}class="nav-item">', s)

# 1. меню на всех страницах кабинета
for name in ['dashboard','accounting','history','categories','goals','budget','how-to','faq','feedback','profile']:
    p = CAB / f'{name}.html'
    s = p.read_text(encoding='utf-8')
    new = family_link(s)
    p.write_text(new, encoding='utf-8')

# 2. страницы-заглушки
base = (CAB / 'feedback.html').read_text(encoding='utf-8')
for key, cfg in PAGES.items():
    s = base
    s = re.sub(r'<title>.*?</title>', f"<title>Финник — {cfg['title']}</title>", s, count=1)
    a = s.index('<main class="page-content">'); b = s.index('</main>') + len('</main>')
    main = f'''<main class="page-content">
    <h1 class="page-title">{cfg['title']}</h1>
    <div class="stub-card">
      <img class="stub-card__img" src="/images/finnik-works.webp" alt="Финник в каске" width="900" height="748"/>
      <div class="stub-card__title">{cfg['head']}</div>
      <div class="stub-card__text">{cfg['text']}</div>
    </div>
  </main>'''
    s = s[:a] + main + s[b:]
    a = s.index('<script type="module">'); b = s.rindex('</script>') + len('</script>')
    script = f'''<script type="module">
  import {{ initLayout, loadUser, initLogoutModal }} from './layout.js';
  import {{ initBotWidgetTrigger }} from './bot-widget.js';
  document.addEventListener('DOMContentLoaded', function() {{
    initLayout('{key}');
    initLogoutModal();
    initBotWidgetTrigger();
    loadUser();
  }});
</script>'''
    s = s[:a] + script + s[b:]
    s = s.replace('</style>', CSS + '    </style>', 1)
    # в меню текущая страница подсвечивается через initLayout; в feedback «Обратная связь» была активна в HTML
    s = s.replace('class="nav-text-link is-active"', 'class="nav-text-link"')
    (CAB / f'{key}.html').write_text(s, encoding='utf-8')
print('ok')
