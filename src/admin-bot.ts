import {
  TelegramBot,
  NodeApiClient,
  InlineKeyboard,
  Context
} from 'ultra-telegram-framework';
import { db } from './db.js';

// ── Singleton ────────────────────────────────────────────────────────────
// В отличие от city-ботов (bot-manager.ts), этот бот не в таблице `bots` —
// он один на всю систему, конфиг только через .env.

let adminBot: TelegramBot<Context> | null = null;
let warnedMissingConfig = false;

export function getAdminBotUuid(): string | null {
  return process.env.ADMIN_BOT_UUID ?? null;
}

export function getAdminBot(): TelegramBot<Context> | null {
  const token = process.env.ADMIN_BOT_TOKEN;
  const superAdminId = process.env.SUPER_ADMIN_ID;

  if (!token || !superAdminId) {
    if (!warnedMissingConfig) {
      console.warn('[AdminBot] ADMIN_BOT_TOKEN / SUPER_ADMIN_ID не заданы — админ-бот отключён.');
      warnedMissingConfig = true;
    }
    return null;
  }

  if (adminBot) return adminBot;

  adminBot = createAdminBot(token, Number(superAdminId));
  console.log('[AdminBot] Инстанс создан.');
  return adminBot;
}

// ── Бот ──────────────────────────────────────────────────────────────────

function createAdminBot(token: string, superAdminId: number): TelegramBot<Context> {
  const bot = new TelegramBot<Context>(new NodeApiClient(token));

  bot.catch((err) => {
    console.error('[AdminBot] Ошибка:', err);
  });

  // Пускаем только суперадмина — всех остальных молча игнорируем
  bot.use(async (ctx, next) => {
    const userId = ctx.callbackQuery?.from.id
      ?? (ctx.message && 'from' in ctx.message ? ctx.message.from?.id : undefined);

    if (userId !== superAdminId) return;
    await next();
  });

  bot.command('start', async (ctx) => {
    await sendDashboard(ctx);
  });

  bot.action('admin_dashboard', async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendDashboard(ctx);
  });

  bot.action(/^admin_city:/, async (ctx) => {
    const botId = parseInt((ctx.callbackQuery!.data ?? '').replace('admin_city:', ''));
    await ctx.answerCallbackQuery();
    await sendCityDetails(ctx, botId);
  });

  bot.action('admin_chats', async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendActiveChats(ctx);
  });

  return bot;
}

// ── Дашборд: сводка по всем городам ────────────────────────────────────

async function sendDashboard(ctx: Context): Promise<void> {
  const { data: botsRaw, error: botsError } = await db
    .from('bots')
    .select('id, city_name, is_active')
    .order('city_name');

  if (botsError) {
    console.error('[AdminBot] Ошибка загрузки bots:', botsError.message);
    await ctx.reply('⚠️ Не удалось загрузить данные. Попробуйте позже.');
    return;
  }

  const cities = (botsRaw as Array<{ id: number; city_name: string; is_active: boolean }>) ?? [];

  if (cities.length === 0) {
    await ctx.reply('Городов пока нет в системе.');
    return;
  }

  const botIds = cities.map((c) => c.id);

  const [{ data: mastersRaw }, { data: chatsRaw }] = await Promise.all([
    db.from('masters_profiles').select('bot_id, is_active').in('bot_id', botIds),
    db.from('active_chats').select('bot_id').eq('status', 'active').in('bot_id', botIds)
  ]);

  const masters = (mastersRaw as Array<{ bot_id: number; is_active: boolean }>) ?? [];
  const chats = (chatsRaw as Array<{ bot_id: number }>) ?? [];

  const mastersByBot = new Map<number, { total: number; active: number }>();
  for (const m of masters) {
    const stat = mastersByBot.get(m.bot_id) ?? { total: 0, active: 0 };
    stat.total += 1;
    if (m.is_active) stat.active += 1;
    mastersByBot.set(m.bot_id, stat);
  }

  const chatsByBot = new Map<number, number>();
  for (const c of chats) {
    chatsByBot.set(c.bot_id, (chatsByBot.get(c.bot_id) ?? 0) + 1);
  }

  const activeCities = cities.filter((c) => c.is_active).length;

  const text =
    `🛠 *Панель суперадмина*\n\n` +
    `🏙 Городов: ${cities.length} (активно: ${activeCities})\n` +
    `💼 Мастеров всего: ${masters.length} (активно: ${masters.filter((m) => m.is_active).length})\n` +
    `💬 Открытых чатов: ${chats.length}\n\n` +
    `Выберите город для деталей:`;

  const keyboard = new InlineKeyboard();
  for (const city of cities) {
    const stat = mastersByBot.get(city.id) ?? { total: 0, active: 0 };
    const chatCount = chatsByBot.get(city.id) ?? 0;
    const statusIcon = city.is_active ? '🟢' : '🔴';

    keyboard
      .text(
        `${statusIcon} ${city.city_name} · 👤${stat.active}/${stat.total} · 💬${chatCount}`,
        `admin_city:${city.id}`
      )
      .row();
  }
  keyboard.text('💬 Все активные чаты', 'admin_chats');

  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard.toJSON() });
}

