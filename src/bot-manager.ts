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

// Кнопка «Завершить диалог» — прикрепляется к КАЖДОМУ сообщению в чат-тоннеле,
// а не только к первому уведомлению, чтобы при нескольких активных чатах
// можно было завершить нужный диалог прямо под свежим сообщением от этого
// клиента, не листая историю в поисках самого первого уведомления.
const endChatKeyboard = (chatId: string) =>
  new InlineKeyboard().text('❌ Завершить диалог', `end_chat:${chatId}`);

// То же самое, но с кнопкой бана — показывается только мастеру
// (клиент не может банить мастера, поэтому у него только End)
const masterActionsKeyboard = (chatId: string) =>
  new InlineKeyboard()
    .text('❌ Завершить диалог', `end_chat:${chatId}`)
    .text('🚫 Забанить', `ban_client:${chatId}`);

function createBot(record: BotRecord): TelegramBot<SceneContext> {
  const bot = new TelegramBot<SceneContext>(new NodeApiClient(record.token));

  // Отправляет сообщение с кнопками и гарантирует, что кнопки останутся
  // только на САМОМ СВЕЖЕМ сообщении с этой стороны чата — предыдущее
  // сообщение с кнопками (если было) визуально очищается. Это защищает
  // от случайного клика по устаревшей кнопке где-то в истории переписки
  // (особенно важно для «Забанить» — иначе можно случайно повторно
  // забанить уже разбаненного клиента, кликнув по старому сообщению).
  async function sendTracked<T extends { message_id: number }>(
    chatId: string,
    side: 'master' | 'client',
    recipientId: number,
    send: () => Promise<T>
  ): Promise<T> {
    const column = side === 'master' ? 'last_master_button_msg_id' : 'last_client_button_msg_id';

    const { data: prev } = await db.from('active_chats').select(column).eq('id', chatId).maybeSingle();
    const prevMsgId = (prev as Record<string, unknown> | null)?.[column] as number | null | undefined;

    if (prevMsgId) {
      try {
        await bot.editMessageReplyMarkup(
          { chat_id: recipientId, message_id: prevMsgId },
          { reply_markup: { inline_keyboard: [] } }
        );
      } catch {
        // Сообщение могли удалить или оно устарело для редактирования (>48ч) — не критично
      }
    }

    const sent = await send();

    await db.from('active_chats').update({ [column]: sent.message_id }).eq('id', chatId);

    return sent;
  }

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

  // ── Анонимный чат ─────────────────────────────────────────────────────────

  // Клиент нажимает «💬 Написать мастеру»
  bot.action(/^chat:/, async (ctx) => {
    const clientId = ctx.callbackQuery!.from.id;
    const masterId = parseInt((ctx.callbackQuery!.data ?? '').replace('chat:', ''));
    await ctx.answerCallbackQuery();

    // Проверяем есть ли уже активный чат у клиента
    const { data: existing } = await db
      .from('active_chats')
      .select('id, master_id, masters_profiles(name)')
      .eq('client_id', clientId)
      .eq('bot_id', record.id)
      .eq('status', 'active')
      .maybeSingle();

    if (existing) {
      const raw = existing as Record<string, unknown>;
      const masterName = (raw.masters_profiles as { name: string } | null)?.name ?? 'мастером';
      return ctx.reply(`У вас уже есть активный чат с *${masterName}*. Сначала завершите его.`, { parse_mode: 'Markdown' });
    }

    // Проверяем что мастер активен
    const { data: master } = await db
      .from('masters_profiles')
      .select('name, is_active')
      .eq('master_id', masterId)
      .eq('bot_id', record.id)
      .maybeSingle();

    if (!master || !(master as Record<string, unknown>).is_active) {
      return ctx.reply('Этот мастер сейчас недоступен.');
    }

    // Проверяем не забанил ли мастер этого клиента
    const { data: blocked } = await db
      .from('blocked_clients')
      .select('id')
      .eq('bot_id', record.id)
      .eq('master_id', masterId)
      .eq('client_id', clientId)
      .maybeSingle();

    if (blocked) {
      return ctx.reply('🚫 Вы больше не можете писать этому мастеру.');
    }

    const masterName = (master as Record<string, unknown>).name as string;

    // Создаём чат
    const { data: chat, error } = await db
      .from('active_chats')
      .insert({
        bot_id: record.id,
        client_id: clientId,
        master_id: masterId,
        status: 'active',
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error || !chat) {
      return ctx.reply('Не удалось открыть чат. Попробуйте позже.');
    }

    const chatId = (chat as Record<string, unknown>).id as string;
    const masterKeyboardWithBan = masterActionsKeyboard(chatId);

    // Убираем кнопку «Написать мастеру» с карточки, по которой кликнул клиент —
    // иначе он может вернуться назад и нажать её повторно
    const cardMsg = ctx.callbackQuery!.message;
    if (cardMsg) {
      try {
        await bot.editMessageReplyMarkup(
          { chat_id: cardMsg.chat.id, message_id: cardMsg.message_id },
          { reply_markup: { inline_keyboard: [] } }
        );
      } catch {
        // не критично
      }
    }

    // Уведомляем клиента
    await sendTracked(chatId, 'client', clientId, () =>
      ctx.reply(
        `💬 Чат с мастером *${masterName}* открыт!\n\nПишите ваш вопрос:`,
        { parse_mode: 'Markdown', reply_markup: endChatKeyboard(chatId).toJSON() }
      )
    );

    // Уведомляем мастера и сохраняем message_id для маппинга Reply
    const notifMsg = await sendTracked(chatId, 'master', masterId, () =>
      bot.sendMessage(
        masterId,
        `💬 Новый клиент хочет с вами пообщаться!\n\nОтвечайте Reply на сообщения клиента чтобы он вас видел.`,
        { reply_markup: masterKeyboardWithBan.toJSON() }
      )
    );

    await db.from('chat_messages').insert({
      chat_id: chatId,
      message_id: notifMsg.message_id
    });
  });

  // Завершение чата
  // Шаг 1: просим подтверждение вместо мгновенного завершения —
  // защита от случайного нажатия
  bot.action(/^end_chat:/, async (ctx) => {
    const chatId = (ctx.callbackQuery!.data ?? '').replace('end_chat:', '');
    await ctx.answerCallbackQuery();

    const confirmKeyboard = new InlineKeyboard()
      .text('✅ Да, завершить', `end_chat_confirm:${chatId}`)
      .text('↩️ Отмена', `end_chat_cancel:${chatId}`);

    const msg = ctx.callbackQuery!.message;
    if (msg) {
      await bot.editMessageReplyMarkup(
        { chat_id: msg.chat.id, message_id: msg.message_id },
        { reply_markup: confirmKeyboard.toJSON() }
      );
    }
  });

  // Отмена — возвращаем обычную кнопку "Завершить диалог"
  bot.action(/^end_chat_cancel:/, async (ctx) => {
    const chatId = (ctx.callbackQuery!.data ?? '').replace('end_chat_cancel:', '');
    await ctx.answerCallbackQuery('Отменено');

    const msg = ctx.callbackQuery!.message;
    if (msg) {
      await bot.editMessageReplyMarkup(
        { chat_id: msg.chat.id, message_id: msg.message_id },
        { reply_markup: endChatKeyboard(chatId).toJSON() }
      );
    }
  });

  // Шаг 2: подтверждено — завершаем по-настоящему
  bot.action(/^end_chat_confirm:/, async (ctx) => {
    const userId = ctx.callbackQuery!.from.id;
    const chatId = (ctx.callbackQuery!.data ?? '').replace('end_chat_confirm:', '');
    await ctx.answerCallbackQuery();

    const { data: chat } = await db
      .from('active_chats')
      .select('client_id, master_id, status')
      .eq('id', chatId)
      .eq('bot_id', record.id)
      .maybeSingle();

    if (!chat || (chat as Record<string, unknown>).status !== 'active') {
      return ctx.reply('Чат уже завершён.');
    }

    const raw = chat as Record<string, unknown>;

    // Только реальный участник чата может его завершить
    if (userId !== raw.client_id && userId !== raw.master_id) {
      return;
    }

    // Убираем кнопки Да/Отмена с самого сообщения-подтверждения
    const confirmMsg = ctx.callbackQuery!.message;
    if (confirmMsg) {
      try {
        await bot.editMessageReplyMarkup(
          { chat_id: confirmMsg.chat.id, message_id: confirmMsg.message_id },
          { reply_markup: { inline_keyboard: [] } }
        );
      } catch {
        // не критично
      }
    }

    await db
      .from('active_chats')
      .update({ status: 'finished' })
      .eq('id', chatId)
      .eq('bot_id', record.id);

    const clientId = raw.client_id as number;
    const masterId = raw.master_id as number;

    // Имя мастера берём из его анкеты (это то имя, что видит клиент)
    const { data: masterProfile } = await db
      .from('masters_profiles')
      .select('name')
      .eq('master_id', masterId)
      .eq('bot_id', record.id)
      .maybeSingle();
    const masterName = (masterProfile as { name: string } | null)?.name ?? 'мастером';

    // Имя клиента в БД не хранится — берём текущее имя из Telegram
    let clientName = 'клиентом';
    try {
      const clientChat = await bot.getChat(clientId);
      if (clientChat.first_name) {
        clientName = clientChat.first_name;
      }
    } catch {
      // клиент мог заблокировать бота — оставляем дефолтное имя
    }

    // Уведомляем обоих, каждому — с именем собеседника
    await ctx.reply(
      userId === clientId
        ? `✅ Диалог с *${masterName}* завершён.`
        : `✅ Диалог с *${clientName}* завершён.`,
      { parse_mode: 'Markdown' }
    );

    const otherId = userId === clientId ? masterId : clientId;
    const otherMsg = userId === clientId
      ? `✅ Диалог с *${clientName}* завершён.`
      : `✅ Диалог с *${masterName}* завершён.`;

    await bot.sendMessage(otherId, otherMsg, { parse_mode: 'Markdown' });
  });

  // Бан клиента мастером
  // Шаг 1: просим подтверждение — действие серьёзное и необратимое
  bot.action(/^ban_client:/, async (ctx) => {
    const chatId = (ctx.callbackQuery!.data ?? '').replace('ban_client:', '');
    await ctx.answerCallbackQuery();

    const confirmKeyboard = new InlineKeyboard()
      .text('🚫 Да, забанить', `ban_client_confirm:${chatId}`)
      .text('↩️ Отмена', `ban_client_cancel:${chatId}`);

    const msg = ctx.callbackQuery!.message;
    if (msg) {
      await bot.editMessageReplyMarkup(
        { chat_id: msg.chat.id, message_id: msg.message_id },
        { reply_markup: confirmKeyboard.toJSON() }
      );
    }
  });

  // Отмена — возвращаем обычные кнопки мастера
  bot.action(/^ban_client_cancel:/, async (ctx) => {
    const chatId = (ctx.callbackQuery!.data ?? '').replace('ban_client_cancel:', '');
    await ctx.answerCallbackQuery('Отменено');

    const msg = ctx.callbackQuery!.message;
    if (msg) {
      await bot.editMessageReplyMarkup(
        { chat_id: msg.chat.id, message_id: msg.message_id },
        { reply_markup: masterActionsKeyboard(chatId).toJSON() }
      );
    }
  });

  // Шаг 2: подтверждено — баним по-настоящему
  bot.action(/^ban_client_confirm:/, async (ctx) => {
    const userId = ctx.callbackQuery!.from.id;
    const chatId = (ctx.callbackQuery!.data ?? '').replace('ban_client_confirm:', '');
    await ctx.answerCallbackQuery();

    const { data: chat } = await db
      .from('active_chats')
      .select('client_id, master_id, status')
      .eq('id', chatId)
      .eq('bot_id', record.id)
      .maybeSingle();

    if (!chat) {
      return ctx.reply('Чат не найден.');
    }

    const raw = chat as Record<string, unknown>;
    const clientId = raw.client_id as number;
    const masterId = raw.master_id as number;

    // Банить может только сам мастер этого чата
    if (userId !== masterId) {
      return;
    }

    // Убираем кнопки Да/Отмена с самого сообщения-подтверждения
    const confirmMsg = ctx.callbackQuery!.message;
    if (confirmMsg) {
      try {
        await bot.editMessageReplyMarkup(
          { chat_id: confirmMsg.chat.id, message_id: confirmMsg.message_id },
          { reply_markup: { inline_keyboard: [] } }
        );
      } catch {
        // не критично
      }
    }

    // Если чат ещё активен — заодно завершаем его
    if (raw.status === 'active') {
      await db
        .from('active_chats')
        .update({ status: 'finished' })
        .eq('id', chatId)
        .eq('bot_id', record.id);
    }

    // Записываем бан. Если пара уже забанена (повторный клик, гонка) —
    // просто игнорируем конфликт уникальности.
    const { error: banError } = await db.from('blocked_clients').insert({
      bot_id: record.id,
      master_id: masterId,
      client_id: clientId
    });

    if (banError && banError.code !== '23505') {
      console.error(`[${record.city_name}] Ошибка записи бана:`, banError.message);
      return ctx.reply('⚠️ Не удалось забанить клиента. Попробуйте ещё раз.');
    }

    await ctx.reply('🚫 Клиент забанен. Он больше не сможет вам писать.');
    await bot.sendMessage(clientId, '🚫 Мастер ограничил переписку с вами. Вы больше не можете писать этому мастеру.');
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

  // ── Универсальный роутер сообщений чата ──────────────────────────────────

  // Если сообщение не попало ни в один активный чат: зарегистрированному
  // клиенту/мастеру говорим "нет активных чатов", а не "не понимаю команду" —
  // это два разных по смыслу случая.
  async function noActiveChatMessage(userId: number): Promise<string> {
    const { data: userRow } = await db
      .from('users')
      .select('role')
      .eq('bot_id', record.id)
      .eq('telegram_id', userId)
      .maybeSingle();

    if ((userRow as { role: string } | null)?.role) {
      return '💬 У вас нет активных чатов.';
    }

    return 'Не понимаю эту команду 🤔\n/help — список команд';
  }

  async function routeChatMessage(
    userId: number,
    fromMsg: { first_name?: string } | undefined,
    text: string | null,
    photoFileId: string | null
  ): Promise<boolean> {
    // Клиент → ищем его активный чат
    const { data: clientChat } = await db
      .from('active_chats')
      .select('id, master_id')
      .eq('client_id', userId)
      .eq('bot_id', record.id)
      .eq('status', 'active')
      .maybeSingle();

    if (clientChat) {
      const raw = clientChat as Record<string, unknown>;
      const clientName = fromMsg?.first_name ?? 'Клиент';

      if (photoFileId) {
        const sentMsg = await sendTracked(raw.id as string, 'master', raw.master_id as number, () =>
          bot.sendPhoto(
            raw.master_id as number,
            photoFileId,
            {
              caption: `📸 *${clientName}*`,
              parse_mode: 'Markdown',
              reply_markup: masterActionsKeyboard(raw.id as string).toJSON()
            }
          )
        );
        await db.from('chat_messages').insert({ chat_id: raw.id, message_id: sentMsg.message_id });
        await db.from('chat_message_log').insert({ chat_id: raw.id, sender_id: userId, photo_ids: [photoFileId] });
      } else if (text) {
        const sentMsg = await sendTracked(raw.id as string, 'master', raw.master_id as number, () =>
          bot.sendMessage(
            raw.master_id as number,
            `💬 *${clientName}:* ${text}`,
            {
              parse_mode: 'Markdown',
              reply_markup: masterActionsKeyboard(raw.id as string).toJSON()
            }
          )
        );
        await db.from('chat_messages').insert({ chat_id: raw.id, message_id: sentMsg.message_id });
        await db.from('chat_message_log').insert({ chat_id: raw.id, sender_id: userId, text });
      }

      await db.from('active_chats').update({ updated_at: new Date().toISOString() }).eq('id', raw.id);
      return true;
    }

    // Мастер → проверяем его активные чаты
    const { data: masterChats } = await db
      .from('active_chats')
      .select('id, client_id')
      .eq('master_id', userId)
      .eq('bot_id', record.id)
      .eq('status', 'active');

    if (masterChats && masterChats.length > 0) {
      let targetChat: Record<string, unknown> | null = null;

      if (photoFileId === null) {
        // Для текста пробуем найти по reply (только для текстовых сообщений)
      }

      if (!targetChat && masterChats.length === 1) {
        targetChat = masterChats[0] as Record<string, unknown>;
      }

      if (targetChat) {
        const { data: masterProfile } = await db
          .from('masters_profiles')
          .select('name')
          .eq('master_id', userId)
          .eq('bot_id', record.id)
          .maybeSingle();

        const masterName = (masterProfile as { name: string } | null)?.name ?? 'Мастер';

        if (photoFileId) {
          await sendTracked(targetChat.id as string, 'client', targetChat.client_id as number, () =>
            bot.sendPhoto(
              targetChat.client_id as number,
              photoFileId,
              {
                caption: `📸 *${masterName}*`,
                parse_mode: 'Markdown',
                reply_markup: endChatKeyboard(targetChat.id as string).toJSON()
              }
            )
          );
          await db.from('chat_message_log').insert({ chat_id: targetChat.id, sender_id: userId, photo_ids: [photoFileId] });
        } else if (text) {
          await sendTracked(targetChat.id as string, 'client', targetChat.client_id as number, () =>
            bot.sendMessage(
              targetChat.client_id as number,
              `💼 *${masterName}:* ${text}`,
              {
                parse_mode: 'Markdown',
                reply_markup: endChatKeyboard(targetChat.id as string).toJSON()
              }
            )
          );
          await db.from('chat_message_log').insert({ chat_id: targetChat.id, sender_id: userId, text });
        }

        await db.from('active_chats').update({ updated_at: new Date().toISOString() }).eq('id', targetChat.id);
        return true;
      }
      return true; // в чате но не знаем кому — не показываем fallback
    }

    return false; // не в чате
  }

  // Текстовые сообщения
  bot.on('text', async (ctx) => {
    const userId = ctx.message && 'from' in ctx.message ? ctx.message.from?.id : undefined;
    if (!userId) return;

    const text = ctx.text ?? '';
    const fromMsg = ctx.message && 'from' in ctx.message ? ctx.message.from : undefined;

    // Проверяем reply для мастера с несколькими чатами
    const msg = ctx.message as unknown as Record<string, unknown>;
    const replyToId = (msg?.reply_to_message as Record<string, unknown> | undefined)
      ?.message_id as number | undefined;

    if (replyToId) {
      const { data: chatMsg, error: chatMsgError } = await db
        .from('chat_messages')
        .select('chat_id, active_chats!inner(id, client_id, status, bot_id)')
        .eq('message_id', replyToId)
        .eq('active_chats.bot_id', record.id)
        .maybeSingle();

      if (chatMsgError) {
        console.error(`[${record.city_name}] Ошибка поиска chat_messages:`, chatMsgError.message);
      }

      const found = (chatMsg as Record<string, unknown> | null)
        ?.active_chats as Record<string, unknown> | null;

      if (found?.status === 'active') {
        const { data: masterProfile } = await db
          .from('masters_profiles')
          .select('name')
          .eq('master_id', userId)
          .eq('bot_id', record.id)
          .maybeSingle();

        const masterName = (masterProfile as { name: string } | null)?.name ?? 'Мастер';

        await sendTracked(found.id as string, 'client', found.client_id as number, () =>
          bot.sendMessage(
            found.client_id as number,
            `💼 *${masterName}:* ${text}`,
            {
              parse_mode: 'Markdown',
              reply_markup: endChatKeyboard(found.id as string).toJSON()
            }
          )
        );
        await db.from('chat_message_log').insert({ chat_id: found.id, sender_id: userId, text });
        await db.from('active_chats').update({ updated_at: new Date().toISOString() }).eq('id', found.id);
        return;
      }
    }

    // --- ДОБАВЛЕННАЯ ПРОВЕРКА ДЛЯ МАСТЕРА С НЕСКОЛЬКИМИ ЧАТАМИ ---
    // Если reply не было (или не помог), проверим, не пытается ли мастер с несколькими чатами отправить сообщение без reply
    if (!replyToId) {
      const { data: masterChats } = await db
        .from('active_chats')
        .select('id')
        .eq('master_id', userId)
        .eq('bot_id', record.id)
        .eq('status', 'active');

      if (masterChats && masterChats.length > 1) {
        await ctx.reply(
          '⚠️ У вас несколько активных чатов. Чтобы ответить конкретному клиенту, используйте Reply (ответ) на его сообщение.'
        );
        return; // не идём дальше
      }
    }
    // --- КОНЕЦ ДОБАВЛЕННОЙ ПРОВЕРКИ ---

    const handled = await routeChatMessage(userId, fromMsg, text, null);
    if (!handled) {
      await ctx.reply(await noActiveChatMessage(userId));
    }
  });

  // Фото
  bot.on('photo', async (ctx) => {
    const userId = ctx.message && 'from' in ctx.message ? ctx.message.from?.id : undefined;
    if (!userId) return;

    const photoSizes = ctx.message && 'photo' in ctx.message
      ? (ctx.message as unknown as Record<string, unknown>).photo as Array<{ file_id: string }>
      : undefined;

    if (!photoSizes || photoSizes.length === 0) return;

    const fileId = photoSizes[photoSizes.length - 1].file_id;
    const fromMsg = ctx.message && 'from' in ctx.message ? ctx.message.from : undefined;

    // --- ДОБАВЛЕННАЯ ПРОВЕРКА ДЛЯ МАСТЕРА С НЕСКОЛЬКИМИ ЧАТАМИ ---
    // Проверяем, не пытается ли мастер с несколькими чатами отправить фото без reply
    const { data: masterChats } = await db
      .from('active_chats')
      .select('id')
      .eq('master_id', userId)
      .eq('bot_id', record.id)
      .eq('status', 'active');

    if (masterChats && masterChats.length > 1) {
      await ctx.reply(
        '⚠️ У вас несколько активных чатов. Чтобы отправить фото конкретному клиенту, используйте Reply (ответ) на его сообщение.'
      );
      return; // не отправляем фото
    }
    // --- КОНЕЦ ДОБАВЛЕННОЙ ПРОВЕРКИ ---

    const handled = await routeChatMessage(userId, fromMsg, null, fileId);
    if (!handled) {
      await ctx.reply(await noActiveChatMessage(userId));
    }
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