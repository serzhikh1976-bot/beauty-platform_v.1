# Beauty Platform — Мультибот-платформа для бьюти-мастеров

Мультибот-платформа для агрегации бьюти-мастеров на базе Telegram. Один Node.js-сервер обслуживает неограниченное количество Telegram-ботов. Каждый бот = один город.

## Стек технологий

- **Runtime:** Node.js 18+, TypeScript
- **HTTP-сервер:** Fastify
- **Telegram-фреймворк:** Ultra Telegram Framework (UTF)
- **База данных:** Supabase (PostgreSQL)
- **Деплой:** ngrok (разработка) → Railway → VPS

---

## Архитектура

### Мультибот (Паттерн Singleton)

```
Telegram → POST /webhook/:uuid → Fastify → Map<uuid, TelegramBot> → handleUpdate()
```

- Единый URL `/webhook/:uuid` для всех ботов
- При первом запросе токен достаётся из БД по `uuid` (поле `bots.number`)
- Инстанс бота кешируется в `Map` — повторные запросы не ходят в БД
- Токен **никогда не передаётся** по сети (только `uuid` в URL)
- Инвалидация кеша через `invalidateBot(uuid)` при изменении токена

### Изоляция данных

Все таблицы содержат `bot_id`. Данные разных городов физически не пересекаются.

---

## База данных (Supabase)

### Таблицы

| Таблица | Назначение |
|---|---|
| `bots` | Реестр ботов (город, токен, менеджер) |
| `districts` | Районы города |
| `sub_districts` | Подрайоны |
| `users` | Пользователи с ролью (client/master) |
| `services` | Глобальный справочник услуг |
| `bot_services` | Услуги включённые в конкретном боте |
| `masters_profiles` | Анкеты мастеров |
| `master_services` | Услуги мастера (many-to-many) |
| `active_chats` | Активные анонимные чаты |
| `chat_messages` | Маппинг message_id для Reply-туннеля |
| `chat_message_log` | Лог переписки (хранится 14 дней) |
| `orders` | Заявки клиентов (биржа, следующий этап) |
| `order_responses` | Отклики мастеров на заявки |
| `broadcast_messages` | Лог веерной рассылки |

### Автоочистка логов

Через Supabase Extensions → **pg_cron**:

```sql
select cron.schedule(
  'clean-chat-logs',
  '0 3 * * *',
  $$delete from chat_message_log where created_at < now() - interval '14 days'$$
);
```

---

## Функционал

### Роли

При первом запуске `/start` пользователь выбирает роль: **Клиент** или **Мастер**. Роль сохраняется в таблице `users` и сессии.

### Мастер

**Регистрация** (WizardScene, 5 шагов):
1. Имя
2. Услуги — мультиселект из глобального справочника
3. Район → Подрайон (если есть)
4. Минимальная цена
5. Фото портфолио (до 5 штук, `file_id` от Telegram)

После регистрации выдаётся **триал на 30 дней** (`trial_expires_at`).

**Профиль** (`👤 Мой профиль`):
- Альбом из всех фото портфолио
- Статус: Активен / На паузе
- Кнопки управления: `⏸ Пауза`, `✏️ Фото`, `💰 Цена`, `📍 Район`, `🔧 Услуги`

**Редактирование** (отдельные WizardScene для каждого поля):
- Цена — вводится числом
- Район/Подрайон — инлайн-кнопки
- Услуги — мультиселект с тоглами ✅/☐
- Фото — полная замена портфолио (до 5 фото, `/done` или автоматически при 5)

### Клиент

**Умный поиск** (фильтрация на каждом шаге):
1. Услуга — только те где есть активные мастера
2. Район — только те где есть мастера с выбранной услугой
3. Подрайон — только те где есть мастера (если существуют)

Результат — список мастеров инлайн-кнопками:
```
[Мария · Маникюр, Педикюр · от 300 грн]
[Анна · Стрижка · от 200 грн]
```

Нажатие → полная карточка мастера (альбом фото + все услуги + район + цена).

### Анонимный чат

```
Клиент → 💬 Написать мастеру → туннель → Мастер
```

- Проверка: у клиента может быть только **1 активный чат**
- Проверка: мастер должен быть `is_active = true`
- Мастеру приходит уведомление + `message_id` сохраняется для маппинга Reply
- **Клиент пишет** → мастер получает `💬 Имя: текст`
- **Мастер отвечает:**
  - 1 активный чат → любое сообщение (Reply не обязателен)
  - Несколько чатов → обязательно через Reply на нужное сообщение клиента
- Поддержка **фото** в обе стороны
- **Завершение:** кнопка `❌ Завершить диалог` (у любой стороны)
- **Лог переписки** в `chat_message_log` (текст + file_id фото, хранится 14 дней)

---

## Структура проекта

```
src/
  index.ts                    — точка входа, запуск Fastify
  server.ts                   — Fastify: POST /webhook/:uuid
  db.ts                       — Supabase клиент + тип BotRecord
  bot-manager.ts              — кеш ботов, фабрика createBot()
  districts.ts                — утилиты для работы с районами
  register-webhooks.ts        — скрипт регистрации вебхуков
  scenes/
    master-registration.ts    — регистрация мастера (5 шагов)
    client-search.ts          — умный поиск мастеров
    edit-price.ts             — редактирование цены
    edit-district.ts          — редактирование района
    edit-services.ts          — редактирование услуг
    edit-photos.ts            — редактирование фото

supabase/
  schema_full.sql             — полная актуальная схема БД
```

