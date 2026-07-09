import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from './db.js';
import { escapeHtml, layout, requireAuth } from './admin-shared.js';

// ── Список чатов ─────────────────────────────────────────────────────────

interface ChatRow {
  id: string;
  botId: number;
  cityName: string;
  clientId: number;
  masterId: number;
  masterName: string;
  status: string;
  messageCount: number;
  updatedAt: string;
}

function statusBadge(status: string): string {
  const cls = status === 'active' ? 'active' : status === 'finished' ? 'finished' : 'paused';
  const label = status === 'active' ? 'Активен' : status === 'finished' ? 'Завершён' : status;
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.round(hours / 24);
  return `${days} дн назад`;
}

function chatsPage(
  cities: Array<{ id: number; city_name: string }>,
  rows: ChatRow[],
  state: { cityFilter: number | null; statusFilter: string; clientFilter: string; masterFilter: string }
): string {
  const cityOptions = cities
    .map((c) => `<option value="${c.id}" ${state.cityFilter === c.id ? 'selected' : ''}>${escapeHtml(c.city_name)}</option>`)
    .join('');

  const filtersForm = `
  <form class="filters card" method="GET" action="/admin/chats">
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
        <option value="finished" ${state.statusFilter === 'finished' ? 'selected' : ''}>Завершённые</option>
      </select>
    </label>
    <label>Client ID
      <input type="text" name="client" value="${escapeHtml(state.clientFilter)}" placeholder="Telegram ID клиента" />
    </label>
    <label>Master ID
      <input type="text" name="master" value="${escapeHtml(state.masterFilter)}" placeholder="Telegram ID мастера" />
    </label>
    <button type="submit">Применить</button>
  </form>`;

  const tableBody = rows
    .map(
      (r) => `
    <tr>
      <td>${escapeHtml(r.cityName)}</td>
      <td><code>${r.clientId}</code></td>
      <td>${escapeHtml(r.masterName)} · <code>${r.masterId}</code></td>
      <td>${statusBadge(r.status)}</td>
      <td>${r.messageCount}</td>
      <td>${timeAgo(r.updatedAt)}</td>
      <td><a class="link" href="/admin/chats/${r.id}">Открыть →</a></td>
    </tr>`
    )
    .join('');

  const table =
    rows.length === 0
      ? '<div class="card empty">Чатов по этим фильтрам не найдено.</div>'
      : `<div class="card" style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th>Город</th><th>Клиент</th><th>Мастер</th><th>Статус</th><th>Сообщений</th><th>Активность</th><th></th>
            </tr>
          </thead>
          <tbody>${tableBody}</tbody>
        </table>
      </div>`;

  return `
    <h1 style="margin-top:0;">Чаты (${rows.length})</h1>
    ${filtersForm}
    ${table}
  `;
}

