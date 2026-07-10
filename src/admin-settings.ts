import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { escapeHtml, layout, requireAuth } from './admin-shared.js';
import { invalidateBot } from './bot-manager.js';

// ── Боты ─────────────────────────────────────────────────────────────────

async function handleBotsList(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const { data: botsRaw, error } = await db
    .from('bots')
    .select('id, number, city_name, is_active, manager_telegram_id')
    .order('city_name');

  if (error) {
    console.error('[AdminSettings] Ошибка загрузки bots:', error.message);
    return reply.type('text/html').send(layout('Боты', '<div class="card">⚠️ Ошибка загрузки данных.</div>', { activePath: '/admin/bots' }));
  }

  const bots = (botsRaw as Array<Record<string, unknown>>) ?? [];

  const rows = bots
    .map((b) => {
      const isActive = Boolean(b.is_active);
      return `
    <tr>
      <td>${escapeHtml(b.city_name as string)}</td>
      <td><code>${escapeHtml(b.number as string)}</code></td>
      <td>${b.manager_telegram_id ? `<code>${b.manager_telegram_id}</code>` : '—'}</td>
      <td><span class="badge ${isActive ? 'active' : 'paused'}">${isActive ? 'Активен' : 'Выключен'}</span></td>
      <td>
        <form method="POST" action="/admin/bots/${b.id}/toggle">
          <button type="submit">${isActive ? 'Выключить' : 'Включить'}</button>
        </form>
      </td>
    </tr>`;
    })
    .join('');

  const addForm = `
  <div class="card">
    <h3 style="margin-top:0;">Добавить город</h3>
    <form method="POST" action="/admin/bots" class="filters">
      <label>Название города
        <input type="text" name="city_name" placeholder="Одесса" required />
      </label>
      <label>Токен от @BotFather
        <input type="text" name="token" placeholder="123456:AAH..." required />
      </label>
      <label>Telegram ID менеджера (необязательно)
        <input type="text" name="manager_telegram_id" placeholder="123456789" />
      </label>
      <button type="submit">Создать и зарегистрировать вебхук</button>
    </form>
  </div>`;

  const table =
    bots.length === 0
      ? '<div class="card empty">Городов пока нет.</div>'
      : `<div class="card" style="overflow-x:auto;">
        <table>
          <thead><tr><th>Город</th><th>UUID вебхука</th><th>Менеджер</th><th>Статус</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

  const body = `<h1 style="margin-top:0;">Боты (${bots.length})</h1>${table}${addForm}`;

  reply.type('text/html').send(layout('Боты', body, { activePath: '/admin/bots' }));
}

async function handleBotCreate(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const body = request.body as { city_name?: string; token?: string; manager_telegram_id?: string };
  const cityName = (body.city_name ?? '').trim();
  const token = (body.token ?? '').trim();
  const managerTelegramId = body.manager_telegram_id?.trim() ? Number(body.manager_telegram_id.trim()) : null;

  if (!cityName || !token) {
    return reply.type('text/html').send(layout('Боты', '<div class="card">⚠️ Название города и токен обязательны. <a class="link" href="/admin/bots">Назад</a></div>', { activePath: '/admin/bots' }));
  }

  const number = randomUUID();

  const { error: insertError } = await db.from('bots').insert({
    number,
    token,
    city_name: cityName,
    is_active: true,
    manager_telegram_id: managerTelegramId
  });

  if (insertError) {
    console.error('[AdminSettings] Ошибка создания бота:', insertError.message);
    return reply.type('text/html').send(layout('Боты', `<div class="card">⚠️ Не удалось создать бота: ${escapeHtml(insertError.message)}. <a class="link" href="/admin/bots">Назад</a></div>`, { activePath: '/admin/bots' }));
  }

  // Сразу регистрируем вебхук у Telegram, чтобы не гонять register-webhooks руками
  const baseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '');
  let webhookNote = '';

  if (baseUrl) {
    try {
      const webhookUrl = `${baseUrl}/webhook/${number}`;
      const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl, drop_pending_updates: true, allowed_updates: ['message', 'callback_query'] })
      });
      const json = (await res.json()) as { ok: boolean; description?: string };
      if (!json.ok) {
        webhookNote = `<div class="card ban-banner">⚠️ Бот создан, но вебхук зарегистрировать не удалось: ${escapeHtml(json.description ?? 'неизвестная ошибка')}. Проверьте токен и запустите npm run register-webhooks вручную.</div>`;
      }
    } catch (err) {
      console.error('[AdminSettings] Ошибка регистрации вебхука:', err);
      webhookNote = '<div class="card ban-banner">⚠️ Бот создан, но не удалось связаться с Telegram для регистрации вебхука. Запустите npm run register-webhooks вручную.</div>';
    }
  } else {
    webhookNote = '<div class="card ban-banner">⚠️ PUBLIC_BASE_URL не задан в .env — вебхук не зарегистрирован автоматически. Запустите npm run register-webhooks вручную.</div>';
  }

  if (webhookNote) {
    return reply.type('text/html').send(layout('Боты', `${webhookNote}<a class="link" href="/admin/bots">← К списку ботов</a>`, { activePath: '/admin/bots' }));
  }

  reply.redirect('/admin/bots');
}

async function handleBotToggle(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const { botId } = request.params as { botId: string };

  const { data: botRow } = await db.from('bots').select('number, is_active').eq('id', Number(botId)).maybeSingle();
  if (!botRow) return reply.redirect('/admin/bots');

  const current = botRow as { number: string; is_active: boolean };
  const newStatus = !current.is_active;

  const { error } = await db.from('bots').update({ is_active: newStatus }).eq('id', Number(botId));

  if (error) {
    console.error('[AdminSettings] Ошибка переключения бота:', error.message);
  } else if (!newStatus) {
    // Выключили — сразу выбрасываем закешированный инстанс, чтобы бот
    // перестал отвечать немедленно, а не после перезапуска процесса
    invalidateBot(current.number);
  }

  reply.redirect('/admin/bots');
}

// ── Услуги ───────────────────────────────────────────────────────────────

async function handleServicesList(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const query = request.query as { city?: string };
  const { data: citiesRaw } = await db.from('bots').select('id, city_name').order('city_name');
  const cities = (citiesRaw as Array<{ id: number; city_name: string }>) ?? [];

  if (cities.length === 0) {
    return reply.type('text/html').send(layout('Услуги', '<div class="card empty">Сначала добавьте город.</div>', { activePath: '/admin/services' }));
  }

  const cityId = query.city ? Number(query.city) : cities[0].id;

  const [{ data: allServicesRaw }, { data: enabledRaw }] = await Promise.all([
    db.from('services').select('id, name').order('name'),
    db.from('bot_services').select('service_id, is_enabled').eq('bot_id', cityId)
  ]);

  const allServices = (allServicesRaw as Array<{ id: number; name: string }>) ?? [];
  const enabledMap = new Map<number, boolean>();
  for (const row of (enabledRaw as Array<{ service_id: number; is_enabled: boolean }>) ?? []) {
    enabledMap.set(row.service_id, row.is_enabled);
  }

  const cityOptions = cities
    .map((c) => `<option value="${c.id}" ${c.id === cityId ? 'selected' : ''}>${escapeHtml(c.city_name)}</option>`)
    .join('');

  const citySelector = `
  <form class="filters card" method="GET" action="/admin/services">
    <label>Город
      <select name="city" onchange="this.form.submit()">${cityOptions}</select>
    </label>
  </form>`;

  const rows = allServices
    .map((s) => {
      const isEnabled = enabledMap.get(s.id) === true;
      return `
    <tr>
      <td>${escapeHtml(s.name)}</td>
      <td><span class="badge ${isEnabled ? 'active' : 'paused'}">${isEnabled ? 'Включена' : 'Выключена'}</span></td>
      <td>
        <form method="POST" action="/admin/services/toggle">
          <input type="hidden" name="service_id" value="${s.id}" />
          <input type="hidden" name="city_id" value="${cityId}" />
          <input type="hidden" name="enable" value="${isEnabled ? '0' : '1'}" />
          <button type="submit">${isEnabled ? 'Выключить' : 'Включить'}</button>
        </form>
      </td>
    </tr>`;
    })
    .join('');

  const table =
    allServices.length === 0
      ? '<div class="card empty">Услуг в каталоге пока нет.</div>'
      : `<div class="card" style="overflow-x:auto;">
        <table>
          <thead><tr><th>Услуга</th><th>Статус в этом городе</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

  const addForm = `
  <div class="card">
    <h3 style="margin-top:0;">Новая услуга</h3>
    <form method="POST" action="/admin/services" class="filters">
      <input type="hidden" name="city_id" value="${cityId}" />
      <label>Название
        <input type="text" name="name" placeholder="Маникюр" required />
      </label>
      <button type="submit">Добавить и включить для этого города</button>
    </form>
  </div>`;

  const body = `<h1 style="margin-top:0;">Услуги</h1>${citySelector}${table}${addForm}`;

  reply.type('text/html').send(layout('Услуги', body, { activePath: '/admin/services' }));
}

