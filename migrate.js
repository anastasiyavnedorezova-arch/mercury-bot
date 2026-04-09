/**
 * Запуск миграции через Supabase Management API.
 *
 * Требует SUPABASE_ACCESS_TOKEN — персональный токен из
 * https://supabase.com/dashboard/account/tokens
 *
 * Если токена нет — выводит ссылку на SQL Editor.
 */

import 'dotenv/config';
import { readFileSync } from 'fs';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ACCESS_TOKEN } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Ошибка: SUPABASE_URL и SUPABASE_SERVICE_KEY должны быть в .env');
  process.exit(1);
}

const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0];
const sql = readFileSync(new URL('./migration.sql', import.meta.url), 'utf-8');

// ── Способ 1: Management API (нужен personal access token) ──────────────────
if (SUPABASE_ACCESS_TOKEN) {
  console.log(`Запуск миграции для проекта ${projectRef} через Management API...`);

  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error('Ошибка Management API:', res.status, body);
    process.exit(1);
  }

  const result = await res.json();
  console.log('Миграция выполнена успешно!');
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

// ── Способ 2: инструкция для SQL Editor ─────────────────────────────────────
console.log(`
SUPABASE_ACCESS_TOKEN не найден в .env.

Добавьте токен в .env и запустите снова:

  SUPABASE_ACCESS_TOKEN=sbp_xxxxx  ← получить на https://supabase.com/dashboard/account/tokens

──────────────────────────────────────────────────────────────────────────────
Или выполните migration.sql вручную через SQL Editor:

  https://supabase.com/dashboard/project/${projectRef}/sql/new

  1. Откройте ссылку выше
  2. Вставьте содержимое файла migration.sql
  3. Нажмите Run (Ctrl+Enter)
──────────────────────────────────────────────────────────────────────────────
`);