async function handleChatsList(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const query = request.query as Record<string, string | undefined>;
  const cityFilter = query.city ? Number(query.city) : null;
  const statusFilter = query.status === 'active' || query.status === 'finished' ? query.status : 'all';
  const clientFilter = (query.client ?? '').trim();
  const masterFilter = (query.master ?? '').trim();

  const { data: citiesRaw } = await db.from('bots').select('id, city_name').order('city_name');
  const cities = (citiesRaw as Array<{ id: number; city_name: string }>) ?? [];

  let chatsQuery = db
    .from('active_chats')
    .select('id, bot_id, client_id, master_id, status, updated_at, bots(city_name)')
    .order('updated_at', { ascending: false });

  if (cityFilter) chatsQuery = chatsQuery.eq('bot_id', cityFilter);
  if (statusFilter !== 'all') chatsQuery = chatsQuery.eq('status', statusFilter);
  if (clientFilter) chatsQuery = chatsQuery.eq('client_id', Number(clientFilter));
  if (masterFilter) chatsQuery = chatsQuery.eq('master_id', Number(masterFilter));

  const { data: chatsRaw, error: chatsError } = await chatsQuery;

  if (chatsError) {
    console.error('[AdminChats] Ошибка загрузки active_chats:', chatsError.message);
    return reply.type('text/html').send(layout('Чаты', '<div class="card">⚠️ Ошибка загрузки данных.</div>', { activePath: '/admin/chats' }));
  }

  const chats = (chatsRaw as Array<Record<string, unknown>>) ?? [];
  const chatIds = chats.map((c) => c.id as string);

  // Считаем количество сообщений по каждому чату одним запросом
  const messageCountByChat = new Map<string, number>();
  if (chatIds.length > 0) {
    const { data: logsRaw } = await db.from('chat_message_log').select('chat_id').in('chat_id', chatIds);
    for (const row of (logsRaw as Array<{ chat_id: string }>) ?? []) {
      messageCountByChat.set(row.chat_id, (messageCountByChat.get(row.chat_id) ?? 0) + 1);
    }
  }

  // Имена мастеров — одним запросом на все нужные (bot_id, master_id) пары
  const masterNameByKey = new Map<string, string>();
  const masterIds = [...new Set(chats.map((c) => c.master_id as number))];
  if (masterIds.length > 0) {
    const { data: mastersRaw } = await db
      .from('masters_profiles')
      .select('master_id, bot_id, name')
      .in('master_id', masterIds);
    for (const m of (mastersRaw as Array<{ master_id: number; bot_id: number; name: string }>) ?? []) {
      masterNameByKey.set(`${m.bot_id}:${m.master_id}`, m.name);
    }
  }

  const rows: ChatRow[] = chats.map((c) => ({
    id: c.id as string,
    botId: c.bot_id as number,
    cityName: (c.bots as { city_name: string } | null)?.city_name ?? '—',
    clientId: c.client_id as number,
    masterId: c.master_id as number,
    masterName: masterNameByKey.get(`${c.bot_id}:${c.master_id}`) ?? '—',
    status: c.status as string,
    messageCount: messageCountByChat.get(c.id as string) ?? 0,
    updatedAt: c.updated_at as string
  }));

  const state = { cityFilter, statusFilter, clientFilter, masterFilter };
  reply.type('text/html').send(layout('Чаты', chatsPage(cities, rows, state), { activePath: '/admin/chats' }));
}

// ── Переписка одного чата ───────────────────────────────────────────────

