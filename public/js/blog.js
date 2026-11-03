(function () {
  // Бургер и мобильное меню — как на главной
  var burger = document.getElementById('burger');
  var menu = document.getElementById('mobileMenu');
  var overlay = document.getElementById('menuOverlay');
  function setMenu(open) {
    burger.classList.toggle('is-open', open);
    menu.classList.toggle('is-open', open);
    overlay.classList.toggle('is-open', open);
    burger.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-hidden', String(!open));
  }
  burger.addEventListener('click', function () { setMenu(!burger.classList.contains('is-open')); });
  overlay.addEventListener('click', function () { setMenu(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setMenu(false); });


  // Оглавление: подсветка текущего раздела
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  var ids = links.map(function (a) { return a.getAttribute('href').slice(1); });
  var sections = ids.map(function (id) { return document.getElementById(id); }).filter(Boolean);
  function activate(id) {
    links.forEach(function (a) { a.classList.toggle('is-active', a.getAttribute('href') === '#' + id); });
  }
  function onScroll() {
    var current = sections[0] ? sections[0].id : null;
    sections.forEach(function (s) { if (s.getBoundingClientRect().top <= 160) current = s.id; });
    if (current) activate(current);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Мобильное оглавление закрывается после выбора раздела
  document.querySelectorAll('.toc-m a').forEach(function (a) {
    a.addEventListener('click', function () { document.querySelector('.toc-m').open = false; });
  });
})();
