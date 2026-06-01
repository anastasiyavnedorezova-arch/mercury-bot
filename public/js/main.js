document.addEventListener('DOMContentLoaded', () => {

  // ---- Бургер + мобильное меню ----
  const burger   = document.getElementById('burger');
  const menu     = document.getElementById('mobileMenu');
  const overlay  = document.getElementById('menuOverlay');

  function openMenu() {
    burger.classList.add('is-open');
    menu.classList.add('is-open');
    overlay.classList.add('is-open');
    burger.setAttribute('aria-expanded', 'true');
    menu.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  function closeMenu() {
    burger.classList.remove('is-open');
    menu.classList.remove('is-open');
    overlay.classList.remove('is-open');
    burger.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  if (burger && menu) {
    burger.addEventListener('click', () => {
      burger.classList.contains('is-open') ? closeMenu() : openMenu();
    });

    // Закрыть по клику на оверлей
    overlay?.addEventListener('click', closeMenu);

    // Закрыть по клику на ссылку меню
    menu.querySelectorAll('a').forEach(a => a.addEventListener('click', closeMenu));

    // Закрыть по Escape
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeMenu();
    });
  }

  // ---- Плавный скролл с отступом под header ----
  document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener('click', e => {
      const id = link.getAttribute('href');
      const target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      const headerH = document.getElementById('header')?.offsetHeight || 0;
      const top = target.getBoundingClientRect().top + window.scrollY - headerH - 8;
      window.scrollTo({ top, behavior: 'smooth' });
    });
  });

  // ---- FAQ: табы + аккордеон ----
  initFaq();

  // ---- Модал: выбор тарифа ----
  initPricingModal();

});

function initFaq() {
  const tabs   = document.querySelectorAll('.faq__tab');
  const groups = document.querySelectorAll('.faq__group');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach(t => { t.classList.remove('faq__tab--active'); t.setAttribute('aria-selected', 'false'); });
      tab.classList.add('faq__tab--active');
      tab.setAttribute('aria-selected', 'true');
      groups.forEach(g => {
        if (g.dataset.group === target) {
          g.classList.remove('faq__group--hidden');
        } else {
          g.classList.add('faq__group--hidden');
          g.querySelectorAll('.faq__q[aria-expanded="true"]').forEach(q => closeItem(q));
        }
      });
    });
  });

  document.querySelectorAll('.faq__q').forEach(btn => {
    btn.addEventListener('click', () => {
      const isOpen = btn.getAttribute('aria-expanded') === 'true';
      btn.closest('.faq__group').querySelectorAll('.faq__q[aria-expanded="true"]').forEach(q => {
        if (q !== btn) closeItem(q);
      });
      isOpen ? closeItem(btn) : openItem(btn);
    });
  });
}

function openItem(btn) {
  btn.setAttribute('aria-expanded', 'true');
  btn.nextElementSibling.removeAttribute('hidden');
}

function closeItem(btn) {
  const answer = btn.nextElementSibling;
  btn.setAttribute('aria-expanded', 'false');
  answer.style.maxHeight = '0';
  answer.style.opacity = '0';
  setTimeout(() => {
    answer.setAttribute('hidden', '');
    answer.style.maxHeight = '';
    answer.style.opacity = '';
  }, 280);
}


function initPricingModal() {
  const modal   = document.getElementById('pricingModal');
  const openBtn = document.getElementById('openPricingModal');
  const closeBtn = document.getElementById('modalClose');
  if (!modal || !openBtn) return;

  function openModal() {
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    closeBtn?.focus();
  }

  function closeModal() {
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    openBtn.focus();
  }

  // Все триггеры открытия модала
  [openBtn,
   document.getElementById('openPricingModalNav'),
   document.getElementById('openPricingModalMob')
  ].forEach(btn => btn?.addEventListener('click', () => {
    openModal();
    // Закрываем мобильное меню если открыто
    document.getElementById('mobileMenu')?.classList.remove('is-open');
    document.getElementById('menuOverlay')?.classList.remove('is-open');
    document.getElementById('burger')?.classList.remove('is-open');
    document.body.style.overflow = 'hidden';
  }));
  closeBtn?.addEventListener('click', closeModal);

  // Клик по оверлею (вне карточки)
  modal.addEventListener('click', e => {
    if (e.target === modal) closeModal();
  });

  // Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.classList.contains('is-open')) closeModal();
  });
}
