import {
  TelegramBot,
  NodeApiClient,
  InlineKeyboard,
  ReplyKeyboard,
  sessionManager,
  Stage
} from 'ultra-telegram-framework';
import type { SceneContext } from 'ultra-telegram-framework';
import { db, type BotRecord } from './db.js';
import { createMasterRegistrationScene } from './scenes/master-registration.js';
import { createEditPriceScene } from './scenes/edit-price.js';
import { createEditDistrictScene } from './scenes/edit-district.js';
import { createEditServicesScene } from './scenes/edit-services.js';
import { createEditPhotosScene } from './scenes/edit-photos.js';
import { createClientSearchScene, getServicesWithMasters } from './scenes/client-search.js';
import { getDistricts, buildListKeyboard } from './districts.js';

const cache = new Map<string, TelegramBot<SceneContext>>();

export async function getBot(uuid: string): Promise<TelegramBot<SceneContext> | null> {
  if (cache.has(uuid)) return cache.get(uuid)!;

  const { data, error } = await db
    .from('bots')
    .select('id, number, token, city_name, is_active, manager_telegram_id')
    .eq('number', uuid)
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    console.error(`[BotCache] Ошибка uuid=${uuid}:`, error.message);
    return null;
  }
  if (!data) return null;

  const record = data as BotRecord;
  const bot = createBot(record);
  cache.set(uuid, bot);
  console.log(`[BotCache] Создан инстанс: ${record.city_name}`);
  return bot;
}

export function invalidateBot(uuid: string): void {
  if (cache.delete(uuid)) {
    console.log(`[BotCache] Удалён из кэша: ${uuid}`);
  }
}

export function cacheSize(): number {
  return cache.size;
}

// Reply-клавиатура для мастера
const masterKeyboard = new ReplyKeyboard()
  .text('👤 Мой профиль')
  .resized(true);

