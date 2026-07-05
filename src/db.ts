import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY не заданы в .env');
}

export const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Строка из таблицы bots
export interface BotRecord {
  id: number;
  number: string;
  token: string;
  city_name: string;
  is_active: boolean;
  manager_telegram_id: number | null;
}
