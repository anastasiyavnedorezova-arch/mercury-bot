// ── Shared layout module for all cabinet pages ────────────────────────────

const IC = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggb3BhY2l0eT0iMC41IiBkPSJNMTcuNzUgMTlDMTcuNzUgMTkuMzEzOSAxNy41NTQ2IDE5LjU5NDYgMTcuMjYwMiAxOS43MDM1QzE2Ljk2NTggMTkuODEyMyAxNi42MzQ4IDE5LjcyNjQgMTYuNDMwNiAxOS40ODgxTDEwLjQzMDYgMTIuNDg4MUMxMC4xODk4IDEyLjIwNzMgMTAuMTg5OCAxMS43OTI4IDEwLjQzMDYgMTEuNTExOUwxNi40MzA2IDQuNTExOTRDMTYuNjM0OCA0LjI3MzY0IDE2Ljk2NTggNC4xODc3MyAxNy4yNjAyIDQuMjk2NjJDMTcuNTU0NiA0LjQwNTUxIDE3Ljc1IDQuNjg2MTggMTcuNzUgNS4wMDAwNEwxNy43NSAxOVoiIGZpbGw9IiNDQkQ1RTEiLz4KPHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik0xMy40ODgxIDE5LjU2OTVDMTMuODAyNiAxOS4yOTk5IDEzLjgzOSAxOC44MjY0IDEzLjU2OTQgMTguNTExOUw3Ljk4NzgxIDEyTDEzLjU2OTQgNS40ODgxMUMxMy44MzkgNS4xNzM2MSAxMy44MDI2IDQuNzAwMTQgMTMuNDg4MSA0LjQzMDU3QzEzLjE3MzYgNC4xNjEgMTIuNzAwMSA0LjE5NzQzIDEyLjQzMDYgNC41MTE5Mkw2LjQzMDU2IDExLjUxMTlDNi4xODk4MSAxMS43OTI4IDYuMTg5ODEgMTIuMjA3MiA2LjQzMDU2IDEyLjQ4ODFMMTIuNDMwNiAxOS40ODgxQzEyLjcwMDEgMTkuODAyNiAxMy4xNzM2IDE5LjgzOSAxMy40ODgxIDE5LjU2OTVaIiBmaWxsPSIjQ0JENUUxIi8+Cjwvc3ZnPgo=';
const IO = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggb3BhY2l0eT0iMC41IiBkPSJNNi4yNSAxOUM2LjI1IDE5LjMxMzkgNi40NDU0MyAxOS41OTQ2IDYuNzM5NzkgMTkuNzAzNUM3LjAzNDE1IDE5LjgxMjMgNy4zNjUxOSAxOS43MjY0IDcuNTY5NDQgMTkuNDg4MUwxMy41Njk0IDEyLjQ4ODFDMTMuODEwMiAxMi4yMDczIDEzLjgxMDIgMTEuNzkyOCAxMy41Njk0IDExLjUxMTlMNy41Njk0NCA0LjUxMTk0QzcuMzY1MTkgNC4yNzM2NCA3LjAzNDE1IDQuMTg3NzMgNi43Mzk3OSA0LjI5NjYyQzYuNDQ1NDMgNC40MDU1MSA2LjI1IDQuNjg2MTggNi4yNSA1LjAwMDA0TDYuMjUgMTlaIiBmaWxsPSIjQ0JENUUxIi8+CjxwYXRoIGZpbGwtcnVsZT0iZXZlbm9kZCIgY2xpcC1ydWxlPSJldmVub2RkIiBkPSJNMTAuNTExOSAxOS41Njk1QzEwLjE5NzQgMTkuMjk5OSAxMC4xNjEgMTguODI2NCAxMC40MzA2IDE4LjUxMTlMMTYuMDEyMiAxMkwxMC40MzA2IDUuNDg4MTFDMTAuMTYxIDUuMTczNjEgMTAuMTk3NCA0LjcwMDE0IDEwLjUxMTkgNC40MzA1N0MxMC44MjY0IDQuMTYxIDExLjI5OTkgNC4xOTc0MyAxMS41Njk1IDQuNTExOTJMMTcuNTY5NSAxMS41MTE5QzE3LjgxMDIgMTEuNzkyOCAxNy44MTAyIDEyLjIwNzIgMTcuNTY5NSAxMi40ODgxTDExLjU2OTUgMTkuNDg4MUMxMS4yOTk5IDE5LjgwMjYgMTAuODI2NCAxOS44MzkgMTAuNTExOSAxOS41Njk1WiIgZmlsbD0iI0NCRDVFMSIvPgo8L3N2Zz4K';

export function getToken() {
  const raw = localStorage.getItem('mercury_token');
  if (!raw) return null;
  try { return raw.startsWith('{') ? JSON.parse(raw).access_token : raw; } catch(e) { return raw; }
}

export function authHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() };
}

function fmtDate(iso) {
  const d = new Date(iso);
  return [String(d.getDate()).padStart(2,'0'), String(d.getMonth()+1).padStart(2,'0'), d.getFullYear()].join('-');
}

function daysLeft(iso) {
  return Math.max(0, Math.ceil((new Date(iso) - new Date()) / 86400000));
}

function plural(n) {
  return n%10===1&&n%100!==11 ? 'день' : [2,3,4].includes(n%10)&&![12,13,14].includes(n%100) ? 'дня' : 'дней';
}

