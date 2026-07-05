import { WizardScene, ReplyKeyboard } from 'ultra-telegram-framework';
import type { SceneContext } from 'ultra-telegram-framework';
import { db } from '../db.js';

const masterKeyboard = new ReplyKeyboard().text('👤 Мой профиль').resized(true);

export function createEditPhotosScene(botId: number) {
  return new WizardScene<SceneContext>(
    'edit_photos',

    // Step 0: собираем новые фото
    async (ctx) => {
      if (!ctx.message && !ctx.text) return;

      const telegramId = ctx.message && 'from' in ctx.message
        ? ctx.message.from?.id
        : undefined;

      if (!telegramId) return ctx.scene.leave();

      // /done — сохраняем
      if (ctx.text === '/done') {
        const photos = ctx.scene.state.photos as string[] ?? [];

        if (photos.length === 0) {
          return ctx.reply('Отправьте хотя бы одно фото, или /skip чтобы удалить все фото.');
        }

        await savePhotos(telegramId, botId, photos);
        await ctx.replyWithKeyboard(
          `✅ Фото обновлены (${photos.length} шт.)`,
          masterKeyboard
        );
        return ctx.scene.leave();
      }

      // /skip — удаляем все фото
      if (ctx.text === '/skip') {
        await savePhotos(telegramId, botId, []);
        await ctx.replyWithKeyboard('✅ Все фото удалены.', masterKeyboard);
        return ctx.scene.leave();
      }

      // Получаем фото
      const photoSizes = ctx.message && 'photo' in ctx.message
        ? ctx.message.photo
        : undefined;

      if (photoSizes && photoSizes.length > 0) {
        const photos = (ctx.scene.state.photos as string[] | undefined) ?? [];
        const fileId = photoSizes[photoSizes.length - 1].file_id;
        photos.push(fileId);
        ctx.scene.state.photos = photos;

        if (photos.length >= 5) {
          await savePhotos(telegramId, botId, photos);
          await ctx.replyWithKeyboard('✅ Фото обновлены (5/5)!', masterKeyboard);
          return ctx.scene.leave();
        }

        await ctx.reply(`📸 Фото ${photos.length}/5. Ещё или /done:`);
        return;
      }

      await ctx.reply('Отправьте фото, /done чтобы сохранить, или /skip чтобы удалить все:');
    }
  );
}

async function savePhotos(
  telegramId: number,
  botId: number,
  photos: string[]
): Promise<void> {
  const { error } = await db
    .from('masters_profiles')
    .update({ photos })
    .eq('master_id', telegramId)
    .eq('bot_id', botId);

  if (error) console.error('[editPhotos] Ошибка:', error.message);
}