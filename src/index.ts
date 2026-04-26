import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { timing } from 'hono/timing';
import authRoutes from './routes/auth.js';
import ordersRoutes from './routes/orders.js';
import usersRoutes from './routes/users.js';
import { db } from './db/index.js';
import { sql } from 'drizzle-orm';

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
  version: '1.0.0',
  timestamp: new Date().toISOString(),
}));

app.get('/health', (c) => c.json({ status: 'ok' }));

// API routes
app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/orders', ordersRoutes);
app.route('/api/v1/users', usersRoutes);

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
    console.log('✓ DB schema up to date');
  } catch (e: any) {
    console.warn('Migration warning:', e.message);
  }
}

await runMigrations();

// Start server
const port = parseInt(process.env.PORT || '3000');

console.log(`
  🚀 TrashGo API running on http://localhost:${port}
  📍 Health: http://localhost:${port}/health
  📍 Auth:   http://localhost:${port}/api/v1/auth
  📍 Orders: http://localhost:${port}/api/v1/orders
  📍 Users:  http://localhost:${port}/api/v1/users
`);

serve({ fetch: app.fetch, port });
