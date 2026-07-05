import { WizardScene, InlineKeyboard, ReplyKeyboard } from 'ultra-telegram-framework';
import type { SceneContext } from 'ultra-telegram-framework';
import { db } from '../db.js';

interface Service { id: number; name: string; }
interface District { id: number; name: string; }
interface SubDistrict { id: number; name: string; }

async function getBotServices(botId: number): Promise<Service[]> {
  const { data, error } = await db
    .from('bot_services')
    .select('services(id, name)')
    .eq('bot_id', botId)
    .eq('is_enabled', true);

  if (error) return [];
  return (data as unknown as Array<{ services: Service }>).map(r => r.services).filter(Boolean);
}

async function getDistricts(botId: number): Promise<District[]> {
  const { data, error } = await db
    .from('districts')
    .select('id, name')
    .eq('bot_id', botId)
    .order('id');

  if (error) return [];
  return (data as District[]) ?? [];
}

async function getSubDistricts(districtId: number): Promise<SubDistrict[]> {
  const { data, error } = await db
    .from('sub_districts')
    .select('id, name')
    .eq('district_id', districtId)
    .order('id');

  if (error) return [];
  return (data as SubDistrict[]) ?? [];
}

function buildServicesKeyboard(services: Service[], selected: number[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const s of services) {
    kb.text(`${selected.includes(s.id) ? '✅' : '☐'} ${s.name}`, `svc:${s.id}`).row();
  }
  kb.text('✔️ Готово', 'svc:done');
  return kb;
}

function buildListKeyboard(items: { id: number; name: string }[], prefix: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const item of items) {
    kb.text(item.name, `${prefix}:${item.id}`).row();
  }
  return kb;
}