function createBot(record: BotRecord): TelegramBot<SceneContext> {
  const bot = new TelegramBot<SceneContext>(new NodeApiClient(record.token));

  bot.catch((err, ctx) => {
    console.error(`[${record.city_name}] Ошибка:`, err);
  });

  // Сессии с правильным ключом (обходим баг ctx.from в UTF)
  bot.use(sessionManager({
    initial: () => ({}),
    getSessionKey: (ctx) => {
      const userId = ctx.callbackQuery?.from.id ??
        (ctx.message && 'from' in ctx.message ? ctx.message.from?.id : undefined);
      const chatId = ctx.chatId;
      if (!userId || !chatId) return undefined;
      return `${record.id}:${chatId}:${userId}`;
    }
  }));

  // Сцены
  const stage = new Stage<SceneContext>([
    createMasterRegistrationScene(record.id),
    createEditPriceScene(record.id),
    createEditDistrictScene(record.id),
    createEditServicesScene(record.id),
    createEditPhotosScene(record.id),
    createClientSearchScene(record.id)
  ]);
  bot.use(stage.middleware());

  // /start — проверяем есть ли уже роль
  bot.command('start', async (ctx) => {
    const telegramId = ctx.message && 'from' in ctx.message
      ? ctx.message.from?.id
      : undefined;

    if (telegramId) {
      const { data } = await db
        .from('users')
        .select('role')
        .eq('bot_id', record.id)
        .eq('telegram_id', telegramId)
        .maybeSingle();

      if (data?.role === 'master') {
        return ctx.replyWithKeyboard(
          `👋 С возвращением в ${record.city_name}!`,
          masterKeyboard
        );
      }

      if (data?.role === 'client') {
        const clientKeyboard = new ReplyKeyboard()
          .text('🔍 Найти мастера')
          .resized(true);

        return ctx.replyWithKeyboard(
          `👋 С возвращением в ${record.city_name}!`,
          clientKeyboard
        );
      }
    }

    // Новый пользователь — выбор роли
    const keyboard = new InlineKeyboard()
      .text('🔍 Я ищу мастера', 'role:client')
      .row()
      .text('💼 Я мастер', 'role:master');

    await ctx.reply(
      `👋 Добро пожаловать в ${record.city_name}!\n\nКто вы?`,
      { reply_markup: keyboard.toJSON() }
    );
  });

  // Выбор роли
  bot.action('role:client', async (ctx) => {
    const userId = ctx.callbackQuery!.from.id;
    await saveRole(record.id, userId, 'client');
    await ctx.answerCallbackQuery();

    const clientKeyboard = new ReplyKeyboard()
      .text('🔍 Найти мастера')
      .resized(true);

    await ctx.replyWithKeyboard(
      '✅ Вы зарегистрированы как клиент.\n\nНажмите кнопку чтобы найти мастера:',
      clientKeyboard
    );
  });

  bot.action('role:master', async (ctx) => {
    const userId = ctx.callbackQuery!.from.id;
    await saveRole(record.id, userId, 'master');
    await ctx.answerCallbackQuery();
    await ctx.reply('Как вас зовут? Введите ваше имя:');
    ctx.scene.enter('master_registration');
  });

  // Поиск мастеров (кнопка и команда)
  const startSearch = async (ctx: SceneContext) => {
    const services = await getServicesWithMasters(record.id);

    if (services.length === 0) {
      return ctx.reply('😔 Пока нет доступных мастеров. Загляните позже!');
    }

    const keyboard = new InlineKeyboard();
    for (const s of services) {
      keyboard.text(s.name, `search_svc:${s.id}`).row();
    }

    await ctx.reply(
      '🔧 Какая услуга вам нужна?',
      { reply_markup: keyboard.toJSON() }
    );

    ctx.scene.enter('client_search');
    ctx.scene.state.services_list = services;
  };

  bot.match('🔍 Найти мастера', startSearch);
  bot.command('search', startSearch);

  // Полная карточка мастера для клиента
  bot.action(/^master_card:/, async (ctx) => {
    const masterId = parseInt((ctx.callbackQuery!.data ?? '').replace('master_card:', ''));
    await ctx.answerCallbackQuery();

    const { data } = await db
      .from('masters_profiles')
      .select(`
        name, price_from, photos,
        districts(name),
        sub_districts(name),
        master_services(services(name))
      `)
      .eq('master_id', masterId)
      .eq('bot_id', record.id)
      .maybeSingle();

    if (!data) return ctx.reply('Профиль не найден.');

    const raw = data as Record<string, unknown>;
    const districtName = (raw.districts as { name: string } | null)?.name ?? '';
    const subDistrictName = (raw.sub_districts as { name: string } | null)?.name ?? '';
    const location = subDistrictName
      ? `${districtName} → ${subDistrictName}`
      : districtName || '—';

    const services = (raw.master_services as Array<{ services: { name: string } }> ?? [])
      .map(ms => ms.services?.name)
      .filter(Boolean)
      .join(', ') || '—';

    const text =
      `👤 *${raw.name}*\n` +
      `💼 ${services}\n` +
      `📍 ${location}\n` +
      `💰 от ${raw.price_from} грн`;

    const keyboard = new InlineKeyboard()
      .text('💬 Написать мастеру', `chat:${masterId}`);

    const photos = raw.photos as string[];

    if (photos && photos.length > 0) {
      await ctx.replyWithMediaGroup(
        photos.map((fileId: string, i: number) => ({
          type: 'photo' as const,
          media: fileId,
          ...(i === 0 ? { caption: text, parse_mode: 'Markdown' as const } : {})
        }))
      );
      await ctx.reply('👆 Контакт мастера:', { reply_markup: keyboard.toJSON() });
    } else {
      await ctx.reply(text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard.toJSON()
      });
    }
  });

  // Кнопка «Мой профиль»
  bot.match('👤 Мой профиль', async (ctx) => {
    const telegramId = ctx.message && 'from' in ctx.message
      ? ctx.message.from?.id
      : undefined;

    if (!telegramId) return;

    await showMasterProfile(ctx, telegramId, record.id);
  });

  // Редактирование фото
  bot.action('edit:photos', async (ctx) => {
    const telegramId = ctx.callbackQuery!.from.id;
    await ctx.answerCallbackQuery();

    const { data } = await db
      .from('masters_profiles')
      .select('photos')
      .eq('master_id', telegramId)
      .eq('bot_id', record.id)
      .maybeSingle();

    const photos = (data as { photos: string[] } | null)?.photos ?? [];

    await ctx.reply(
      `📸 Сейчас у вас ${photos.length} фото в портфолио.\n\n` +
      `Отправьте новые фото (до 5) чтобы заменить все.\n` +
      `/done — сохранить\n` +
      `/skip — удалить все фото`
    );

    ctx.scene.enter('edit_photos');
    ctx.scene.state.photos = [];
  });

  // Редактирование услуг
  bot.action('edit:services', async (ctx) => {
    const telegramId = ctx.callbackQuery!.from.id;
    await ctx.answerCallbackQuery();

    const { data: allServices } = await db
      .from('bot_services')
      .select('services(id, name)')
      .eq('bot_id', record.id)
      .eq('is_enabled', true);

    const services = (allServices as unknown as Array<{ services: { id: number; name: string } }>)
      .map(r => r.services).filter(Boolean);

    const { data: currentServices } = await db
      .from('master_services')
      .select('service_id')
      .eq('master_id', telegramId)
      .eq('bot_id', record.id);

    const selected = (currentServices as Array<{ service_id: number }> ?? [])
      .map(r => r.service_id);

    const keyboard = new InlineKeyboard();
    for (const s of services) {
      keyboard.text(`${selected.includes(s.id) ? '✅' : '☐'} ${s.name}`, `svc:${s.id}`).row();
    }
    keyboard.text('✔️ Готово', 'svc:done');

    await ctx.reply('🔧 Выберите ваши услуги:', { reply_markup: keyboard.toJSON() });

    ctx.scene.enter('edit_services');
    ctx.scene.state.services = services;
    ctx.scene.state.selected = selected;
  });

  // Редактирование района
  bot.action('edit:district', async (ctx) => {
    await ctx.answerCallbackQuery();

    const districts = await getDistricts(record.id);
    if (districts.length === 0) {
      return ctx.reply('⚠️ Районы не настроены.');
    }

    await ctx.reply(
      '📍 Выберите новый район:',
      { reply_markup: buildListKeyboard(districts, 'district').toJSON() }
    );

    ctx.scene.enter('edit_district');
  });

  // Редактирование цены
  bot.action('edit:price', async (ctx) => {
    const userId = ctx.callbackQuery!.from.id;
    await ctx.answerCallbackQuery();
    await ctx.reply('💰 Введите новую минимальную цену (в грн):');
    ctx.scene.enter('edit_price');
  });

  // Переключение статуса активности
  bot.action('toggle:active', async (ctx) => {
    const telegramId = ctx.callbackQuery!.from.id;

    const { data: profile } = await db
      .from('masters_profiles')
      .select('is_active')
      .eq('master_id', telegramId)
      .eq('bot_id', record.id)
      .maybeSingle();

    if (!profile) return ctx.answerCallbackQuery('Профиль не найден');

    const newStatus = !profile.is_active;

    await db
      .from('masters_profiles')
      .update({ is_active: newStatus })
      .eq('master_id', telegramId)
      .eq('bot_id', record.id);

    await ctx.answerCallbackQuery(
      newStatus ? '✅ Вы снова активны!' : '⏸ Вы на паузе'
    );

    // Обновляем профиль
    await showMasterProfile(ctx, telegramId, record.id);
  });

  return bot;
}