---

## Установка и запуск

### Требования

- Node.js 18+
- Аккаунт Supabase
- Токен(ы) ботов от @BotFather
- ngrok (для разработки)

### 1. Клонирование и установка зависимостей

```bash
git clone <repo>
cd beauty-platform
npm install
```

### 2. Настройка Supabase

1. Создайте проект на [supabase.com](https://supabase.com)
2. **SQL Editor** → вставьте `supabase/schema_full.sql` → Run
3. **Extensions** → включите `pg_cron`
4. Выполните SQL для автоочистки логов (см. раздел "База данных")
5. **Project Settings → API** → скопируйте `Project URL` и ключ `service_role`

### 3. Переменные окружения

```bash
cp .env.example .env
```

Заполните `.env`:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
PORT=3000
PUBLIC_BASE_URL=https://xxxx.ngrok-free.app
SUPER_ADMIN_ID=ваш_telegram_id
```

### 4. Добавление бота в систему

```sql
insert into bots (city_name, token, manager_telegram_id)
values ('Киев', '123456:ABC-TOKEN', 123456789);
```

Заполните справочник услуг:

```sql
insert into services (name) values
  ('Маникюр'), ('Педикюр'), ('Стрижка'),
  ('Окрашивание'), ('Массаж'), ('Брови');
```

Включите услуги для бота:

```sql
insert into bot_services (bot_id, service_id)
select b.id, s.id from bots b, services s
where b.city_name = 'Киев';
```

Добавьте районы:

```sql
insert into districts (bot_id, name)
select id, 'Центральный' from bots where city_name = 'Киев';

-- Подрайоны (опционально):
insert into sub_districts (district_id, name)
values (<district_id>, 'Старый город');
```

### 5. Запуск (разработка)

```bash
# Терминал 1 — сервер
npm run dev

# Терминал 2 — туннель
ngrok http 3000
```

Скопируйте ngrok URL в `.env` → `PUBLIC_BASE_URL`, затем:

```bash
npm run register-webhooks
```

### 6. Запуск (продакшен)

```bash
npm run build
PUBLIC_BASE_URL=https://your-domain.com npm run register-webhooks:prod
npm start
```

Через pm2:

```bash
pm2 start dist/index.js --name beauty-platform
pm2 save && pm2 startup
```

---

## Известные баги UTF и обходные пути

В процессе разработки обнаружено несколько багов в `ultra-telegram-framework`:

### 1. `ctx.from` возвращает неверный ID в action-хендлерах

**Проблема:** `ctx.from.id` в `bot.action()` возвращает ID бота, а не пользователя.

**Причина:** `get from()` читает из `ctx.message.from` (автора сообщения с кнопками = бот), а не из `callbackQuery.from`.

**Решение:** Всегда использовать `ctx.callbackQuery!.from.id` в action-хендлерах.

### 2. Неверный ключ сессии при callback_query

**Проблема:** Стандартный `getSessionKey` тоже использует `ctx.from`, из-за чего сессии клиента и мастера в одном боте перемешиваются.

**Решение:** Кастомный `getSessionKey`:

```typescript
getSessionKey: (ctx) => {
  const userId = ctx.callbackQuery?.from.id ??
    (ctx.message && 'from' in ctx.message ? ctx.message.from?.id : undefined);
  const chatId = ctx.chatId;
  if (!userId || !chatId) return undefined;
  return `${record.id}:${chatId}:${userId}`; // включаем botId для изоляции
}
```

### 3. `scene.enter()` не запускает step 0 немедленно

**Проблема:** `ctx.scene.enter('scene_name')` только записывает сцену в сессию. Step 0 запускается на **следующем** апдейте.

**Решение:** Показывать вопрос/клавиатуру **до** `scene.enter()` в action/match-хендлере. Step 0 обрабатывает только ответ пользователя.

### 4. `scene.next()` немедленно триггерит следующий шаг

**Проблема:** После `ctx.scene.next()` следующий шаг вызывается сразу с текущим ctx (callback_query), что ломает шаги ожидающие текст.

**Решение:** Защитные проверки в начале каждого шага:

```typescript
// Шаг ожидает текст:
async (ctx) => {
  if (!ctx.text) return;
  // ...
}

// Шаг ожидает callback:
async (ctx) => {
  if (!ctx.callbackQuery) return;
  // ...
}
```

### 5. `scene.state` сбрасывается при `scene.enter()`

**Проблема:** Данные записанные в `ctx.scene.state` ДО `scene.enter()` теряются.

**Решение:** Устанавливать `scene.state` ПОСЛЕ `scene.enter()`:

```typescript
ctx.scene.enter('my_scene');
ctx.scene.state.data = value; // ✅ после enter
```

---

## Что дальше (Roadmap)

- [ ] **Таймаут чатов** — автозакрытие через 10 минут бездействия (pg_cron)
- [ ] **Биржа заявок** — клиент создаёт заявку → веерная рассылка активным мастерам → отклики → выбор → чат
- [ ] **Подписка мастеров** — управление триалом, продление через скриншот оплаты, подтверждение менеджером
- [ ] **Уведомления** — дайджест для неактивных мастеров, напоминания об истечении подписки
- [ ] **Персистентные сессии** — замена MemoryStorage на Supabase-адаптер
- [ ] **Hot-reload ботов** — добавление нового бота без рестарта (Supabase Realtime)
- [ ] **Веб-панель администратора** — управление ботами, мастерами, жалобами