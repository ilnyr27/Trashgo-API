import { Hono } from 'hono';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { orders, orderHistory, users } from '../db/schema.js';
import { authMiddleware, type JwtPayload } from '../middleware/auth.js';

const ordersRouter = new Hono<{ Variables: { user: JwtPayload } }>();

// All routes require auth
ordersRouter.use('*', authMiddleware);

// Validation
const createOrderSchema = z.object({
  address: z.string().min(1).max(500),
  district: z.string().min(1).max(100),
  volume: z.number().int().min(1).max(50),
  price: z.number().int().min(10).max(10000),
  description: z.string().max(1000).default(''),
  scheduledAt: z.string().datetime(),
  photoUrls: z.array(z.string()).max(5).default([]),
});

const updateStatusSchema = z.object({
  status: z.enum(['accepted', 'in_progress', 'completed', 'cancelled']),
});

// GET /orders — list my orders
// ?mode=contractor → orders I accepted (contractorId = me)
// default → orders I created (customerId = me)
ordersRouter.get('/', async (c) => {
  const user = c.get('user');
  const mode = c.req.query('mode');

  const field = mode === 'contractor' ? orders.contractorId : orders.customerId;

  const result = await db.select()
    .from(orders)
    .where(eq(field, user.userId))
    .orderBy(desc(orders.createdAt))
    .limit(50);

  return c.json({
    data: result.map(formatOrder),
    meta: { total: result.length },
  });
});

// GET /orders/available — all open orders (any authenticated user can browse)
ordersRouter.get('/available', async (c) => {
  const district = c.req.query('district');

  const result = await db.select()
    .from(orders)
    .where(eq(orders.status, 'new'))
    .orderBy(desc(orders.createdAt))
    .limit(50);

  const filtered = district
    ? result.filter((o) => o.district === district)
    : result;

  return c.json({
    data: filtered.map(formatOrder),
    meta: { total: filtered.length },
  });
});

// GET /orders/:id
ordersRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const result = await db
    .select({ order: orders, customerName: users.name })
    .from(orders)
    .leftJoin(users, eq(orders.customerId, users.id))
    .where(eq(orders.id, id))
    .limit(1);

  if (result.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  }

  return c.json({ data: { ...formatOrder(result[0].order), customerName: result[0].customerName ?? '' } });
});

// POST /orders — create an order (any authenticated user)
ordersRouter.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = createOrderSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION', message: 'Invalid input', details: parsed.error.flatten().fieldErrors } }, 400);
  }

  const newOrder = await db.insert(orders).values({
    customerId: user.userId,
    address: parsed.data.address,
    district: parsed.data.district,
    volume: parsed.data.volume,
    price: parsed.data.price,
    description: parsed.data.description,
    photoUrls: JSON.stringify(parsed.data.photoUrls),
    scheduledAt: new Date(parsed.data.scheduledAt),
  }).returning();

  await db.insert(orderHistory).values({
    orderId: newOrder[0].id,
    status: 'new',
    note: 'Order created',
  });

  return c.json({ data: formatOrder(newOrder[0]) }, 201);
});

// PATCH /orders/:id/status — update order status (any authenticated user)
ordersRouter.patch('/:id/status', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = updateStatusSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION', message: 'Invalid status' } }, 400);
  }

  const { status } = parsed.data;

  const current = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (current.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  }

  const order = current[0];

  // Validate state machine
  const validTransitions: Record<string, string[]> = {
    new: ['accepted', 'cancelled'],
    accepted: ['in_progress', 'cancelled'],
    in_progress: ['completed', 'cancelled'],
  };

  const allowed = validTransitions[order.status] || [];
  if (!allowed.includes(status)) {
    return c.json({
      error: { code: 'INVALID_TRANSITION', message: `Cannot transition from ${order.status} to ${status}` },
    }, 400);
  }

  const updates: Record<string, unknown> = {
    status,
    updatedAt: new Date(),
  };
  if (status === 'accepted') {
    updates.contractorId = user.userId;
  }

  const updated = await db.update(orders)
    .set(updates)
    .where(eq(orders.id, id))
    .returning();

  await db.insert(orderHistory).values({
    orderId: id,
    status,
    note: `Status changed by user ${user.userId}`,
  });

  return c.json({ data: formatOrder(updated[0]) });
});

// Helper
function formatOrder(o: typeof orders.$inferSelect) {
  let photoUrls: string[] = [];
  try { photoUrls = JSON.parse(o.photoUrls || '[]'); } catch {}
  return {
    id: o.id,
    customerId: o.customerId,
    contractorId: o.contractorId,
    address: o.address,
    district: o.district,
    status: o.status,
    volume: o.volume,
    price: o.price,
    description: o.description,
    photoUrls,
    scheduledAt: o.scheduledAt.toISOString(),
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

export default ordersRouter;
