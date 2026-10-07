// Frontend edit script for Prompt 53
// Removes Supabase Auth calls from login.html, register.html, reset-password.html
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(__dirname, 'public/cabinet');

// ── login.html ────────────────────────────────────────────────────────────────
{
  let html = fs.readFileSync(path.join(pub, 'login.html'), 'utf8');

  // 1. Remove SUPABASE_URL and SUPABASE_ANON_KEY constants
  html = html.replace(
    /  const SUPABASE_URL\s*=\s*'[^']*';\n  const SUPABASE_ANON_KEY\s*=\s*'[^']*';\n/,
    ''
  );

  // 2. Remove supabasePost helper function block
  html = html.replace(
    /  \/\/ ── Supabase call helpers ─+\n  async function supabasePost[\s\S]*?\n  \}\n\n/,
    ''
  );

  // 3. Replace login scenario — two-step Supabase→JWT with direct own /api/auth/login
  html = html.replace(
    /      const res  = await supabasePost\('\/auth\/v1\/token\?grant_type=password',[\s\S]*?const loginData = await loginRes\.json\(\);\n      localStorage\.setItem\('mercury_token', loginData\.token\);/,
    `      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail.value.trim().toLowerCase(), password: loginPassword.value })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Неверный e-mail или пароль');
      }
      localStorage.setItem('mercury_token', data.token);`
  );

  // 4. Replace forgot password — Supabase recover with /api/auth/forgot
  html = html.replace(
    /      const RESET_REDIRECT = '[^']*';\n      await supabasePost\('\/auth\/v1\/recover[^)]*\)',[\s\S]*?\);/,
    `      const res = await fetch('/api/auth/forgot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: resetEmail.value.trim().toLowerCase() })
      });
      if (!res.ok) throw new Error('server');`
  );

  // 5. Remove getStoredToken function
  html = html.replace(
    /  function getStoredToken\(\) \{[\s\S]*?\n  \}\n\n/,
    ''
  );

  // 6. Remove Supabase logout call block inside btnLogoutConfirm handler
  html = html.replace(
    /    if \(SUPABASE_ANON_KEY !== '[^']*'\) \{[\s\S]*?\n    \}\n/,
    ''
  );

  fs.writeFileSync(path.join(pub, 'login.html'), html);
  console.log('✓ login.html');
}

// ── register.html ─────────────────────────────────────────────────────────────
{
  let html = fs.readFileSync(path.join(pub, 'register.html'), 'utf8');

  // Remove SUPABASE_URL and SUPABASE_ANON_KEY constants
  html = html.replace(
    /  const SUPABASE_URL\s*=\s*'[^']*';\n  const SUPABASE_ANON_KEY\s*=\s*'[^']*';\n/,
    ''
  );

  // Remove supabasePost helper
  html = html.replace(
    /  \/\/ ── Supabase call helpers ─+\n  async function supabasePost[\s\S]*?\n  \}\n\n/,
    ''
  );

  // Replace Supabase signup + register-profile with /api/auth/register
  // Find the core registration block and replace it
  html = html.replace(
    /\/\/ ── Step 1: Supabase Auth signup[\s\S]*?\/\/ ── Step 2: create user profile[\s\S]*?\/\/ ──+ end register[\s\S]*?(?=\n\s*\/\/|\n<\/script>)/,
    (match) => {
      // fallback if step comments not found
      return match;
    }
  );

  // More targeted: replace the core fetch calls
  // Pattern: Supabase signUp + register-profile call → /api/auth/register
  html = html.replace(
    /const signUpRes = await supabasePost[\s\S]*?\/\/ ── end register ──+/,
    `const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: emailVal,
          password: passVal,
          name: nameVal || null,
        })
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409) throw new Error('Этот e-mail уже зарегистрирован');
        throw new Error(data.error || 'Ошибка регистрации');
      }
      localStorage.setItem('mercury_token', data.token);
      // ── end register ──`
  );

  fs.writeFileSync(path.join(pub, 'register.html'), html);
  console.log('✓ register.html');
}

// ── reset-password.html ───────────────────────────────────────────────────────
{
  let html = fs.readFileSync(path.join(pub, 'reset-password.html'), 'utf8');

  // Remove SUPABASE_URL and SUPABASE_ANON_KEY
  html = html.replace(
    /  const SUPABASE_URL\s*=\s*'[^']*';\n  const SUPABASE_ANON_KEY\s*=\s*'[^']*';\n/,
    ''
  );

  // Remove supabasePost helper
  html = html.replace(
    /  \/\/ ── Supabase call helpers ─+\n  async function supabasePost[\s\S]*?\n  \}\n\n/,
    ''
  );

  // Replace Supabase PUT /auth/v1/user password update with /api/auth/reset
  html = html.replace(
    /const res = await supabasePost\('\/auth\/v1\/user',[\s\S]*?\}\);/m,
    `const res = await fetch('/api/auth/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, password: newPass })
      });`
  );

  // If the old code uses PUT instead of POST supabasePost
  html = html.replace(
    /const res = await fetch\(SUPABASE_URL[\s\S]*?Authorization[\s\S]*?\}\);/m,
    `const res = await fetch('/api/auth/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, password: newPass })
      });`
  );

  // Remove Supabase access_token extraction from URL hash — replace with own token from search params
  html = html.replace(
    /const hash = new URLSearchParams\(window\.location\.hash\.replace[\s\S]*?const accessToken = hash\.get\('access_token'\);[\s\S]*?history\.replaceState[\s\S]*?\);/m,
    `const params = new URLSearchParams(window.location.search);
    const resetToken = params.get('token');
    if (resetToken) history.replaceState(null, '', window.location.pathname);`
  );

  // Replace references to accessToken with resetToken
  html = html.replace(/\baccessToken\b/g, 'resetToken');

  fs.writeFileSync(path.join(pub, 'reset-password.html'), html);
  console.log('✓ reset-password.html');
}

console.log('Done.');
