# TrashGo API

Бэкенд для [TrashGo](https://github.com/ilnyr27/Trashgo) — P2P-маркетплейса вывоза мусора.

**Live**: [web-production-8d2c4.up.railway.app](https://web-production-8d2c4.up.railway.app)

## Стек

| Технология | Назначение |
|------------|------------|
| Node.js 22 | Рантайм |
| Hono | HTTP-фреймворк |
| Drizzle ORM | Типизированные SQL-запросы |
| PostgreSQL 16 | База данных |
| JWT | Авторизация (access 15мин + refresh 30д) |
| Zod | Валидация входных данных |
| bcryptjs | Хэширование паролей |

## Структура проекта

```
src/
├── index.ts              # Точка входа: Hono app + middleware + routes
├── routes/
│   ├── auth.ts           # POST /login, /verify, /register, /refresh
│   ├── orders.ts         # GET/POST /orders, PATCH /orders/:id/status
│   └── users.ts          # GET/PATCH /users/me
├── middleware/
│   └── auth.ts           # JWT-верификация + requireRole guard
├── db/
│   ├── index.ts          # Drizzle + postgres.js подключение
│   ├── schema.ts         # 5 таблиц: users, otp_codes, orders, order_history, refresh_tokens
│   └── migrate.ts        # Запуск миграций
drizzle/
└── 0000_*.sql            # SQL-миграции (генерируются Drizzle Kit)
```

## Быстрый старт

```bash
# Клонировать
git clone https://github.com/ilnyr27/Trashgo-API.git
cd Trashgo-API

# Установить зависимости
npm install

# Создать .env из шаблона
cp .env.example .env
# Отредактировать .env — указать DATABASE_URL от локального PostgreSQL

# Сгенерировать миграции (если схема менялась)
npm run db:generate

# Применить миграции
npm run db:migrate

# Запустить dev-сервер
npm run dev
# → http://localhost:3000
```

## Environment Variables

```env
DATABASE_URL=postgresql://user:password@localhost:5432/trashgo
JWT_SECRET=<случайная строка 32+ символов>
JWT_REFRESH_SECRET=<другая случайная строка 32+ символов>
PORT=3000
FRONTEND_URL=http://localhost:5173
NODE_ENV=development
```

**Production (Railway):** переменные ставятся в Railway Dashboard → Service → Variables.

## API Endpoints

### Health

```
GET  /health              → {"status": "ok"}
```

### Авторизация `/api/v1/auth`

```
POST /login               — Отправка OTP по номеру телефона
     Body: { phone: "+79001234567" }
     Response: { data: { otpSent: true, isNewUser: bool, devCode?: "1234" } }

POST /verify              — Проверка OTP (для существующего юзера → JWT)
     Body: { phone: "+79001234567", code: "1234" }
     Response: { data: { user, token, refreshToken } }
     или:     { data: { verified: true, isNewUser: true } }

POST /register            — Регистрация нового юзера (после verify)
     Body: { phone, code, name, role: "customer"|"contractor", district }
     Response: { data: { user, token, refreshToken } }

POST /refresh             — Обновление JWT-пары (rotation)
     Body: { refreshToken: "..." }
     Response: { data: { token, refreshToken } }
```

### Пользователи `/api/v1/users` (нужен JWT)

```
GET  /me                  — Профиль текущего юзера
PATCH /me                 — Обновить профиль (name, district)
```

### Заказы `/api/v1/orders` (нужен JWT)

```
GET  /                    — Мои заказы (customer: свои, contractor: взятые)
GET  /available           — Доступные заказы (только contractor)
POST /                    — Создать заказ (только customer)
     Body: { address, district, volume, price, description, scheduledAt }
PATCH /:id/status         — Сменить статус заказа
     Body: { status: "accepted"|"in_progress"|"completed"|"cancelled" }
```

### Статусная машина заказов

```
new → accepted → in_progress → completed
new → cancelled
accepted → cancelled
```

- **customer** может: отменить свой заказ (→ cancelled)
- **contractor** может: принять (→ accepted), начать (→ in_progress), завершить (→ completed)

## Схема БД

5 таблиц с 3 индексами:

```
users              — id, phone, name, role, district, xp, level, password_hash, created_at
otp_codes          — id, phone, code, expires_at, used, created_at
orders             — id, customer_id, contractor_id, address, district, status, volume, price, description, scheduled_at, created_at, updated_at
order_history      — id, order_id, status, note, created_at
refresh_tokens     — id, user_id, token, expires_at, created_at

Индексы:
- idx_orders_district_status (district, status)  — для marketplace-поиска
- idx_orders_customer (customer_id, created_at)   — для "мои заказы"
- idx_orders_contractor (contractor_id, status)   — для "мои задания"
```

## Деплой (Railway)

Автоматический деплой при push в `main`.

При старте контейнера Railway выполняет:
1. `node --import tsx src/db/migrate.ts` — применение миграций
2. `node --import tsx src/index.ts` — запуск сервера

Конфигурация в `railway.json`:
- Builder: Nixpacks
- Health check: `GET /health`
- Auto-restart при падении (до 3 попыток)

## Scripts

```bash
npm run dev          # Dev-сервер с hot reload (tsx watch)
npm run start        # Production-запуск
npm run build        # TypeScript компиляция
npm run db:generate  # Генерация SQL-миграций из schema.ts
npm run db:migrate   # Применение миграций к БД
npm run db:studio    # Drizzle Studio (GUI для БД)
```

## Связанные репозитории

- **Frontend**: [ilnyr27/Trashgo](https://github.com/ilnyr27/Trashgo) — React SPA на Vercel
- **Live Frontend**: [trashgo-coral.vercel.app](https://trashgo-coral.vercel.app)
