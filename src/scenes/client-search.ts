import { WizardScene, InlineKeyboard } from 'ultra-telegram-framework';
import type { SceneContext } from 'ultra-telegram-framework';
import { db } from '../db.js';

interface Service { id: number; name: string; }
interface District { id: number; name: string; }
interface SubDistrict { id: number; name: string; }

// Услуги у которых есть хотя бы один активный мастер в этом боте
export async function getServicesWithMasters(botId: number): Promise<Service[]> {
  const { data } = await db
    .from('master_services')
    .select('service_id, services(id, name)')
    .eq('bot_id', botId)
    .in(
      'master_id',
      await getActiveMasterIds(botId)
    );

  if (!data) return [];

  // Дедупликация по service_id
  const map = new Map<number, Service>();
  for (const row of (data as unknown) as Array<{ service_id: number; services: Service }>) {
    if (row.services && !map.has(row.service_id)) {
      map.set(row.service_id, row.services);
    }
  }
  return [...map.values()];
}

// Районы где есть активные мастера с выбранной услугой
async function getDistrictsWithMasters(botId: number, serviceId: number): Promise<District[]> {
  const masterIds = await getMasterIdsByService(botId, serviceId);
  if (masterIds.length === 0) return [];

  const { data } = await db
    .from('masters_profiles')
    .select('district_id, districts(id, name)')
    .eq('bot_id', botId)
    .in('master_id', masterIds)
    .not('district_id', 'is', null);

  if (!data) return [];

  const map = new Map<number, District>();
  for (const row of (data as unknown) as Array<{ district_id: number; districts: District }>) {
    if (row.districts && !map.has(row.district_id)) {
      map.set(row.district_id, row.districts);
    }
  }
  return [...map.values()];
}

// Подрайоны где есть активные мастера с выбранной услугой в выбранном районе
async function getSubDistrictsWithMasters(
  botId: number,
  serviceId: number,
  districtId: number
): Promise<SubDistrict[]> {
  const masterIds = await getMasterIdsByService(botId, serviceId);
  if (masterIds.length === 0) return [];

  const { data } = await db
    .from('masters_profiles')
    .select('sub_district_id, sub_districts(id, name)')
    .eq('bot_id', botId)
    .eq('district_id', districtId)
    .in('master_id', masterIds)
    .not('sub_district_id', 'is', null);

  if (!data) return [];

  const map = new Map<number, SubDistrict>();
  for (const row of (data as unknown) as Array<{ sub_district_id: number; sub_districts: SubDistrict }>) {
    if (row.sub_districts && !map.has(row.sub_district_id)) {
      map.set(row.sub_district_id, row.sub_districts);
    }
  }
  return [...map.values()];
}

// Активные master_id для бота
async function getActiveMasterIds(botId: number): Promise<number[]> {
  const { data } = await db
    .from('masters_profiles')
    .select('master_id')
    .eq('bot_id', botId)
    .eq('is_active', true);

  return (data as Array<{ master_id: number }> ?? []).map(r => r.master_id);
}

// master_id с нужной услугой
async function getMasterIdsByService(botId: number, serviceId: number): Promise<number[]> {
  const activeMasterIds = await getActiveMasterIds(botId);
  if (activeMasterIds.length === 0) return [];

  const { data } = await db
    .from('master_services')
    .select('master_id')
    .eq('bot_id', botId)
    .eq('service_id', serviceId)
    .in('master_id', activeMasterIds);

  return (data as Array<{ master_id: number }> ?? []).map(r => r.master_id);
}

function buildKeyboard(items: { id: number; name: string }[], prefix: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const item of items) {
    kb.text(item.name, `${prefix}:${item.id}`).row();
  }
  return kb;
}

// Убирает кнопки с сообщения предыдущего шага визарда — иначе клиент может
// вернуться в историю и нажать на уже пройденный шаг (например, старую
// кнопку выбора услуги после того как уже выбрал район), и это собьёт
// состояние сцены. История не должна влиять на настоящее.
async function clearButtons(ctx: SceneContext): Promise<void> {
  const msg = ctx.callbackQuery?.message;
  if (!msg) return;
  try {
    await ctx.api.editMessageReplyMarkup({
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      reply_markup: { inline_keyboard: [] }
    });
  } catch {
    // сообщение удалено или устарело для редактирования — не критично
  }
}

