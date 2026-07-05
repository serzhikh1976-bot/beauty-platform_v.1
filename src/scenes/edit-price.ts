import { WizardScene } from 'ultra-telegram-framework';
import type { SceneContext } from 'ultra-telegram-framework';
import { db } from '../db.js';

export function createEditPriceScene(botId: number) {
  return new WizardScene<SceneContext>(
    'edit_price',

    // Step 0: получаем новую цену
    async (ctx) => {
      if (!ctx.text) return;

      const price = parseInt(ctx.text.trim());
      if (isNaN(price) || price < 0) {
        return ctx.reply('Пожалуйста, введите цену числом (например: 500):');
      }

      const telegramId = ctx.message && 'from' in ctx.message
        ? ctx.message.from?.id
        : undefined;

      if (!telegramId) return ctx.scene.leave();

      const { error } = await db
        .from('masters_profiles')
        .update({ price_from: price })
        .eq('master_id', telegramId)
        .eq('bot_id', botId);

      if (error) {
        console.error('[editPrice] Ошибка:', error.message);
        await ctx.reply('❌ Ошибка сохранения. Попробуйте позже.');
      } else {
        await ctx.reply(`✅ Цена обновлена: от ${price} грн`);
      }

      ctx.scene.leave();
    }
  );
}