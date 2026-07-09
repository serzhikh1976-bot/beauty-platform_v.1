import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'admin_session';

// ── Утилиты ──────────────────────────────────────────────────────────────

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Сравнение без утечки времени выполнения (защита от timing-атак на пароль)
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA); // сравнение той же длины, чтобы не палить длину через тайминг
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function isAuthed(request: FastifyRequest): boolean {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return false;
  const result = request.unsignCookie(raw);
  return result.valid && result.value === 'ok';
}

export function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  if (isAuthed(request)) return true;
  reply.redirect('/admin/login');
  return false;
}

// ── HTML-шаблоны ─────────────────────────────────────────────────────────

const NAV_ITEMS: Array<{ href: string; label: string }> = [
  { href: '/admin', label: 'Мастера' },
  { href: '/admin/chats', label: 'Чаты' },
  { href: '/admin/clients', label: 'Клиенты' },
  { href: '/admin/bans', label: 'Баны' }
];

export function layout(
  title: string,
  body: string,
  opts: { authed?: boolean; activePath?: string } = {}
): string {
  const authed = opts.authed ?? true;
  const nav = NAV_ITEMS.map(
    (item) =>
      `<a href="${item.href}" class="${opts.activePath === item.href ? 'active' : ''}">${escapeHtml(item.label)}</a>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; background: #f5f6f8; color: #1a1a1a; }
  header { background: #1a1a2e; color: #fff; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
  header .brand { font-weight: 600; font-size: 16px; color: #fff; text-decoration: none; }
  nav { display: flex; gap: 4px; }
  nav a { color: #cfcfe8; text-decoration: none; padding: 6px 12px; border-radius: 6px; font-size: 14px; }
  nav a:hover { background: rgba(255,255,255,0.08); color: #fff; }
  nav a.active { background: rgba(255,255,255,0.15); color: #fff; }
  .logout { color: #cfcfe8; text-decoration: none; font-size: 14px; }
  .logout:hover { color: #fff; }
  main { padding: 24px; max-width: 1200px; margin: 0 auto; }
  .card { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 20px; }
  form.filters { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; }
  form.filters label { display: flex; flex-direction: column; font-size: 12px; color: #555; gap: 4px; }
  input, select { padding: 8px 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; }
  button { padding: 8px 16px; border: none; border-radius: 6px; background: #4f46e5; color: #fff; font-size: 14px; cursor: pointer; }
  button:hover { background: #4338ca; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #eee; white-space: nowrap; }
  th a { color: #1a1a1a; text-decoration: none; }
  th a:hover { text-decoration: underline; }
  tr:hover { background: #fafafa; }
  a.link { color: #4f46e5; text-decoration: none; }
  a.link:hover { text-decoration: underline; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; }
  .badge.active { background: #dcfce7; color: #166534; }
  .badge.paused { background: #fee2e2; color: #991b1b; }
  .badge.finished { background: #e5e7eb; color: #374151; }
  .empty { color: #888; padding: 40px; text-align: center; }
  .login-box { max-width: 360px; margin: 80px auto; }
  .error { color: #991b1b; font-size: 14px; margin-top: 8px; }
  .breadcrumb { font-size: 13px; margin-bottom: 12px; }
  .breadcrumb a { color: #4f46e5; text-decoration: none; }
  .transcript { display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 70%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.4; }
  .msg.client { align-self: flex-start; background: #f1f0fe; }
  .msg.master { align-self: flex-end; background: #e6f7ee; }
  .msg .meta { font-size: 11px; color: #888; margin-bottom: 4px; }
  .msg .photos { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .msg .photos a { display: block; width: 160px; height: 160px; border-radius: 8px; overflow: hidden; }
  .msg .photos img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .ban-banner { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .ban-banner button { background: #991b1b; }
  .ban-banner button:hover { background: #7f1d1d; }
</style>
</head>
<body>
${
  authed
    ? `<header>
  <a class="brand" href="/admin">🛠 Beauty Platform Admin</a>
  <nav>${nav}</nav>
  <a class="logout" href="/admin/logout">Выйти</a>
</header>`
    : ''
}
<main>${body}</main>
</body>
</html>`;
}

export function loginPage(hasError: boolean): string {
  return `
  <div class="login-box card">
    <h2 style="margin-top:0;">Вход в панель</h2>
    <form method="POST" action="/admin/login">
      <label style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;">
        Пароль
        <input type="password" name="password" autofocus required />
      </label>
      <button type="submit">Войти</button>
      ${hasError ? '<div class="error">Неверный пароль.</div>' : ''}
    </form>
  </div>`;
}