export function createClientSearchScene(botId: number) {
  return new WizardScene<SceneContext>(
    'client_search',

    // Step 0: получаем услугу → показываем районы
    async (ctx) => {
      if (!ctx.callbackQuery) return;

      const data = ctx.callbackQuery.data;
      if (!data?.startsWith('search_svc:')) return;

      const [, svcIdStr, ...nameParts] = data.split(':');
      const serviceId = parseInt(svcIdStr);
      ctx.scene.state.service_id = serviceId;

      // Сохраняем название услуги для итогового сообщения
      const services = ctx.scene.state.services_list as Array<{ id: number; name: string }> ?? [];
      const svcName = services.find(s => s.id === serviceId)?.name ?? '';
      ctx.scene.state.service_name = svcName;

      await ctx.answerCallbackQuery();
      await clearButtons(ctx);

      const districts = await getDistrictsWithMasters(botId, serviceId);
      if (districts.length === 0) {
        await ctx.reply('😔 По этой услуге мастеров пока нет.');
        return ctx.scene.leave();
      }

      await ctx.reply(
        '📍 Выберите район:',
        { reply_markup: buildKeyboard(districts, 'search_district').toJSON() }
      );
      ctx.scene.next();
    },

    // Step 1: получаем район → подрайон → показываем мастеров
    async (ctx) => {
      if (!ctx.callbackQuery) return;

      const data = ctx.callbackQuery.data;
      const serviceId = ctx.scene.state.service_id as number;

      if (data?.startsWith('search_district:')) {
        const districtId = parseInt(data.replace('search_district:', ''));
        ctx.scene.state.district_id = districtId;
        await ctx.answerCallbackQuery();
        await clearButtons(ctx);

        // Находим название района из списка
        const districts = await getDistrictsWithMasters(botId, serviceId);
        const districtName = districts.find(d => d.id === districtId)?.name ?? '';
        ctx.scene.state.district_name = districtName;

        const subDistricts = await getSubDistrictsWithMasters(botId, serviceId, districtId);

        if (subDistricts.length > 0) {
          await ctx.reply(
            '📍 Уточните подрайон:',
            { reply_markup: buildKeyboard(subDistricts, 'search_sub').toJSON() }
          );
          return;
        }

        const serviceName = ctx.scene.state.service_name as string ?? '';
        await showMasters(ctx, botId, serviceId, districtId, null, serviceName, districtName);
        return;
      }

      if (data?.startsWith('search_sub:')) {
        const subDistrictId = parseInt(data.replace('search_sub:', ''));
        const districtId = ctx.scene.state.district_id as number;
        const districtName = ctx.scene.state.district_name as string ?? '';
        const serviceName = ctx.scene.state.service_name as string ?? '';
        await ctx.answerCallbackQuery();
        await clearButtons(ctx);

        await showMasters(ctx, botId, serviceId, districtId, subDistrictId, serviceName, districtName);
      }
    }
  );
}

async function showMasters(
  ctx: SceneContext,
  botId: number,
  serviceId: number,
  districtId: number,
  subDistrictId: number | null,
  serviceName: string,
  locationName: string
): Promise<void> {
  const masterIds = await getMasterIdsByService(botId, serviceId);

  let query = db
    .from('masters_profiles')
    .select(`
      master_id, name, price_from, photos,
      districts(name),
      sub_districts(name),
      master_services(services(name))
    `)
    .eq('bot_id', botId)
    .eq('is_active', true)
    .in('master_id', masterIds);

  if (subDistrictId) {
    query = query.eq('sub_district_id', subDistrictId);
  } else {
    query = query.eq('district_id', districtId);
  }

  const { data: masters } = await query;

  if (!masters || masters.length === 0) {
    await ctx.reply('😔 Мастеров не найдено. Попробуйте /search заново.');
    return ctx.scene.leave();
  }

  // Показываем список мастеров кнопками
  const keyboard = new InlineKeyboard();
  for (const master of masters as Record<string, unknown>[]) {
    const services = (master.master_services as Array<{ services: { name: string } }> ?? [])
      .map(ms => ms.services?.name)
      .filter(Boolean)
      .join(', ');

    const label = `${master.name} · ${services} · от ${master.price_from} грн`;
    keyboard.text(label, `master_card:${master.master_id}`).row();
  }

  await ctx.reply(
    `📋 *${serviceName}* · *${locationName}* · ${masters.length} мастеров\n\nВыберите мастера:`,
    { parse_mode: 'Markdown', reply_markup: keyboard.toJSON() }
  );

  ctx.scene.leave();
}