// Кнопка «глаз» у всех полей пароля: показать / скрыть введённый пароль.
// Подключается одной строкой <script src="/js/pw-toggle.js" defer></script> на страницах входа, регистрации и смены пароля.
(function () {
  var css =
    '.pw-wrap{position:relative;display:block;width:100%}' +
    '.pw-wrap>input{padding-right:48px!important}' +
    '.pw-toggle{position:absolute;top:0;right:0;height:100%;width:44px;display:flex;align-items:center;justify-content:center;' +
    'background:none;border:0;padding:0;cursor:pointer;color:#6B7280;border-radius:0 12px 12px 0}' +
    '.pw-toggle:hover{color:#2D3748}' +
    '.pw-toggle:focus-visible{outline:2px solid #4C9AFF;outline-offset:-2px}' +
    '.pw-toggle svg{width:20px;height:20px;display:block}' +
    '.pw-toggle .pw-eye-off{display:none}' +
    '.pw-toggle.is-shown .pw-eye{display:none}' +
    '.pw-toggle.is-shown .pw-eye-off{display:block}';

  var EYE =
    '<svg class="pw-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>' +
    '<svg class="pw-eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a17.5 17.5 0 0 1-3.2 4.2M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7c1.7 0 3.2-.4 4.5-1"/>' +
    '<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

  function init() {
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    document.querySelectorAll('input[type="password"]').forEach(function (input) {
      if (input.parentElement && input.parentElement.classList.contains('pw-wrap')) return;
      var wrap = document.createElement('div');
      wrap.className = 'pw-wrap';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pw-toggle';
      btn.setAttribute('aria-label', 'Показать пароль');
      btn.setAttribute('aria-pressed', 'false');
      btn.innerHTML = EYE;
      btn.addEventListener('click', function () {
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.classList.toggle('is-shown', show);
        btn.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
        btn.setAttribute('aria-pressed', show ? 'true' : 'false');
        input.focus();
      });
      wrap.appendChild(btn);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
