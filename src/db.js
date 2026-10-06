import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { createPgDb } from './db/pgClient.js';

// Если задан DATABASE_URL — работаем с собственным PostgreSQL (российский сервер).
// Если не задан — как раньше, через Supabase (Railway). Переключение делается только переменной окружения.
export const dbDriver = process.env.DATABASE_URL ? 'postgres' : 'supabase';

const supabaseClient =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    : null;

if (dbDriver === 'supabase' && !supabaseClient) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required when DATABASE_URL is not set');
}

// Имя `supabase` сохранено, чтобы не менять вызовы supabase.from(...) по всему проекту.
export const supabase = dbDriver === 'postgres' ? createPgDb(process.env.DATABASE_URL) : supabaseClient;

// Клиент Supabase только для проверки токенов входа (auth.getUser).
// Нужен, пока вход идёт через Supabase Auth; будет убран при переходе на собственную авторизацию.
export const supabaseAuth = supabaseClient;
