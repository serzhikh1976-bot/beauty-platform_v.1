import type { FastifyInstance } from 'fastify';
import cookiePlugin from '@fastify/cookie';
import formbodyPlugin from '@fastify/formbody';
import { db } from './db.js';
import { escapeHtml, isAuthed, layout, loginPage, requireAuth, safeEqual, SESSION_COOKIE } from './admin-shared.js';
import { registerAdminChatsRoutes } from './admin-chats.js';
import { registerAdminSettingsRoutes } from './admin-settings.js';

interface MasterRow {
  masterId: number;
  name: string;
  isActive: boolean;
  priceFrom: number;
  cityName: string;
  district: string;
  services: string;
}

interface FilterState {
  cityFilter: number | null;
  statusFilter: string;
  search: string;
  sortField: string;
  sortDir: 'asc' | 'desc';
}

function sortLink(field: string, label: string, state: FilterState): string {
  const nextDir = state.sortField === field && state.sortDir === 'asc' ? 'desc' : 'asc';
  const params = new URLSearchParams();
  if (state.cityFilter) params.set('city', String(state.cityFilter));
  if (state.statusFilter !== 'all') params.set('status', state.statusFilter);
  if (state.search) params.set('q', state.search);
  params.set('sort', field);
  params.set('dir', nextDir);
  const arrow = state.sortField === field ? (state.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
  return `<a href="/admin?${params.toString()}">${escapeHtml(label)}${arrow}</a>`;
}

function mastersPage(cities: Array<{ id: number; city_name: string }>, rows: MasterRow[], state: FilterState): string {
  const cityOptions = cities
    .map((c) => `<option value="${c.id}" ${state.cityFilter === c.id ? 'selected' : ''}>${escapeHtml(c.city_name)}</option>`)
    .join('');

  const filtersForm = `
  <form class="filters card" method="GET" action="/admin">
    <label>Город
      <select name="city">
        <option value="">Все города</option>
        ${cityOptions}
      </select>
    </label>
    <label>Статус
      <select name="status">
        <option value="all" ${state.statusFilter === 'all' ? 'selected' : ''}>Все</option>
        <option value="active" ${state.statusFilter === 'active' ? 'selected' : ''}>Активные</option>
        <option value="paused" ${state.statusFilter === 'paused' ? 'selected' : ''}>На паузе</option>
      </select>
    </label>
    <label>Поиск по имени
      <input type="text" name="q" value="${escapeHtml(state.search)}" placeholder="Имя мастера" />
    </label>
    <button type="submit">Применить</button>
  </form>`;

  const tableBody = rows
    .map(
      (r) => `
    <tr>
      <td>${escapeHtml(r.cityName)}</td>
      <td>${escapeHtml(r.name)}</td>
      <td><span class="badge ${r.isActive ? 'active' : 'paused'}">${r.isActive ? 'Активен' : 'Пауза'}</span></td>
      <td>${escapeHtml(r.services)}</td>
      <td>${escapeHtml(r.district)}</td>
      <td>от ${r.priceFrom} грн</td>
      <td><a class="link" href="/admin/chats?master=${r.masterId}"><code>${r.masterId}</code></a></td>
    </tr>`
    )
    .join('');

  const table =
    rows.length === 0
      ? '<div class="card empty">Ничего не найдено по этим фильтрам.</div>'
      : `<div class="card" style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th>${sortLink('city', 'Город', state)}</th>
              <th>${sortLink('name', 'Мастер', state)}</th>
              <th>${sortLink('status', 'Статус', state)}</th>
              <th>Услуги</th>
              <th>Район</th>
              <th>${sortLink('price', 'Цена от', state)}</th>
              <th>Telegram ID</th>
            </tr>
          </thead>
          <tbody>${tableBody}</tbody>
        </table>
      </div>`;

  return `
    <h1 style="margin-top:0;">Мастера (${rows.length})</h1>
    ${filtersForm}
    ${table}
  `;
}

function sortRows(rows: MasterRow[], field: string, dir: 'asc' | 'desc'): MasterRow[] {
  const factor = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    switch (field) {
      case 'city':
        return a.cityName.localeCompare(b.cityName, 'ru') * factor;
      case 'status':
        return (Number(a.isActive) - Number(b.isActive)) * factor;
      case 'price':
        return (a.priceFrom - b.priceFrom) * factor;
      case 'name':
      default:
        return a.name.localeCompare(b.name, 'ru') * factor;
    }
  });
}

// ── Регистрация роутов ──────────────────────────────────────────────────