async function handleServiceToggle(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const body = request.body as { service_id?: string; city_id?: string; enable?: string };
  const serviceId = Number(body.service_id);
  const cityId = Number(body.city_id);
  const enable = body.enable === '1';

  const { data: existing } = await db
    .from('bot_services')
    .select('id')
    .eq('bot_id', cityId)
    .eq('service_id', serviceId)
    .maybeSingle();

  if (existing) {
    const { error } = await db
      .from('bot_services')
      .update({ is_enabled: enable })
      .eq('id', (existing as { id: number }).id);
    if (error) console.error('[AdminSettings] Ошибка обновления bot_services:', error.message);
  } else {
    const { error } = await db.from('bot_services').insert({ bot_id: cityId, service_id: serviceId, is_enabled: enable });
    if (error) console.error('[AdminSettings] Ошибка создания bot_services:', error.message);
  }

  reply.redirect(`/admin/services?city=${cityId}`);
}

async function handleServiceCreate(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const body = request.body as { name?: string; city_id?: string };
  const name = (body.name ?? '').trim();
  const cityId = Number(body.city_id);

  if (!name) return reply.redirect(`/admin/services?city=${cityId}`);

  const { data: newService, error } = await db.from('services').insert({ name }).select('id').single();

  if (error || !newService) {
    console.error('[AdminSettings] Ошибка создания услуги:', error?.message);
    return reply.type('text/html').send(layout('Услуги', `<div class="card">⚠️ Не удалось создать услугу: ${escapeHtml(error?.message ?? '')}. <a class="link" href="/admin/services">Назад</a></div>`, { activePath: '/admin/services' }));
  }

  const serviceId = (newService as { id: number }).id;

  await db.from('bot_services').insert({ bot_id: cityId, service_id: serviceId, is_enabled: true });

  reply.redirect(`/admin/services?city=${cityId}`);
}

