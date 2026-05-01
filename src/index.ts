import 'dotenv/config';
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
import { db } from './db/index.js';
import { sql, and, eq, lt } from 'drizzle-orm';
import { orders as ordersTable, users as usersTable, orderHistory as orderHistoryTable } from './db/schema.js';
import { addClient, connectedCount, emitToUser } from './ws.js';

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

// 404 handler
app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }, 404));

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
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
    console.log('✓ DB schema up to date');
  } catch (e: any) {
    console.warn('Migration warning:', e.message);
  }
}

await runMigrations();

// XP helpers (mirrors orders.ts)
const AUTO_XP_THRESHOLDS = [0, 100, 200, 400, 700, 1000];
function autoCalcLevel(xp: number): number {
  for (let i = AUTO_XP_THRESHOLDS.length - 1; i >= 0; i--) {
    if (xp >= AUTO_XP_THRESHOLDS[i]) return i + 1;
  }
  return 1;
}

// Auto-confirm orders stuck in pending_confirmation for > 24h (task 28)
async function autoConfirmStaleOrders() {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const stale = await db.select().from(ordersTable)
      .where(and(eq(ordersTable.status, 'pending_confirmation'), lt(ordersTable.updatedAt, cutoff)));
    for (const order of stale) {
      await db.update(ordersTable).set({ status: 'completed', updatedAt: new Date() }).where(eq(ordersTable.id, order.id));
      if (order.contractorId) {
        const [ct] = await db.select({ xp: usersTable.xp }).from(usersTable).where(eq(usersTable.id, order.contractorId));
        const newXp = (ct?.xp ?? 0) + 10;
        await db.update(usersTable).set({ balance: sql`balance + ${order.price}`, xp: newXp, level: autoCalcLevel(newXp) }).where(eq(usersTable.id, order.contractorId));
        emitToUser(order.contractorId, { type: 'order_status', orderId: order.id, title: 'Заказ завершён автоматически', message: 'Заказчик не подтвердил в течение 24ч — оплата начислена' });
      }
      const [cu] = await db.select({ xp: usersTable.xp }).from(usersTable).where(eq(usersTable.id, order.customerId));
      const cuXp = (cu?.xp ?? 0) + 10;
      await db.update(usersTable).set({ xp: cuXp, level: autoCalcLevel(cuXp) }).where(eq(usersTable.id, order.customerId));
      emitToUser(order.customerId, { type: 'order_status', orderId: order.id, title: 'Заказ завершён', message: 'Автоматически подтверждён через 24 часа' });
      await db.insert(orderHistoryTable).values({ orderId: order.id, status: 'completed', note: 'Auto-confirmed: 24h timeout' });
      console.log(`[AUTO-CONFIRM] ${order.id}`);
    }
  } catch (e: any) { console.error('[AUTO-CONFIRM]', e.message); }
}
setInterval(autoConfirmStaleOrders, 5 * 60 * 1000);

// Start server
const port = parseInt(process.env.PORT || '3000');

console.log(`
  🚀 TrashGo API v1.4.0 on http://localhost:${port}
  📍 Health: http://localhost:${port}/health
  📍 Auth:   http://localhost:${port}/api/v1/auth
  📍 Orders: http://localhost:${port}/api/v1/orders
  📍 Users:  http://localhost:${port}/api/v1/users
  📍 SSE:    http://localhost:${port}/api/v1/notifications/stream
`);

serve({ fetch: app.fetch, port });