async function handleChatDetail(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const { chatId } = request.params as { chatId: string };

  const { data: chatRaw, error: chatError } = await db
    .from('active_chats')
    .select('id, bot_id, client_id, master_id, status, updated_at, bots(city_name)')
    .eq('id', chatId)
    .maybeSingle();

  if (chatError) {
    console.error('[AdminChats] Ошибка загрузки active_chats:', chatError.message);
  }

  if (chatError || !chatRaw) {
    return reply.code(404).type('text/html').send(layout('Чат не найден', '<div class="card">Чат не найден.</div>', { activePath: '/admin/chats' }));
  }

  const chat = chatRaw as Record<string, unknown>;
  const botId = chat.bot_id as number;
  const clientId = chat.client_id as number;
  const masterId = chat.master_id as number;
  const cityName = (chat.bots as { city_name: string } | null)?.city_name ?? '—';

  const [{ data: masterProfile }, { data: logsRaw }, { data: botRow }, { data: banRow }] = await Promise.all([
    db.from('masters_profiles').select('name').eq('master_id', masterId).eq('bot_id', botId).maybeSingle(),
    db
      .from('chat_message_log')
      .select('sender_id, text, photo_ids, created_at')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: true }),
    db.from('bots').select('token').eq('id', botId).maybeSingle(),
    db
      .from('blocked_clients')
      .select('id, created_at')
      .eq('bot_id', botId)
      .eq('master_id', masterId)
      .eq('client_id', clientId)
      .maybeSingle()
  ]);

  const ban = banRow as { id: number; created_at: string } | null;

  const masterName = (masterProfile as { name: string } | null)?.name ?? 'мастер';
  const messages = (logsRaw as Array<{ sender_id: number; text: string | null; photo_ids: string[] | null; created_at: string }>) ?? [];
  const botToken = (botRow as { token: string } | null)?.token ?? null;

  // Имя клиента запрашиваем напрямую у Telegram (в БД не хранится)
  let clientName = `Клиент ${clientId}`;
  if (botToken) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getChat?chat_id=${clientId}`);
      const json = (await res.json()) as { ok: boolean; result?: { first_name?: string } };
      if (json.ok && json.result?.first_name) {
        clientName = json.result.first_name;
      }
    } catch {
      // клиент мог заблокировать бота — оставляем дефолтное имя
    }
  }

  const transcript = messages
    .map((m) => {
      const isClient = m.sender_id === clientId;
      const senderLabel = isClient ? escapeHtml(clientName) : escapeHtml(masterName);
      const time = new Date(m.created_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

      const textHtml = m.text ? `<div>${escapeHtml(m.text)}</div>` : '';
      const photosHtml = (m.photo_ids ?? []).length
        ? `<div class="photos">${(m.photo_ids ?? [])
            .map((fileId) => {
              const src = `/admin/photo/${botId}/${encodeURIComponent(fileId)}`;
              return `<a href="${src}" target="_blank" rel="noopener"><img src="${src}" loading="lazy" alt="Фото из чата" /></a>`;
            })
            .join('')}</div>`
        : '';

      return `
      <div class="msg ${isClient ? 'client' : 'master'}">
        <div class="meta">${senderLabel} · ${time}</div>
        ${textHtml}
        ${photosHtml}
      </div>`;
    })
    .join('');

  const banBanner = ban
    ? `<div class="card ban-banner">
        🚫 Мастер забанил этого клиента ${timeAgo(ban.created_at)}.
        <form method="POST" action="/admin/bans/${ban.id}/unban" style="display:inline;">
          <input type="hidden" name="redirect" value="/admin/chats/${chatId}" />
          <button type="submit">Разбанить</button>
        </form>
      </div>`
    : '';

  const body = `
    <div class="breadcrumb"><a href="/admin/chats">← Все чаты</a></div>
    <h1 style="margin-top:0;">${escapeHtml(cityName)}: ${escapeHtml(clientName)} ↔ ${escapeHtml(masterName)}</h1>
    ${banBanner}
    <div class="card" style="margin-bottom:16px;">
      ${statusBadge(chat.status as string)}
      <span style="color:#888;font-size:13px;margin-left:8px;">
        Client ID: <code>${clientId}</code> · Master ID: <code>${masterId}</code>
      </span>
    </div>
    <div class="card">
      ${messages.length === 0 ? '<div class="empty">Сообщений нет.</div>' : `<div class="transcript">${transcript}</div>`}
    </div>
  `;

  reply.type('text/html').send(layout('Переписка', body, { activePath: '/admin/chats' }));
}

// ── Прокси фото из Telegram (не светим токен бота на клиенте) ──────────

async function handlePhotoProxy(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const { botId, fileId } = request.params as { botId: string; fileId: string };

  const { data: botRow } = await db.from('bots').select('token').eq('id', Number(botId)).maybeSingle();
  const token = (botRow as { token: string } | null)?.token;

  if (!token) {
    return reply.code(404).send('Бот не найден');
  }

  try {
    const fileInfoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
    const fileInfo = (await fileInfoRes.json()) as { ok: boolean; result?: { file_path?: string } };

    if (!fileInfo.ok || !fileInfo.result?.file_path) {
      return reply.code(404).send('Файл не найден в Telegram (возможно, устарел)');
    }

    const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${fileInfo.result.file_path}`);
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    const contentType = fileRes.headers.get('content-type') ?? 'image/jpeg';

    reply.type(contentType).send(buffer);
  } catch (err) {
    console.error('[AdminChats] Ошибка загрузки фото:', err);
    reply.code(502).send('Не удалось загрузить фото из Telegram');
  }
}

// ── Клиенты ──────────────────────────────────────────────────────────────

async function handleClientsList(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const { data: chatsRaw, error } = await db
    .from('active_chats')
    .select('client_id, bot_id, updated_at, bots(city_name)')
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('[AdminChats] Ошибка загрузки клиентов:', error.message);
    return reply.type('text/html').send(layout('Клиенты', '<div class="card">⚠️ Ошибка загрузки данных.</div>', { activePath: '/admin/clients' }));
  }

  const chats = (chatsRaw as Array<Record<string, unknown>>) ?? [];

  type ClientAgg = { clientId: number; botId: number; cityName: string; chatCount: number; lastActivity: string };
  const byKey = new Map<string, ClientAgg>();

  for (const c of chats) {
    const clientId = c.client_id as number;
    const botId = c.bot_id as number;
    const key = `${botId}:${clientId}`;
    const cityName = (c.bots as { city_name: string } | null)?.city_name ?? '—';
    const updatedAt = c.updated_at as string;

    const existing = byKey.get(key);
    if (existing) {
      existing.chatCount += 1;
      if (updatedAt > existing.lastActivity) existing.lastActivity = updatedAt;
    } else {
      byKey.set(key, { clientId, botId, cityName, chatCount: 1, lastActivity: updatedAt });
    }
  }

  const clients = [...byKey.values()].sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));

  const tableBody = clients
    .map(
      (c) => `
    <tr>
      <td>${escapeHtml(c.cityName)}</td>
      <td><code>${c.clientId}</code></td>
      <td>${c.chatCount}</td>
      <td>${timeAgo(c.lastActivity)}</td>
      <td><a class="link" href="/admin/chats?city=${c.botId}&client=${c.clientId}">Переписки →</a></td>
    </tr>`
    )
    .join('');

  const body = `
    <h1 style="margin-top:0;">Клиенты (${clients.length})</h1>
    ${
      clients.length === 0
        ? '<div class="card empty">Клиентов пока нет.</div>'
        : `<div class="card" style="overflow-x:auto;">
          <table>
            <thead><tr><th>Город</th><th>Client ID</th><th>Чатов</th><th>Активность</th><th></th></tr></thead>
            <tbody>${tableBody}</tbody>
          </table>
        </div>`
    }
  `;

  reply.type('text/html').send(layout('Клиенты', body, { activePath: '/admin/clients' }));
}