// ── Районы и подрайоны ───────────────────────────────────────────────────

async function handleDistrictsList(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const query = request.query as { city?: string };
  const { data: citiesRaw } = await db.from('bots').select('id, city_name').order('city_name');
  const cities = (citiesRaw as Array<{ id: number; city_name: string }>) ?? [];

  if (cities.length === 0) {
    return reply.type('text/html').send(layout('Районы', '<div class="card empty">Сначала добавьте город.</div>', { activePath: '/admin/districts' }));
  }

  const cityId = query.city ? Number(query.city) : cities[0].id;

  const { data: districtsRaw, error } = await db
    .from('districts')
    .select('id, name')
    .eq('bot_id', cityId)
    .order('name');

  if (error) {
    console.error('[AdminSettings] Ошибка загрузки districts:', error.message);
  }

  const districts = (districtsRaw as Array<{ id: number; name: string }>) ?? [];

  const cityOptions = cities
    .map((c) => `<option value="${c.id}" ${c.id === cityId ? 'selected' : ''}>${escapeHtml(c.city_name)}</option>`)
    .join('');

  const citySelector = `
  <form class="filters card" method="GET" action="/admin/districts">
    <label>Город
      <select name="city" onchange="this.form.submit()">${cityOptions}</select>
    </label>
  </form>`;

  const rows = districts
    .map(
      (d) => `
    <tr>
      <td>${escapeHtml(d.name)}</td>
      <td><a class="link" href="/admin/districts/${d.id}">Подрайоны →</a></td>
      <td>
        <form method="POST" action="/admin/districts/${d.id}/delete">
          <input type="hidden" name="city_id" value="${cityId}" />
          <button type="submit">Удалить</button>
        </form>
      </td>
    </tr>`
    )
    .join('');

  const table =
    districts.length === 0
      ? '<div class="card empty">Районов пока нет.</div>'
      : `<div class="card" style="overflow-x:auto;">
        <table>
          <thead><tr><th>Район</th><th></th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

  const addForm = `
  <div class="card">
    <h3 style="margin-top:0;">Новый район</h3>
    <form method="POST" action="/admin/districts" class="filters">
      <input type="hidden" name="city_id" value="${cityId}" />
      <label>Название
        <input type="text" name="name" placeholder="Центр" required />
      </label>
      <button type="submit">Добавить</button>
    </form>
  </div>`;

  const body = `<h1 style="margin-top:0;">Районы</h1>${citySelector}${table}${addForm}`;

  reply.type('text/html').send(layout('Районы', body, { activePath: '/admin/districts' }));
}

async function handleDistrictCreate(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const body = request.body as { name?: string; city_id?: string };
  const name = (body.name ?? '').trim();
  const cityId = Number(body.city_id);

  if (name) {
    const { error } = await db.from('districts').insert({ bot_id: cityId, name });
    if (error) console.error('[AdminSettings] Ошибка создания района:', error.message);
  }

  reply.redirect(`/admin/districts?city=${cityId}`);
}

async function handleDistrictDelete(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const { districtId } = request.params as { districtId: string };
  const body = request.body as { city_id?: string };
  const cityId = Number(body.city_id);

  // Сначала подрайоны (на случай если в БД нет каскадного удаления),
  // потом сам район
  const { error: subError } = await db.from('sub_districts').delete().eq('district_id', Number(districtId));
  if (subError) console.error('[AdminSettings] Ошибка удаления подрайонов:', subError.message);

  const { error } = await db.from('districts').delete().eq('id', Number(districtId));

  if (error) {
    console.error('[AdminSettings] Ошибка удаления района:', error.message);
    return reply.type('text/html').send(
      layout(
        'Районы',
        `<div class="card">⚠️ Не удалось удалить район: ${escapeHtml(error.message)}. Возможно, на него ссылаются анкеты мастеров. <a class="link" href="/admin/districts?city=${cityId}">Назад</a></div>`,
        { activePath: '/admin/districts' }
      )
    );
  }

  reply.redirect(`/admin/districts?city=${cityId}`);
}

async function handleDistrictDetail(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const { districtId } = request.params as { districtId: string };

  const { data: districtRaw } = await db.from('districts').select('id, name, bot_id').eq('id', Number(districtId)).maybeSingle();

  if (!districtRaw) {
    return reply.code(404).type('text/html').send(layout('Район не найден', '<div class="card">Район не найден.</div>', { activePath: '/admin/districts' }));
  }

  const district = districtRaw as { id: number; name: string; bot_id: number };

  const { data: subsRaw } = await db.from('sub_districts').select('id, name').eq('district_id', district.id).order('name');
  const subs = (subsRaw as Array<{ id: number; name: string }>) ?? [];

  const rows = subs
    .map(
      (s) => `
    <tr>
      <td>${escapeHtml(s.name)}</td>
      <td>
        <form method="POST" action="/admin/sub-districts/${s.id}/delete">
          <input type="hidden" name="district_id" value="${district.id}" />
          <button type="submit">Удалить</button>
        </form>
      </td>
    </tr>`
    )
    .join('');

  const table =
    subs.length === 0
      ? '<div class="card empty">Подрайонов пока нет.</div>'
      : `<div class="card" style="overflow-x:auto;">
        <table>
          <thead><tr><th>Подрайон</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

  const addForm = `
  <div class="card">
    <h3 style="margin-top:0;">Новый подрайон</h3>
    <form method="POST" action="/admin/districts/${district.id}/sub-districts" class="filters">
      <label>Название
        <input type="text" name="name" placeholder="Оболонь" required />
      </label>
      <button type="submit">Добавить</button>
    </form>
  </div>`;

  const body = `
    <div class="breadcrumb"><a href="/admin/districts?city=${district.bot_id}">← Все районы</a></div>
    <h1 style="margin-top:0;">${escapeHtml(district.name)}: подрайоны</h1>
    ${table}
    ${addForm}
  `;

  reply.type('text/html').send(layout('Подрайоны', body, { activePath: '/admin/districts' }));
}

