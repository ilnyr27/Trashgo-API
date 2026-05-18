import 'dotenv/config';
import * as Sentry from '@sentry/node';
if (process.env.SENTRY_DSN) {
  Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
}
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { timing } from 'hono/timing';
import { streamSSE } from 'hono/streaming';
import jwt from 'jsonwebtoken';
import authRoutes from './routes/auth.js';
import ordersRoutes from './routes/orders.js';
import usersRoutes from './routes/users.js';
import referralsRoutes from './routes/referrals.js';
import achievementsRoutes from './routes/achievements.js';
import subscriptionsRoutes from './routes/subscriptions.js';
import leaderboardRoutes from './routes/leaderboard.js';
import adminRoutes from './routes/admin.js';
import supportRoutes from './routes/support.js';
import uploadRoutes from './routes/upload.js';
import { db } from './db/index.js';
import { calcLevel, checkOrderAchievements, checkVolumeAchievements, checkDistrictAchievements, checkTimeAchievements, checkAsapAchievements, checkEcoAchievements, checkVehicleAchievements, checkTenureAchievements } from './lib/achievements.js';
import { sql, and, eq, lt } from 'drizzle-orm';
import { orders as ordersTable, users as usersTable, orderHistory as orderHistoryTable, otpCodes as otpCodesTable } from './db/schema.js';
import { addClient, connectedCount, emitToUser, setFcmFallback } from './ws.js';
import { sendPushNotification } from './lib/firebase-admin.js';
import { startSubscriptionCron } from './lib/subscriptionCron.js';
import { hasTelegram, sendTelegramNotification, getBotUsername } from './lib/telegram.js';
import { notifyUser } from './lib/notify.js';
import { normalizePhone } from './lib/phone.js';

const app = new Hono();

// Global middleware
app.use('*', logger());
app.use('*', timing());
const allowedOrigins = [
  ...(process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',') : ['http://localhost:5173']),
  'https://trashgo-coral.vercel.app',
  'https://trashgo-gamma.vercel.app',
  'https://web-production-8d2c4.up.railway.app',
];

app.use('*', cors({
  origin: allowedOrigins,
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// Health check
app.get('/', (c) => c.json({
  status: 'ok',
  service: 'trashgo-api',
  version: '1.5.0',
  timestamp: new Date().toISOString(),
  ws_clients: connectedCount(),
}));

// SSE — real-time push notifications
app.get('/api/v1/notifications/stream', (c) => {
  const token = c.req.query('token') || '';
  let userId: string | null = null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string };
    userId = payload.userId;
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const uid = userId;
  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ data: JSON.stringify({ type: 'connected' }), event: 'message' });
    const cleanup = addClient(uid, (event) => {
      stream.writeSSE({ data: JSON.stringify(event), event: 'message' }).catch(() => {});
    });
    // heartbeat every 30s to keep connection alive
    while (true) {
      await stream.sleep(30000);
      try {
        await stream.writeSSE({ data: '', event: 'ping' });
      } catch {
        break;
      }
    }
    cleanup();
  });
});

app.get('/health', (c) => c.json({ status: 'ok' }));

// API routes
app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/orders', ordersRoutes);
app.route('/api/v1/users', usersRoutes);
app.route('/api/v1/referrals', referralsRoutes);
app.route('/api/v1/achievements', achievementsRoutes);
app.route('/api/v1/subscriptions', subscriptionsRoutes);
app.route('/api/v1/leaderboard', leaderboardRoutes);
app.route('/api/v1/admin', adminRoutes);
app.route('/api/v1/support', supportRoutes);
app.route('/api/v1/upload', uploadRoutes);