// ── Детали по одному городу ─────────────────────────────────────────────

async function sendCityDetails(ctx: Context, botId: number): Promise<void> {
  const { data: cityRaw } = await db
    .from('bots')
    .select('city_name, is_active')
    .eq('id', botId)
    .maybeSingle();

  if (!cityRaw) {
    await ctx.reply('Город не найден.');
    return;
  }

  const city = cityRaw as { city_name: string; is_active: boolean };

  const [{ data: mastersRaw }, { data: chatsRaw }] = await Promise.all([
    db
      .from('masters_profiles')
      .select('name, is_active, price_from')
      .eq('bot_id', botId)
      .order('is_active', { ascending: false }),
    db.from('active_chats').select('id').eq('bot_id', botId).eq('status', 'active')
  ]);

  const masters = (mastersRaw as Array<{ name: string; is_active: boolean; price_from: number }>) ?? [];
  const chatCount = ((chatsRaw as unknown[]) ?? []).length;

  let text =
    `${city.is_active ? '🟢' : '🔴'} *${city.city_name}*\n` +
    `💬 Открытых чатов: ${chatCount}\n\n` +
    `*Мастера (${masters.length}):*\n`;

  if (masters.length === 0) {
    text += '—\n';
  } else {
    for (const m of masters) {
      text += `${m.is_active ? '✅' : '⏸'} ${m.name} · от ${m.price_from} грн\n`;
    }
  }

  const keyboard = new InlineKeyboard().text('⬅️ Назад', 'admin_dashboard');

  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard.toJSON() });
}

// ── Все активные чаты по всем городам ───────────────────────────────────

async function sendActiveChats(ctx: Context): Promise<void> {
  const { data: chatsRaw } = await db
    .from('active_chats')
    .select('client_id, master_id, updated_at, bots(city_name)')
    .eq('status', 'active')
    .order('updated_at', { ascending: false });

  const chats = (chatsRaw as Array<Record<string, unknown>>) ?? [];

  const keyboard = new InlineKeyboard().text('⬅️ Назад', 'admin_dashboard');

  if (chats.length === 0) {
    await ctx.reply('Активных чатов нет.', { reply_markup: keyboard.toJSON() });
    return;
  }

  let text = `💬 *Активные чаты (${chats.length}):*\n\n`;
  for (const chat of chats) {
    const cityName = (chat.bots as { city_name: string } | null)?.city_name ?? '—';
    const updatedAt = new Date(chat.updated_at as string);
    const minutesAgo = Math.max(0, Math.round((Date.now() - updatedAt.getTime()) / 60000));

    text += `🏙 ${cityName} · клиент \`${chat.client_id}\` ↔ мастер \`${chat.master_id}\` · ${minutesAgo} мин назад\n`;
  }

  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard.toJSON() });
}