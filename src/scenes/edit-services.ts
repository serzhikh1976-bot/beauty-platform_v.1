import { WizardScene, InlineKeyboard, ReplyKeyboard } from 'ultra-telegram-framework';
import type { SceneContext } from 'ultra-telegram-framework';
import { db } from '../db.js';

interface Service { id: number; name: string; }

const masterKeyboard = new ReplyKeyboard().text('👤 Мой профиль').resized(true);

async function getBotServices(botId: number): Promise<Service[]> {
  const { data, error } = await db
    .from('bot_services')
    .select('services(id, name)')
    .eq('bot_id', botId)
    .eq('is_enabled', true);

  if (error) return [];
  return (data as unknown as Array<{ services: Service }>).map(r => r.services).filter(Boolean);
}

async function getMasterServices(telegramId: number, botId: number): Promise<number[]> {
  const { data, error } = await db
    .from('master_services')
    .select('service_id')
    .eq('master_id', telegramId)
    .eq('bot_id', botId);

  if (error) return [];
  return (data as Array<{ service_id: number }>).map(r => r.service_id);
}

function buildServicesKeyboard(services: Service[], selected: number[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const s of services) {
    kb.text(`${selected.includes(s.id) ? '✅' : '☐'} ${s.name}`, `svc:${s.id}`).row();
  }
  kb.text('✔️ Готово', 'svc:done');
  return kb;
}

export function createEditServicesScene(botId: number) {
  return new WizardScene<SceneContext>(
    'edit_services',

    // Step 0: мультиселект услуг
    async (ctx) => {
      if (!ctx.callbackQuery) return;

      const data = ctx.callbackQuery.data;
      const telegramId = ctx.callbackQuery.from.id;
      const services = ctx.scene.state.services as Service[];
      const selected = ctx.scene.state.selected as number[];

      // Тогл услуги
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

      // Готово
      if (data === 'svc:done') {
        if (selected.length === 0) {
          return ctx.answerCallbackQuery('Выберите хотя бы одну услугу!');
        }

        await ctx.answerCallbackQuery();

        // Обновляем услуги в БД
        await db.from('master_services').delete()
          .eq('master_id', telegramId)
          .eq('bot_id', botId);

        await db.from('master_services').insert(
          selected.map(sid => ({ master_id: telegramId, bot_id: botId, service_id: sid }))
        );

        const names = services.filter(s => selected.includes(s.id)).map(s => s.name).join(', ');
        await ctx.replyWithKeyboard(`✅ Услуги обновлены: ${names}`, masterKeyboard);
        ctx.scene.leave();
      }
    }
  );
}