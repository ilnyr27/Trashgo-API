import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and, desc, ne } from 'drizzle-orm';
import { db } from '../db/index.js';
import { orders, orderHistory } from '../db/schema.js';
import { authMiddleware, requireRole, type JwtPayload } from '../middleware/auth.js';

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
});

const updateStatusSchema = z.object({
  status: z.enum(['accepted', 'in_progress', 'completed', 'cancelled']),
});

// GET /orders — list my orders
ordersRouter.get('/', async (c) => {
  const user = c.get('user');

  const field = user.role === 'customer' ? orders.customerId : orders.contractorId;
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

// GET /orders/available — for contractors
ordersRouter.get('/available', requireRole('contractor'), async (c) => {
  const district = c.req.query('district');

  let query = db.select()
    .from(orders)
    .where(eq(orders.status, 'new'))
    .orderBy(desc(orders.createdAt))
    .limit(50);

  const result = await query;

  // Filter by district if provided
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
  const result = await db.select().from(orders).where(eq(orders.id, id)).limit(1);

  if (result.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  }

  return c.json({ data: formatOrder(result[0]) });
});

// POST /orders — create order (customer only)
ordersRouter.post('/', requireRole('customer'), async (c) => {
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
    scheduledAt: new Date(parsed.data.scheduledAt),
  }).returning();

  // Log history
  await db.insert(orderHistory).values({
    orderId: newOrder[0].id,
    status: 'new',
    note: 'Order created',
  });

  return c.json({ data: formatOrder(newOrder[0]) }, 201);
});

// PATCH /orders/:id/status — update order status
ordersRouter.patch('/:id/status', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = updateStatusSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION', message: 'Invalid status' } }, 400);
  }

  const { status } = parsed.data;

  // Get current order
  const current = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (current.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  }

  const order = current[0];

  // Validate transitions
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

  // Role-based permission
  if (status === 'accepted' && user.role !== 'contractor') {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Only contractors can accept' } }, 403);
  }
  if (status === 'completed' && user.role !== 'contractor') {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Only contractors can complete' } }, 403);
  }

  // Update
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

  // Log history
  await db.insert(orderHistory).values({
    orderId: id,
    status,
    note: `Status changed by ${user.role}`,
  });

  return c.json({ data: formatOrder(updated[0]) });
});

// Helper
function formatOrder(o: typeof orders.$inferSelect) {
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
    scheduledAt: o.scheduledAt.toISOString(),
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

export default ordersRouter;