export function renderHeader({username, subscription}) {
  const name = username || 'Пользователь';
  let subHtml = '';
  if (subscription) {
    const d = fmtDate(subscription.ends_at);
    const dl = daysLeft(subscription.ends_at);
    const chip = dl <= 30 ? `<span class="lk-badge">${dl} ${plural(dl)}</span>` : '';
    const lbl = subscription.status === 'trial' ? `Пробный период до ${d}` : `Подписка до ${d}`;
    subHtml = `<div class="lk-header__sub"><span class="lk-header__sub-text">${lbl}</span>${chip}</div>`;
  }
  const _lkUserInfo = document.getElementById('lkUserInfo');
  if (_lkUserInfo) _lkUserInfo.innerHTML =
    `<div class="lk-header__username">Кабинет: <strong>${name}</strong></div>${subHtml}`;

  let drawerSub = '';
  if (subscription) {
    const d = fmtDate(subscription.ends_at);
    const dl = daysLeft(subscription.ends_at);
    const chip = dl <= 30 ? `<span class="lk-badge">${dl} ${plural(dl)}</span>` : '';
    const lbl = subscription.status === 'trial' ? `Пробный период до ${d}` : `Подписка до ${d}`;
    drawerSub = `<div class="lk-drawer__sub"><span class="lk-drawer__sub-text">${lbl}</span>${chip}</div>`;
  }
  const _drawerUserInfo = document.getElementById('drawerUserInfo');
  if (_drawerUserInfo) _drawerUserInfo.innerHTML =
    `<div class="lk-drawer__name">Кабинет: <strong>${name}</strong></div>${drawerSub}`;
}

// Inject shared responsive logo CSS once
(function() {
  if (document.getElementById('lk-layout-css')) return;
  const s = document.createElement('style');
  s.id = 'lk-layout-css';
  s.textContent = '@media (max-width: 768px) { .lk-logo--desktop { display: none !important; } .lk-logo--mobile { display: block !important; } }';
  document.head.appendChild(s);
})();

export function initLayout(activeNavItem) {
  if (!getToken()) { window.location.replace('/cabinet/login'); return; }

  // Set active nav item
  const targetHref = '/cabinet/' + activeNavItem;
  document.querySelectorAll('.nav-item').forEach(el => {
    if (el.getAttribute('href') === targetHref) {
      el.classList.add('is-active');
    } else {
      el.classList.remove('is-active');
    }
  });
  document.querySelectorAll('.nav-text-link').forEach(el => {
    if (el.getAttribute('href') === targetHref) {
      el.classList.add('is-active');
    } else {
      el.classList.remove('is-active');
    }
  });

  // Sidebar toggle
  const sidebar = document.getElementById('lkSidebar');
  const toggleBtn = document.getElementById('sbToggle');
  const toggleIcon = document.getElementById('sbToggleIcon');
  let collapsed = false;
  if (toggleBtn) toggleBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    if (sidebar) sidebar.classList.toggle('is-collapsed', collapsed);
    if (toggleIcon) toggleIcon.src = collapsed ? IO : IC;
    toggleBtn.setAttribute('aria-label', collapsed ? 'Развернуть меню' : 'Свернуть меню');
  });

  // Nav item click active state
  document.querySelectorAll('.lk-sidebar .nav-item:not(.is-dis-sub):not(.is-dis-soon)').forEach(el => {
    el.addEventListener('click', function(e) {
      const href = this.getAttribute('href');
      if (!href || href === '#') {
        e.preventDefault();
        document.querySelectorAll('.lk-sidebar .nav-item').forEach(i => i.classList.remove('is-active'));
        this.classList.add('is-active');
      }
    });
  });

  // Mobile drawer
  const burger = document.getElementById('lkBurger');
  const drawer = document.getElementById('lkDrawer');
  const overlay = document.getElementById('lkOverlay');
  const closeBtn = document.getElementById('lkDrawerClose');
  function openDrawer() {
    if (overlay) { overlay.classList.add('is-open'); requestAnimationFrame(() => overlay.classList.add('is-visible')); }
    if (drawer) drawer.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    if (burger) burger.setAttribute('aria-expanded', 'true');
  }
  function closeDrawer() {
    if (overlay) { overlay.classList.remove('is-visible'); setTimeout(() => overlay.classList.remove('is-open'), 250); }
    if (drawer) drawer.classList.remove('is-open');
    document.body.style.overflow = '';
    if (burger) burger.setAttribute('aria-expanded', 'false');
  }
  if (burger) burger.addEventListener('click', openDrawer);
  if (closeBtn) closeBtn.addEventListener('click', closeDrawer);
  if (overlay) overlay.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
  document.querySelectorAll('.lk-drawer .nav-item:not(.is-dis-sub):not(.is-dis-soon)').forEach(el => {
    el.addEventListener('click', function(e) {
      const href = this.getAttribute('href');
      if (!href || href === '#') e.preventDefault();
      setTimeout(closeDrawer, 150);
    });
  });
}

export async function loadUser() {
  const token = getToken();
  if (!token) { window.location.replace('/cabinet/login'); return; }
  try {
    const res = await fetch('/api/me', { headers: authHeaders() });
    if (res.status === 401) { window.location.replace('/cabinet/login'); return; }
    if (!res.ok) return;
    const d = await res.json();
    renderHeader({ username: d.username || d.external_id || 'Пользователь', subscription: d.subscription || null });
  } catch(e) {
    const el = document.getElementById('lkUserInfo');
    if (el) el.textContent = 'Ошибка загрузки';
  }
}
