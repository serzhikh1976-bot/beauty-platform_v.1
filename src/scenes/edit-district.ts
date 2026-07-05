import { WizardScene, ReplyKeyboard } from 'ultra-telegram-framework';
import type { SceneContext } from 'ultra-telegram-framework';
import { db } from '../db.js';
import { getSubDistricts, buildListKeyboard } from '../districts.js';

const masterKeyboard = new ReplyKeyboard().text('👤 Мой профиль').resized(true);

export function createEditDistrictScene(botId: number) {
  return new WizardScene<SceneContext>(
    'edit_district',

    // Step 0: получаем выбранный район
    async (ctx) => {
      if (!ctx.callbackQuery) return;

      const data = ctx.callbackQuery.data;
      const telegramId = ctx.callbackQuery.from.id;

      if (data?.startsWith('district:')) {
        const districtId = parseInt(data.replace('district:', ''));
        ctx.scene.state.district_id = districtId;
        await ctx.answerCallbackQuery();

        const subDistricts = await getSubDistricts(districtId);

        if (subDistricts.length === 0) {
          // Нет подрайонов — сохраняем сразу
          await saveDistrict(telegramId, botId, districtId, null);
          await ctx.replyWithKeyboard('✅ Район обновлён!', masterKeyboard);
          return ctx.scene.leave();
        }

        // Есть подрайоны — показываем
        await ctx.reply(
          '📍 Уточните подрайон:',
          { reply_markup: buildListKeyboard(subDistricts, 'subdistrict').toJSON() }
        );
        ctx.scene.next();
      }
    },

    // Step 1: получаем подрайон
    async (ctx) => {
      if (!ctx.callbackQuery) return;

      const data = ctx.callbackQuery.data;
      const telegramId = ctx.callbackQuery.from.id;

      if (data?.startsWith('subdistrict:')) {
        const subDistrictId = parseInt(data.replace('subdistrict:', ''));
        await ctx.answerCallbackQuery();
        await saveDistrict(telegramId, botId, ctx.scene.state.district_id as number, subDistrictId);
        await ctx.replyWithKeyboard('✅ Район и подрайон обновлены!', masterKeyboard);
        ctx.scene.leave();
      }
    }
  );
}

async function saveDistrict(
  telegramId: number,
  botId: number,
  districtId: number,
  subDistrictId: number | null
): Promise<void> {
  const { error } = await db
    .from('masters_profiles')
    .update({ district_id: districtId, sub_district_id: subDistrictId })
    .eq('master_id', telegramId)
    .eq('bot_id', botId);

  if (error) console.error('[editDistrict] Ошибка:', error.message);
}