export function createMasterRegistrationScene(botId: number) {
  return new WizardScene<SceneContext>(
    'master_registration',

    // Step 0: ждём текст — имя
    async (ctx) => {
      if (!ctx.text) return; // защита от callback-триггера scene.next()

      const name = ctx.text.trim();
      if (name.length < 2) {
        return ctx.reply('Пожалуйста, введите имя (минимум 2 символа):');
      }
      ctx.scene.state.name = name;
      ctx.scene.state.selected_services = [];

      const services = await getBotServices(botId);
      if (services.length === 0) {
        await ctx.reply('⚠️ Услуги не настроены. Обратитесь к администратору.');
        return ctx.scene.leave();
      }
      ctx.scene.state.services = services;

      await ctx.reply(
        `Отлично, ${name}! 👋\n\nВыберите ваши услуги (можно несколько):`,
        { reply_markup: buildServicesKeyboard(services, []).toJSON() }
      );
      ctx.scene.next();
    },

    // Step 1: ждём callback — мультиселект услуг
    async (ctx) => {
      if (!ctx.callbackQuery) return; // защита от text-триггера

      const data = ctx.callbackQuery.data;
      const services = ctx.scene.state.services as Service[];
      const selected = ctx.scene.state.selected_services as number[];

      if (data?.startsWith('svc:') && data !== 'svc:done') {
        const id = parseInt(data.replace('svc:', ''));
        const idx = selected.indexOf(id);
        if (idx === -1) selected.push(id);
        else selected.splice(idx, 1);

        await ctx.editReplyMarkup(
          buildServicesKeyboard(services, selected).toJSON() as Parameters<typeof ctx.editReplyMarkup>[0]
        );
        return ctx.answerCallbackQuery();
      }

      if (data === 'svc:done') {
        if (selected.length === 0) {
          return ctx.answerCallbackQuery('Выберите хотя бы одну услугу!');
        }
        await ctx.answerCallbackQuery();

        const districts = await getDistricts(botId);
        if (districts.length === 0) {
          await ctx.reply('⚠️ Районы не настроены. Обратитесь к администратору.');
          return ctx.scene.leave();
        }
        ctx.scene.state.districts = districts;

        await ctx.reply(
          '📍 Выберите ваш район:',
          { reply_markup: buildListKeyboard(districts, 'district').toJSON() }
        );
        ctx.scene.next();
      }
    },

    // Step 2: ждём callback — район и подрайон
    async (ctx) => {
      if (!ctx.callbackQuery) return; // защита от text-триггера

      const data = ctx.callbackQuery.data;

      if (data?.startsWith('district:')) {
        const districtId = parseInt(data.replace('district:', ''));
        ctx.scene.state.district_id = districtId;
        await ctx.answerCallbackQuery();

        const subDistricts = await getSubDistricts(districtId);

        if (subDistricts.length === 0) {
          // Подрайонов нет — сразу к цене
          await ctx.reply('💰 Укажите минимальную цену ваших услуг (в грн):');
          ctx.scene.next();
          return;
        }

        // Есть подрайоны — показываем
        ctx.scene.state.sub_districts = subDistricts;
        await ctx.reply(
          '📍 Уточните подрайон:',
          { reply_markup: buildListKeyboard(subDistricts, 'subdistrict').toJSON() }
        );
        return;
      }

      if (data?.startsWith('subdistrict:')) {
        const subDistrictId = parseInt(data.replace('subdistrict:', ''));
        ctx.scene.state.sub_district_id = subDistrictId;
        await ctx.answerCallbackQuery();
        await ctx.reply('💰 Укажите минимальную цену ваших услуг (в грн):');
        ctx.scene.next();
      }
    },

    // Step 3: ждём текст — цена
    async (ctx) => {
      if (!ctx.text) return; // защита от callback-триггера scene.next()

      const price = parseInt(ctx.text.trim());
      if (isNaN(price) || price < 0) {
        return ctx.reply('Пожалуйста, введите цену числом (например: 300):');
      }
      ctx.scene.state.price_from = price;
      await ctx.reply('✅ Цена сохранена!\n\nТеперь отправьте фото ваших работ (до 5 штук).\nКогда закончите — нажмите /done');
      ctx.scene.next();
    },

    // Step 4: ждём фото, после /done или /skip — сохраняем профиль
    async (ctx) => {
      const isDone = ctx.text === '/done';
      const isSkip = ctx.text === '/skip';

      // Получаем фото
      if (!isDone && !isSkip) {
        const photoSizes = ctx.message && 'photo' in ctx.message ? ctx.message.photo : undefined;
        if (photoSizes && photoSizes.length > 0) {
          const photos = (ctx.scene.state.photos as string[] | undefined) ?? [];
          const fileId = photoSizes[photoSizes.length - 1].file_id;
          photos.push(fileId);
          ctx.scene.state.photos = photos;

          if (photos.length >= 5) {
            // Лимит достигнут — автоматически завершаем
            await ctx.reply('📸 5/5 фото получено. Сохраняем профиль...');
            // Падаем вниз к сохранению
          } else {
            await ctx.reply(`📸 Фото ${photos.length}/5 получено. Ещё или /done:`);
            return;
          }
        } else {
          return ctx.reply('Отправьте фото или /done:');
        }
      }

      // /skip — обнуляем фото
      if (isSkip) ctx.scene.state.photos = [];

      const photos = ctx.scene.state.photos as string[] ?? [];

      // Получаем telegram_id из текстового сообщения
      const telegramId = ctx.message && 'from' in ctx.message
        ? ctx.message.from?.id
        : undefined;

      if (!telegramId) {
        await ctx.reply('❌ Не удалось определить пользователя. Попробуйте /start заново.');
        return ctx.scene.leave();
      }

      const state = ctx.scene.state;

      // Сохраняем профиль
      const { error: profileError } = await db
        .from('masters_profiles')
        .upsert({
          master_id:        telegramId,
          bot_id:           botId,
          name:             state.name,
          price_from:       state.price_from,
          district_id:      state.district_id ?? null,
          sub_district_id:  state.sub_district_id ?? null,
          photos:           photos,
          is_active:        true,
          trial_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        }, { onConflict: 'master_id,bot_id' });

      if (profileError) {
        console.error('[saveProfile] Ошибка:', profileError.message);
        await ctx.reply('❌ Ошибка сохранения. Попробуйте позже.');
        return ctx.scene.leave();
      }

      // Сохраняем услуги
      const selectedServices = state.selected_services as number[];
      if (selectedServices.length > 0) {
        await db.from('master_services')
          .delete()
          .eq('master_id', telegramId)
          .eq('bot_id', botId);

        await db.from('master_services').insert(
          selectedServices.map(sid => ({
            master_id:  telegramId,
            bot_id:     botId,
            service_id: sid
          }))
        );
      }

      const serviceNames = (state.services as Service[])
        .filter(s => selectedServices.includes(s.id))
        .map(s => s.name)
        .join(', ');

      const masterKeyboard = new ReplyKeyboard()
        .text('👤 Мой профиль')
        .resized(true);

      await ctx.replyWithKeyboard(
        `🎉 Профиль создан!\n\n` +
        `👤 ${state.name}\n` +
        `💼 ${serviceNames}\n` +
        `💰 от ${state.price_from} грн\n` +
        `📸 Фото: ${photos.length}\n\n` +
        `✅ Триал активен на 30 дней.\n` +
        `Клиенты уже могут вас найти!`,
        masterKeyboard
      );

      ctx.scene.leave();
    }
  );
}