// Показываем профиль мастера
async function showMasterProfile(
  ctx: SceneContext,
  telegramId: number,
  botId: number
): Promise<void> {
  const { data } = await db
    .from('masters_profiles')
    .select(`
      name, price_from, photos, is_active,
      districts(name),
      sub_districts(name),
      master_services(services(name))
    `)
    .eq('master_id', telegramId)
    .eq('bot_id', botId)
    .maybeSingle();

  if (!data) {
    await ctx.reply('Профиль не найден. Пройдите регистрацию заново.');
    return;
  }

  const raw = data as Record<string, unknown>;

  const districtName = (raw.districts as { name: string } | null)?.name ?? '';
  const subDistrictName = (raw.sub_districts as { name: string } | null)?.name ?? '';
  const location = subDistrictName
    ? `${districtName} → ${subDistrictName}`
    : districtName || '—';

  const services = (raw.master_services as Array<{ services: { name: string } }> ?? [])
    .map(ms => ms.services?.name)
    .filter(Boolean)
    .join(', ');

  const status = raw.is_active ? '✅ Активен' : '⏸ На паузе';

  const text =
    `👤 *${raw.name}*\n` +
    `💼 ${services}\n` +
    `📍 ${location || '—'}\n` +
    `💰 от ${raw.price_from} грн\n` +
    `${status}`;

  const keyboard = new InlineKeyboard()
    .text(raw.is_active ? '⏸ Пауза' : '✅ Активировать', 'toggle:active')
    .text('✏️ Фото', 'edit:photos')
    .row()
    .text('💰 Цена', 'edit:price')
    .text('📍 Район', 'edit:district')
    .row()
    .text('🔧 Услуги', 'edit:services');

  const photos = raw.photos as string[];

  if (photos && photos.length > 0) {
    // Отправляем все фото альбомом
    await ctx.replyWithMediaGroup(
      photos.map((fileId, i) => ({
        type: 'photo' as const,
        media: fileId,
        // Подпись только на первом фото
        ...(i === 0 ? { caption: text, parse_mode: 'Markdown' as const } : {})
      }))
    );
    // Кнопка отдельным сообщением (к медиагруппе нельзя прикрепить кнопки)
    await ctx.reply('Управление профилем:', { reply_markup: keyboard.toJSON() });
  } else {
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: keyboard.toJSON()
    });
  }
}

async function saveRole(
  botId: number,
  telegramId: number,
  role: 'client' | 'master'
): Promise<void> {
  const { error } = await db
    .from('users')
    .upsert(
      { bot_id: botId, telegram_id: telegramId, role },
      { onConflict: 'telegram_id,bot_id' }
    );

  if (error) console.error('[saveRole] Ошибка:', error.message);
}