// Geocoding proxy — avoids Nominatim browser User-Agent restrictions
// ?q=... &limit=N (default 1, max 5)
// Bounded to Kazan (viewbox) and restricted to Russia for accuracy
app.get('/api/v1/geocode', async (c) => {
  const q = c.req.query('q');
  const limit = Math.min(5, Math.max(1, parseInt(c.req.query('limit') ?? '1', 10) || 1));
  if (!q) return c.json([], 200);
  try {
    const params = new URLSearchParams({
      q,
      format: 'json',
      limit: String(limit),
      'accept-language': 'ru',
      countrycodes: 'ru',
      addressdetails: '1',
      bounded: '1',
      viewbox: '48.7,56.05,49.55,55.55', // Kazan bounding box
    });
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?${params}`,
      { headers: { 'User-Agent': 'TrashGo/1.0 (trashgo-gamma.vercel.app)' } }
    );
    const data = await res.json();
    return c.json(data);
  } catch {
    return c.json([], 200);
  }
});

// Telegram Bot webhook — receives OTP link requests from users
app.post('/api/v1/auth/telegram/webhook', async (c) => {
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (webhookSecret) {
    if (c.req.header('X-Telegram-Bot-API-Secret-Token') !== webhookSecret) {
      return c.json({ ok: false }, 401);
    }
  } else if (process.env.TELEGRAM_BOT_TOKEN) {
    // Telegram active but no secret — warn on every request so it shows in logs
    console.warn('[SECURITY] TELEGRAM_WEBHOOK_SECRET not set — anyone can spoof Telegram messages. Set it in Railway.');
  }
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ ok: true });

  const message = body.message;
  if (!message?.text || !message?.chat?.id) return c.json({ ok: true });

  const chatId = String(message.chat.id);
  const text = message.text.trim();
  const startPayload = text.startsWith('/start ') ? text.slice(7).trim() : '';

  // Fast path: one-time token generated by /auth/login (avoids phone encoding issues)
  const { telegramTokens } = await import('./lib/telegramTokens.js');
  const tokenEntry = startPayload ? telegramTokens.get(startPayload) : undefined;
  if (tokenEntry && tokenEntry.exp > Date.now()) {
    telegramTokens.delete(startPayload);
    const { users: usersTable } = await import('./db/schema.js');
    const { eq } = await import('drizzle-orm');
    const rows = await db.select({ id: usersTable.id, telegramChatId: usersTable.telegramChatId }).from(usersTable).where(eq(usersTable.phone, tokenEntry.phone)).limit(1);
    const isNewLink = rows.length > 0 && !rows[0].telegramChatId;
    if (rows.length > 0) {
      await db.update(usersTable).set({ telegramChatId: chatId } as any).where(eq(usersTable.id, rows[0].id));
    }
    const { sendTelegramOtp } = await import('./lib/telegram.js');
    await sendTelegramOtp(chatId, tokenEntry.code);
    if (isNewLink) {
      await sendTelegramMessage(chatId, '✅ Telegram привязан к вашему аккаунту TrashGo.\n\nТеперь вы будете получать уведомления о заказах прямо сюда — даже когда приложение закрыто.');
    }
    return c.json({ ok: true });
  }

  // Fallback: extract phone from message text (for users who type their number directly)
  const phoneMatch = text.replace('/start ', '').match(/^(\+?[78]?\d{9,15})$/) ||
    decodeURIComponent(text.replace('/start ', '')).match(/^(\+?[78]?\d{9,15})$/);
  const phone = phoneMatch ? phoneMatch[1] : null;

  if (!phone) {
    await sendTelegramMessage(chatId, 'Перейдите по ссылке из приложения TrashGo, чтобы получить код.');
    return c.json({ ok: true });
  }

  // Normalize phone
  const normalized = normalizePhone(phone);
  const digits = normalized.replace('+', '');
  const phoneForms = [normalized, digits, phone, `+${digits}`, `8${digits.slice(1)}`];

  const { users: usersTable, otpCodes: otpCodesTable } = await import('./db/schema.js');
  const { eq, and, gt, desc } = await import('drizzle-orm');

  let user = null;
  for (const p of phoneForms) {
    const rows = await db.select({ id: usersTable.id, telegramChatId: usersTable.telegramChatId })
      .from(usersTable).where(eq(usersTable.phone, p)).limit(1);
    if (rows.length > 0) { user = rows[0]; break; }
  }

  if (user && user.telegramChatId !== chatId) {
    await db.update(usersTable).set({ telegramChatId: chatId } as any).where(eq(usersTable.id, user.id));
  }

  let otp = null;
  for (const p of phoneForms) {
    const rows = await db.select()
      .from(otpCodesTable)
      .where(and(eq(otpCodesTable.phone, p), eq(otpCodesTable.used, 0), gt(otpCodesTable.expiresAt, new Date())))
      .orderBy(desc(otpCodesTable.createdAt))
      .limit(1);
    if (rows.length > 0) { otp = rows[0]; break; }
  }

  const { sendTelegramOtp } = await import('./lib/telegram.js');

  if (otp) {
    await sendTelegramOtp(chatId, otp.code);
  } else {
    await sendTelegramMessage(chatId, `✅ Telegram привязан к номеру ${normalized}.\n\nТеперь запросите код в приложении TrashGo, и он придёт сюда.`);
  }

  return c.json({ ok: true });
});

async function sendTelegramMessage(chatId: string, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  }).catch(() => {});
}

// GET /api/v1/auth/bot-info — public, returns Telegram bot username for deep-link construction
app.get('/api/v1/auth/bot-info', async (c) => {
  const username = await getBotUsername();
  return c.json({ username });
});

// 404 handler
app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404));

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  if (process.env.SENTRY_DSN) Sentry.captureException(err);
  return c.json({
    error: {
      code: 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    },
  }, 500);
});

// Run pending schema migrations
async function runMigrations() {
  try {
    await db.execute(sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS photo_urls TEXT NOT NULL DEFAULT '[]'`);
    await db.execute(sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS asap BOOLEAN NOT NULL DEFAULT FALSE`);
    await db.execute(sql`ALTER TABLE orders ALTER COLUMN scheduled_at DROP NOT NULL`);
    await db.execute(sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS completion_photo_urls TEXT NOT NULL DEFAULT '[]'`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS balance INTEGER NOT NULL DEFAULT 0`);
    await db.execute(sql`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'pending_confirmation' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'order_status')) THEN ALTER TYPE order_status ADD VALUE 'pending_confirmation'; END IF; END $$`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), order_id UUID NOT NULL REFERENCES orders(id), sender_id UUID NOT NULL REFERENCES users(id), sender_name VARCHAR(100) NOT NULL DEFAULT '', text TEXT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW())`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_messages_order ON messages(order_id, created_at)`);
    await db.execute(sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS rating_by_customer INTEGER`);
    await db.execute(sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS rating_by_contractor INTEGER`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS transport_mode VARCHAR(50) NOT NULL DEFAULT 'car'`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(12) UNIQUE`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES users(id)`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS referrals (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), referrer_id UUID NOT NULL REFERENCES users(id), referee_id UUID NOT NULL REFERENCES users(id), created_at TIMESTAMP NOT NULL DEFAULT NOW())`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS addresses TEXT NOT NULL DEFAULT '[]'`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_push BOOLEAN NOT NULL DEFAULT TRUE`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_email BOOLEAN NOT NULL DEFAULT FALSE`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_email_address VARCHAR(200)`);
    await db.execute(sql`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS bonus_150_paid BOOLEAN NOT NULL DEFAULT FALSE`);
    await db.execute(sql`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS bonus_expires_at TIMESTAMP`);
    await db.execute(sql`ALTER TABLE referrals ADD COLUMN IF NOT EXISTS bonus_monthly_used INTEGER NOT NULL DEFAULT 0`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS user_achievements (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id), achievement_id VARCHAR(50) NOT NULL, xp_rewarded INTEGER NOT NULL DEFAULT 0, unlocked_at TIMESTAMP NOT NULL DEFAULT NOW())`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON user_achievements(user_id)`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id VARCHAR(30)`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS subscriptions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), customer_id UUID NOT NULL REFERENCES users(id), address TEXT NOT NULL, district VARCHAR(100) NOT NULL DEFAULT '', days TEXT NOT NULL DEFAULT '[]', time VARCHAR(8) NOT NULL DEFAULT '18:00', price INTEGER NOT NULL, description TEXT NOT NULL DEFAULT '', active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP NOT NULL DEFAULT NOW())`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(customer_id)`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token VARCHAR(300)`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS inn VARCHAR(12)`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS frozen BOOLEAN NOT NULL DEFAULT FALSE`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS freeze_reason VARCHAR(500)`);
    await db.execute(sql`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS volume INTEGER NOT NULL DEFAULT 1`);
    await db.execute(sql`ALTER TABLE orders ADD COLUMN IF NOT EXISTS subscription_id UUID REFERENCES subscriptions(id)`);
    await db.execute(sql`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'pending_payment' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'order_status')) THEN ALTER TYPE order_status ADD VALUE 'pending_payment'; END IF; END $$`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_available BOOLEAN NOT NULL DEFAULT TRUE`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS support_messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL REFERENCES users(id), message TEXT NOT NULL, reply TEXT, replied_at TIMESTAMP, status VARCHAR(20) NOT NULL DEFAULT 'open', created_at TIMESTAMP NOT NULL DEFAULT NOW())`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_support_user ON support_messages(user_id, created_at)`);
    await db.execute(sql`ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMP`);
    await db.execute(sql`ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS category VARCHAR(50)`);
    await db.execute(sql`ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS is_bot_reply BOOLEAN NOT NULL DEFAULT FALSE`);
    await db.execute(sql`ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS escalated BOOLEAN NOT NULL DEFAULT FALSE`);
    await db.execute(sql`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS contractor_id UUID REFERENCES users(id)`);
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS inn_verified BOOLEAN NOT NULL DEFAULT FALSE`);
    console.log('✓ DB schema up to date');
  } catch (e: any) {
    console.warn('Migration warning:', e.message);
  }
}

