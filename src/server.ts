import Fastify from 'fastify';
import type { Update } from 'ultra-telegram-framework';
import { getBot, cacheSize } from './bot-manager.js';
import { getAdminBot, getAdminBotUuid } from './admin-bot.js';

export function buildServer() {
  const app = Fastify({ logger: false });

  // Health check — для Railway/VPS и проверки что сервер жив
  app.get('/', async () => ({
    ok: true,
    bots_in_cache: cacheSize()
  }));

  // Единственная точка входа для всех ботов
  // uuid = поле number из таблицы bots, либо ADMIN_BOT_UUID для админ-бота
  app.post('/webhook/:uuid', async (request, reply) => {
    const { uuid } = request.params as { uuid: string };

    // Всегда 200 — Telegram не должен делать ретраи
    try {
      // Админ-бот не лежит в таблице bots — отдельная точка входа
      if (uuid === getAdminBotUuid()) {
        const adminBot = getAdminBot();
        if (adminBot) {
          await adminBot.handleUpdate(request.body as Update);
        }
        return reply.code(200).send({ ok: true });
      }

      const bot = await getBot(uuid);

      if (!bot) {
        // Неизвестный uuid или бот деактивирован — тихо игнорируем
        return reply.code(200).send({ ok: true });
      }

      await bot.handleUpdate(request.body as Update);
    } catch (err) {
      // Страховка: даже если что-то сломалось — всегда 200
      console.error(`[Webhook] Необработанная ошибка uuid=${uuid}:`, err);
    }

    return reply.code(200).send({ ok: true });
  });

  return app;
}