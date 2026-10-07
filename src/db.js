import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { createPgDb } from './db/pgClient.js';

// If DATABASE_URL is set — use own PostgreSQL (Russian server).
// Otherwise — use Supabase (Railway). Switch by env var only.
export const dbDriver = process.env.DATABASE_URL ? 'postgres' : 'supabase';

function createSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required when DATABASE_URL is not set');
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// Name `supabase` preserved so existing supabase.from(...) calls don't change.
export const supabase = dbDriver === 'postgres'
  ? createPgDb(process.env.DATABASE_URL)
  : createSupabase();