await runMigrations();

// Fallback: when a user has no SSE connection, push via FCM and/or Telegram
setFcmFallback(async (userId, event) => {
  try {
    const userRow = await db.select({ fcmToken: usersTable.fcmToken, telegramChatId: usersTable.telegramChatId })
      .from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const { fcmToken, telegramChatId } = userRow[0] ?? {};
    const title = String(event.title ?? 'TrashGo');
    const message = String(event.message ?? '');
    if (fcmToken) {
      await sendPushNotification(fcmToken, title, message, event.orderId ? { orderId: String(event.orderId) } : undefined);
    }
    if (telegramChatId && hasTelegram()) {
      await sendTelegramNotification(telegramChatId, title, message);
    }
  } catch { /* non-fatal */ }
});


// Cron: auto-cancel/confirm/complete stale orders
async function autoConfirmStaleOrders() {
  try {
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000);

    // Phase 0: no contractor accepted new order in 24h → auto-cancel
    const staleNew = await db.select().from(ordersTable)
      .where(and(eq(ordersTable.status, 'new'), lt(ordersTable.createdAt, cutoff24h)));
    for (const order of staleNew) {
      await db.update(ordersTable).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(ordersTable.id, order.id));
      await db.insert(orderHistoryTable).values({ orderId: order.id, status: 'cancelled', note: 'Auto-cancelled: no contractor accepted in 24h' });
      emitToUser(order.customerId, { type: 'order_status', orderId: order.id, title: '❌ Заказ отменён', message: 'Никто не принял заказ в течение 24 часов — создайте новый' });
      notifyUser(order.customerId, '❌ Заказ не принят', `Заказ #${order.id.slice(0, 8)} отменён — никто не принял за 24 часа. Попробуйте создать новый.`);
      console.log(`[AUTO-CANCEL new] ${order.id}`);
    }

    // Phase 1: customer hasn't confirmed work → auto-advance to pending_payment
    const staleConfirmation = await db.select().from(ordersTable)
      .where(and(eq(ordersTable.status, 'pending_confirmation'), lt(ordersTable.updatedAt, cutoff24h)));
    for (const order of staleConfirmation) {
      await db.update(ordersTable).set({ status: 'pending_payment', updatedAt: new Date() }).where(eq(ordersTable.id, order.id));
      await db.insert(orderHistoryTable).values({ orderId: order.id, status: 'pending_payment', note: 'Auto-advanced: customer did not confirm in 24h' });
      if (order.contractorId) {
        emitToUser(order.contractorId, { type: 'order_status', orderId: order.id, title: 'Автоподтверждение', message: 'Заказчик не ответил — ожидайте СБП оплату и нажмите «Деньги получены»' });
      }
      emitToUser(order.customerId, { type: 'order_status', orderId: order.id, title: 'Работа подтверждена', message: 'Оплатите исполнителю через СБП и дождитесь завершения' });
      console.log(`[AUTO-ADVANCE pending_payment] ${order.id}`);
    }

    // Phase 2: contractor hasn't confirmed payment receipt → auto-complete
    const stalePayment = await db.select().from(ordersTable)
      .where(and(eq(ordersTable.status, 'pending_payment'), lt(ordersTable.updatedAt, cutoff48h)));
    for (const order of stalePayment) {
      await db.update(ordersTable).set({ status: 'completed', updatedAt: new Date() }).where(eq(ordersTable.id, order.id));
      if (order.contractorId) {
        const [ct] = await db.select({ xp: usersTable.xp }).from(usersTable).where(eq(usersTable.id, order.contractorId));
        const newXp = (ct?.xp ?? 0) + 10;
        await db.update(usersTable).set({ balance: sql`balance + ${order.price}`, xp: newXp, level: calcLevel(newXp) }).where(eq(usersTable.id, order.contractorId));
        emitToUser(order.contractorId, { type: 'order_status', orderId: order.id, title: 'Заказ завершён автоматически', message: 'Исполнитель не подтвердил оплату в течение 48ч — оплата начислена' });
      }
      const [cu] = await db.select({ xp: usersTable.xp }).from(usersTable).where(eq(usersTable.id, order.customerId));
      const cuXp = (cu?.xp ?? 0) + 10;
      await db.update(usersTable).set({ xp: cuXp, level: calcLevel(cuXp) }).where(eq(usersTable.id, order.customerId));
      emitToUser(order.customerId, { type: 'order_status', orderId: order.id, title: 'Заказ завершён', message: 'Автоматически завершён через 48 часов' });
      await db.insert(orderHistoryTable).values({ orderId: order.id, status: 'completed', note: 'Auto-completed: payment not confirmed in 48h' });
      checkEcoAchievements(order.customerId).catch(() => {});
      if (order.contractorId) {
        checkOrderAchievements(order.contractorId, 'contractor').catch(() => {});
        checkVolumeAchievements(order.contractorId).catch(() => {});
        checkDistrictAchievements(order.contractorId).catch(() => {});
        checkTimeAchievements(order.contractorId).catch(() => {});
        checkVehicleAchievements(order.contractorId).catch(() => {});
        checkTenureAchievements(order.contractorId).catch(() => {});
        if (order.asap) checkAsapAchievements(order.contractorId).catch(() => {});
      }
      console.log(`[AUTO-COMPLETE] ${order.id}`);
    }
  } catch (e: any) { console.error('[AUTO-CONFIRM]', e.message); }
}
let autoConfirmRunning = false;
const guardedAutoConfirm = async () => {
  if (autoConfirmRunning) return;
  autoConfirmRunning = true;
  try { await autoConfirmStaleOrders(); } finally { autoConfirmRunning = false; }
};
setInterval(guardedAutoConfirm, 5 * 60 * 1000);

// Subscription cron — creates orders from active subscriptions every day at 06:00 Moscow time
startSubscriptionCron();

// OTP cleanup — delete codes older than 24h once per day (prevents table bloat)
async function cleanupExpiredOtps() {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db.delete(otpCodesTable).where(lt(otpCodesTable.expiresAt, cutoff));
  } catch (e: any) { console.error('[OTP-CLEANUP]', e.message); }
}
setInterval(cleanupExpiredOtps, 24 * 60 * 60 * 1000);
setTimeout(cleanupExpiredOtps, 15_000); // also run shortly after startup

// Start server
const port = parseInt(process.env.PORT || '3000');

console.log(`
  🚀 TrashGo API v1.5.0 on http://localhost:${port}
  📍 Health: http://localhost:${port}/health
  📍 Auth:   http://localhost:${port}/api/v1/auth
  📍 Orders: http://localhost:${port}/api/v1/orders
  📍 Users:  http://localhost:${port}/api/v1/users
  📍 SSE:    http://localhost:${port}/api/v1/notifications/stream
`);

serve({ fetch: app.fetch, port });