export async function registerAdminWeb(app: FastifyInstance): Promise<void> {
  const password = process.env.ADMIN_PANEL_PASSWORD;
  const cookieSecret = process.env.ADMIN_PANEL_SESSION_SECRET;

  if (!password || !cookieSecret) {
    console.warn('[AdminWeb] ADMIN_PANEL_PASSWORD / ADMIN_PANEL_SESSION_SECRET не заданы — веб-панель отключена.');
    return;
  }

  await app.register(cookiePlugin, { secret: cookieSecret });
  await app.register(formbodyPlugin);

  app.get('/admin/login', async (request, reply) => {
    if (isAuthed(request)) return reply.redirect('/admin');
    const query = request.query as { error?: string };
    reply.type('text/html').send(layout('Вход', loginPage(query.error === '1'), { authed: false }));
  });

  app.post('/admin/login', async (request, reply) => {
    const body = request.body as { password?: string };
    const provided = body.password ?? '';

    if (!safeEqual(provided, password)) {
      return reply.redirect('/admin/login?error=1');
    }

    reply.setCookie(SESSION_COOKIE, 'ok', {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30 // 30 дней
    });
    return reply.redirect('/admin');
  });

  app.get('/admin/logout', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.redirect('/admin/login');
  });

  app.get('/admin', async (request, reply) => {
    if (!requireAuth(request, reply)) return;

    const query = request.query as Record<string, string | undefined>;
    const cityFilter = query.city ? Number(query.city) : null;
    const statusFilter = query.status === 'active' || query.status === 'paused' ? query.status : 'all';
    const search = (query.q ?? '').trim();
    const sortField = ['name', 'city', 'status', 'price'].includes(query.sort ?? '') ? (query.sort as string) : 'name';
    const sortDir: 'asc' | 'desc' = query.dir === 'desc' ? 'desc' : 'asc';

    const { data: citiesRaw, error: citiesError } = await db.from('bots').select('id, city_name').order('city_name');

    if (citiesError) {
      console.error('[AdminWeb] Ошибка загрузки bots:', citiesError.message);
      return reply.type('text/html').send(layout('Мастера', '<div class="card">⚠️ Ошибка загрузки данных.</div>', { activePath: '/admin' }));
    }

    const cities = (citiesRaw as Array<{ id: number; city_name: string }>) ?? [];

    let mastersQuery = db.from('masters_profiles').select(`
      master_id, name, is_active, price_from, bot_id,
      bots(city_name),
      districts(name),
      sub_districts(name),
      master_services(services(name))
    `);

    if (cityFilter) mastersQuery = mastersQuery.eq('bot_id', cityFilter);
    if (statusFilter === 'active') mastersQuery = mastersQuery.eq('is_active', true);
    if (statusFilter === 'paused') mastersQuery = mastersQuery.eq('is_active', false);
    if (search) mastersQuery = mastersQuery.ilike('name', `%${search}%`);

    const { data: mastersRaw, error: mastersError } = await mastersQuery;

    if (mastersError) {
      console.error('[AdminWeb] Ошибка загрузки masters_profiles:', mastersError.message);
      return reply.type('text/html').send(layout('Мастера', '<div class="card">⚠️ Ошибка загрузки данных.</div>', { activePath: '/admin' }));
    }

    const rows: MasterRow[] = ((mastersRaw as Array<Record<string, unknown>>) ?? []).map((m) => {
      const cityName = (m.bots as { city_name: string } | null)?.city_name ?? '—';
      const districtName = (m.districts as { name: string } | null)?.name ?? '';
      const subDistrictName = (m.sub_districts as { name: string } | null)?.name ?? '';
      const district = subDistrictName ? `${districtName} → ${subDistrictName}` : districtName || '—';
      const services =
        ((m.master_services as Array<{ services: { name: string } | null }>) ?? [])
          .map((s) => s.services?.name)
          .filter((v): v is string => Boolean(v))
          .join(', ') || '—';

      return {
        masterId: m.master_id as number,
        name: (m.name as string) ?? '—',
        isActive: Boolean(m.is_active),
        priceFrom: (m.price_from as number) ?? 0,
        cityName,
        district,
        services
      };
    });

    const sorted = sortRows(rows, sortField, sortDir);

    const state: FilterState = { cityFilter, statusFilter, search, sortField, sortDir };
    reply.type('text/html').send(layout('Мастера', mastersPage(cities, sorted, state), { activePath: '/admin' }));
  });

  registerAdminChatsRoutes(app);
  registerAdminSettingsRoutes(app);
}