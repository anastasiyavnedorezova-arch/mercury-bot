import 'dotenv/config';
import { createPgDb } from './db/pgClient.js';

// База данных — собственный PostgreSQL, адрес берётся из DATABASE_URL.
export const dbDriver = 'postgres';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

// Имя `supabase` осталось от прежней базы: так названа переменная в вызовах supabase.from(...) по всему проекту.
export const supabase = createPgDb(process.env.DATABASE_URL);