// ── Баны ─────────────────────────────────────────────────────────────────

async function handleBansList(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const { data: bansRaw, error } = await db
    .from('blocked_clients')
    .select('id, bot_id, master_id, client_id, created_at, bots(city_name)')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[AdminChats] Ошибка загрузки blocked_clients:', error.message);
    return reply.type('text/html').send(layout('Баны', '<div class="card">⚠️ Ошибка загрузки данных.</div>', { activePath: '/admin/bans' }));
  }

  const bans = (bansRaw as Array<Record<string, unknown>>) ?? [];

  const masterIds = [...new Set(bans.map((b) => b.master_id as number))];
  const masterNameByKey = new Map<string, string>();
  if (masterIds.length > 0) {
    const { data: mastersRaw } = await db.from('masters_profiles').select('master_id, bot_id, name').in('master_id', masterIds);
    for (const m of (mastersRaw as Array<{ master_id: number; bot_id: number; name: string }>) ?? []) {
      masterNameByKey.set(`${m.bot_id}:${m.master_id}`, m.name);
    }
  }

  const tableBody = bans
    .map((b) => {
      const cityName = (b.bots as { city_name: string } | null)?.city_name ?? '—';
      const masterName = masterNameByKey.get(`${b.bot_id}:${b.master_id}`) ?? '—';
      return `
    <tr>
      <td>${escapeHtml(cityName)}</td>
      <td>${escapeHtml(masterName)} · <code>${b.master_id}</code></td>
      <td><code>${b.client_id}</code></td>
      <td>${timeAgo(b.created_at as string)}</td>
      <td><a class="link" href="/admin/chats?city=${b.bot_id}&client=${b.client_id}&master=${b.master_id}">Переписка →</a></td>
      <td>
        <form method="POST" action="/admin/bans/${b.id}/unban">
          <input type="hidden" name="redirect" value="/admin/bans" />
          <button type="submit">Разбанить</button>
        </form>
      </td>
    </tr>`;
    })
    .join('');

  const body = `
    <h1 style="margin-top:0;">Баны (${bans.length})</h1>
    ${
      bans.length === 0
        ? '<div class="card empty">Банов пока нет.</div>'
        : `<div class="card" style="overflow-x:auto;">
          <table>
            <thead><tr><th>Город</th><th>Мастер</th><th>Клиент</th><th>Когда</th><th></th><th></th></tr></thead>
            <tbody>${tableBody}</tbody>
          </table>
        </div>`
    }
  `;

  reply.type('text/html').send(layout('Баны', body, { activePath: '/admin/bans' }));
}

async function handleUnban(request: FastifyRequest, reply: FastifyReply) {
  if (!requireAuth(request, reply)) return;

  const { banId } = request.params as { banId: string };
  const body = request.body as { redirect?: string };
  const redirectTo = body.redirect && body.redirect.startsWith('/admin') ? body.redirect : '/admin/bans';

  const { error } = await db.from('blocked_clients').delete().eq('id', Number(banId));

  if (error) {
    console.error('[AdminChats] Ошибка удаления бана:', error.message);
  }

  reply.redirect(redirectTo);
}

// ── Регистрация роутов ──────────────────────────────────────────────────

export function registerAdminChatsRoutes(app: FastifyInstance): void {
  app.get('/admin/chats', handleChatsList);
  app.get('/admin/chats/:chatId', handleChatDetail);
  app.get('/admin/photo/:botId/:fileId', handlePhotoProxy);
  app.get('/admin/clients', handleClientsList);
  app.get('/admin/bans', handleBansList);
  app.post('/admin/bans/:banId/unban', handleUnban);
}