async function handleSubDistrictCreate(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const { districtId } = request.params as { districtId: string };
  const body = request.body as { name?: string };
  const name = (body.name ?? '').trim();

  if (name) {
    const { error } = await db.from('sub_districts').insert({ district_id: Number(districtId), name });
    if (error) console.error('[AdminSettings] Ошибка создания подрайона:', error.message);
  }

  reply.redirect(`/admin/districts/${districtId}`);
}

async function handleSubDistrictDelete(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const { subId } = request.params as { subId: string };
  const body = request.body as { district_id?: string };
  const districtId = body.district_id ?? '';

  const { error } = await db.from('sub_districts').delete().eq('id', Number(subId));

  if (error) {
    console.error('[AdminSettings] Ошибка удаления подрайона:', error.message);
  }

  reply.redirect(`/admin/districts/${districtId}`);
}

// ── Регистрация роутов ──────────────────────────────────────────────────

export function registerAdminSettingsRoutes(app: FastifyInstance): void {
  app.get('/admin/bots', handleBotsList);
  app.post('/admin/bots', handleBotCreate);
  app.post('/admin/bots/:botId/toggle', handleBotToggle);

  app.get('/admin/services', handleServicesList);
  app.post('/admin/services', handleServiceCreate);
  app.post('/admin/services/toggle', handleServiceToggle);

  app.get('/admin/districts', handleDistrictsList);
  app.post('/admin/districts', handleDistrictCreate);
  app.get('/admin/districts/:districtId', handleDistrictDetail);
  app.post('/admin/districts/:districtId/delete', handleDistrictDelete);
  app.post('/admin/districts/:districtId/sub-districts', handleSubDistrictCreate);
  app.post('/admin/sub-districts/:subId/delete', handleSubDistrictDelete);
}