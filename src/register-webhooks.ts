import 'dotenv/config';
import { TelegramBot, NodeApiClient } from 'ultra-telegram-framework';
import { db, type BotRecord } from './db.js';

const BASE_URL = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '');
if (!BASE_URL) throw new Error('PUBLIC_BASE_URL не задан в .env');

const { data, error } = await db
  .from('bots')
  .select('id, number, token, city_name, is_active, manager_telegram_id')
  .eq('is_active', true);

if (error) throw new Error(`Ошибка БД: ${error.message}`);

const bots = (data as BotRecord[]) ?? [];
if (bots.length === 0) {
  console.log('Активных ботов не найдено.');
  process.exit(0);
}

console.log(`Регистрирую вебхуки для ${bots.length} ботов...`);

for (const bot of bots) {
  const url = `${BASE_URL}/webhook/${bot.number}`;
  try {
    const instance = new TelegramBot(new NodeApiClient(bot.token));
    await instance.setWebhook(url, {
      drop_pending_updates: true,
      allowed_updates: ['message', 'callback_query']
    });
    console.log(`✅ ${bot.city_name} → ${url}`);
  } catch (err) {
    console.error(`❌ ${bot.city_name}:`, err);
  }
}