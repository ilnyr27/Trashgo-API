import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { subscriptions } from '../db/schema.js';
import { authMiddleware, type JwtPayload } from '../middleware/auth.js';

const router = new Hono<{ Variables: { user: JwtPayload } }>();
router.use('*', authMiddleware);

const SubSchema = z.object({
  address: z.string().min(3).max(300),
  district: z.string().max(100).default(''),
  days: z.array(z.number().int().min(1).max(7)).min(1),
  time: z.string().regex(/^\d{2}:\d{2}$/).default('18:00'),
  price: z.number().int().min(1),
  description: z.string().max(500).default(''),
});

// GET /subscriptions — list my subscriptions (customer)
router.get('/', async (c) => {
  const { userId } = c.get('user');
  const rows = await db.select().from(subscriptions).where(eq(subscriptions.customerId, userId));
  return c.json({ data: rows.map(r => ({ ...r, days: JSON.parse(r.days) })) });
});

// POST /subscriptions
router.post('/', async (c) => {
  const { userId } = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const parsed = SubSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION', message: parsed.error.message } }, 400);
  const { days, ...rest } = parsed.data;
  const [sub] = await db.insert(subscriptions).values({
    customerId: userId,
    ...rest,
    days: JSON.stringify(days),
  }).returning();
  return c.json({ data: { ...sub, days: JSON.parse(sub.days) } }, 201);
});

// PATCH /subscriptions/:id — update (pause/resume/reschedule)
router.patch('/:id', async (c) => {
  const { userId } = c.get('user');
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const UpdateSchema = SubSchema.partial().extend({ active: z.boolean().optional() });
  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION', message: parsed.error.message } }, 400);
  const { days, ...rest } = parsed.data;
  const setData: Partial<typeof subscriptions.$inferInsert> = {};
  if (rest.address !== undefined) setData.address = rest.address;
  if (rest.district !== undefined) setData.district = rest.district;
  if (rest.time !== undefined) setData.time = rest.time;
  if (rest.price !== undefined) setData.price = rest.price;
  if (rest.description !== undefined) setData.description = rest.description;
  if (rest.active !== undefined) setData.active = rest.active;
  if (days !== undefined) setData.days = JSON.stringify(days);
  const [sub] = await db.update(subscriptions)
    .set(setData)
    .where(and(eq(subscriptions.id, id), eq(subscriptions.customerId, userId)))
    .returning();
  if (!sub) return c.json({ error: { code: 'NOT_FOUND' } }, 404);
  return c.json({ data: { ...sub, days: JSON.parse(sub.days) } });
});

// DELETE /subscriptions/:id
router.delete('/:id', async (c) => {
  const { userId } = c.get('user');
  const { id } = c.req.param();
  await db.delete(subscriptions).where(and(eq(subscriptions.id, id), eq(subscriptions.customerId, userId)));
  return c.json({ ok: true });
});

export default router;
