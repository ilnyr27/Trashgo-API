import { Hono } from 'hono';
import { z } from 'zod';
import { eq, desc, sql, asc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { orders, orderHistory, users, messages } from '../db/schema.js';
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
  scheduledAt: z.string().datetime().optional(),
  asap: z.boolean().default(false),
  photoUrls: z.array(z.string()).max(5).default([]),
});

const updateStatusSchema = z.object({
  status: z.enum(['accepted', 'in_progress', 'completed', 'cancelled', 'pending_confirmation']),
});

const completeOrderSchema = z.object({
  completionPhotoUrls: z.array(z.string()).max(5).default([]),
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
    .select({ order: orders, customerName: users.name, customerPhone: users.phone })
    .from(orders)
    .leftJoin(users, eq(orders.customerId, users.id))
    .where(eq(orders.id, id))
    .limit(1);

  if (result.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  }

  const row = result[0];
  let contractorPhone = '';
  let contractorName = '';
  if (row.order.contractorId) {
    const contractor = await db.select({ name: users.name, phone: users.phone })
      .from(users).where(eq(users.id, row.order.contractorId)).limit(1);
    contractorPhone = contractor[0]?.phone ?? '';
    contractorName = contractor[0]?.name ?? '';
  }

  return c.json({ data: {
    ...formatOrder(row.order),
    customerName: row.customerName ?? '',
    customerPhone: row.customerPhone ?? '',
    contractorPhone,
    contractorName,
  } });
});

// GET /orders/:id/messages
ordersRouter.get('/:id/messages', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const order = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order.length) return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  const o = order[0];
  if (o.customerId !== user.userId && o.contractorId !== user.userId) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Not your order' } }, 403);
  }

  const msgs = await db.select().from(messages)
    .where(eq(messages.orderId, id))
    .orderBy(asc(messages.createdAt))
    .limit(200);

  return c.json({ data: msgs.map(m => ({
    id: m.id,
    senderId: m.senderId,
    senderName: m.senderName,
    text: m.text,
    createdAt: m.createdAt.toISOString(),
  })) });
});

// POST /orders/:id/messages
ordersRouter.post('/:id/messages', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const text = (body?.text ?? '').toString().trim().slice(0, 1000);
  if (!text) return c.json({ error: { code: 'VALIDATION', message: 'Text required' } }, 400);

  const order = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order.length) return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  const o = order[0];
  if (o.customerId !== user.userId && o.contractorId !== user.userId) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Not your order' } }, 403);
  }

  const sender = await db.select({ name: users.name }).from(users).where(eq(users.id, user.userId)).limit(1);
  const senderName = sender[0]?.name ?? '';

  const msg = await db.insert(messages).values({ orderId: id, senderId: user.userId, senderName, text }).returning();
  return c.json({ data: {
    id: msg[0].id, senderId: msg[0].senderId, senderName: msg[0].senderName,
    text: msg[0].text, createdAt: msg[0].createdAt.toISOString(),
  } }, 201);
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
    asap: parsed.data.asap,
    scheduledAt: parsed.data.asap ? null : new Date(parsed.data.scheduledAt!),
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
    in_progress: ['pending_confirmation', 'cancelled'],
    pending_confirmation: ['completed', 'cancelled'],
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

// POST /orders/:id/complete — contractor uploads completion photo, moves to pending_confirmation
ordersRouter.post('/:id/complete', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = completeOrderSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION', message: 'Invalid input' } }, 400);
  }

  const current = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (current.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  }

  const order = current[0];
  if (order.contractorId !== user.userId) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Not your order' } }, 403);
  }
  if (order.status !== 'in_progress') {
    return c.json({ error: { code: 'INVALID_TRANSITION', message: 'Order must be in_progress' } }, 400);
  }

  const updated = await db.update(orders)
    .set({
      status: 'pending_confirmation',
      completionPhotoUrls: JSON.stringify(parsed.data.completionPhotoUrls),
      updatedAt: new Date(),
    })
    .where(eq(orders.id, id))
    .returning();

  await db.insert(orderHistory).values({
    orderId: id,
    status: 'pending_confirmation',
    note: `Contractor ${user.userId} submitted completion photos`,
  });

  return c.json({ data: formatOrder(updated[0]) });
});

// POST /orders/:id/confirm — customer confirms completion, credits contractor balance
ordersRouter.post('/:id/confirm', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const current = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (current.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  }

  const order = current[0];
  if (order.customerId !== user.userId) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Not your order' } }, 403);
  }
  if (order.status !== 'pending_confirmation') {
    return c.json({ error: { code: 'INVALID_TRANSITION', message: 'Order must be pending_confirmation' } }, 400);
  }

  const updated = await db.update(orders)
    .set({ status: 'completed', updatedAt: new Date() })
    .where(eq(orders.id, id))
    .returning();

  if (order.contractorId) {
    await db.update(users)
      .set({ balance: sql`balance + ${order.price}` })
      .where(eq(users.id, order.contractorId));
  }

  await db.insert(orderHistory).values({
    orderId: id,
    status: 'completed',
    note: `Confirmed by customer ${user.userId}`,
  });

  return c.json({ data: formatOrder(updated[0]) });
});

// Helper
function formatOrder(o: typeof orders.$inferSelect) {
  let photoUrls: string[] = [];
  let completionPhotoUrls: string[] = [];
  try { photoUrls = JSON.parse(o.photoUrls || '[]'); } catch {}
  try { completionPhotoUrls = JSON.parse(o.completionPhotoUrls || '[]'); } catch {}
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
    completionPhotoUrls,
    asap: o.asap ?? false,
    scheduledAt: o.scheduledAt ? o.scheduledAt.toISOString() : null,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

export default ordersRouter;
