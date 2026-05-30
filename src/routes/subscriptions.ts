import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { subscriptions, users } from '../db/schema.js';
import { authMiddleware, type JwtPayload } from '../middleware/auth.js';

const router = new Hono<{ Variables: { user: JwtPayload } }>();
router.use('*', authMiddleware);

const SubSchema = z.object({
  address: z.string().min(3).max(300),
  district: z.string().max(100).default(''),
  days: z.array(z.number().int().min(1).max(7)).min(1).refine(
    (arr) => new Set(arr).size === arr.length,
    { message: 'Days must be unique' }
  ),
  time: z.string().regex(/^\d{2}:\d{2}$/).default('18:00'),
  volume: z.number().int().min(1).max(30).default(1),
  price: z.number().int().min(1),
  description: z.string().max(500).default(''),
  contractorId: z.string().uuid().optional().nullable(),
  interval: z.enum(['weekly', 'biweekly', 'monthly']).default('weekly'),
});

function formatSub(r: typeof subscriptions.$inferSelect, contractorName?: string | null) {
  let days: number[] = [];
  try { days = JSON.parse(r.days); } catch { days = []; }
  return {
    ...r,
    days,
    contractorName: contractorName ?? null,
  };
}

// GET /subscriptions — list my subscriptions (customer)
router.get('/', async (c) => {
  const { userId } = c.get('user');
  const rows = await db
    .select({ sub: subscriptions, contractorName: users.name })
    .from(subscriptions)
    .leftJoin(users, eq(users.id, subscriptions.contractorId))
    .where(eq(subscriptions.customerId, userId));
  return c.json({ data: rows.map(({ sub, contractorName }) => formatSub(sub, contractorName)) });
});

// POST /subscriptions
router.post('/', async (c) => {
  const { userId } = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const parsed = SubSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION', message: parsed.error.message } }, 400);
  const { days, contractorId, ...rest } = parsed.data;
  const [sub] = await db.insert(subscriptions).values({
    customerId: userId,
    ...rest,
    ...(contractorId ? { contractorId } : {}),
    days: JSON.stringify(days),
  }).returning();

  let contractorName: string | null = null;
  if (sub.contractorId) {
    const [ct] = await db.select({ name: users.name }).from(users).where(eq(users.id, sub.contractorId)).limit(1);
    contractorName = ct?.name ?? null;
  }
  return c.json({ data: formatSub(sub, contractorName) }, 201);
});

// PATCH /subscriptions/:id — update (pause/resume/reschedule/reassign contractor)
router.patch('/:id', async (c) => {
  const { userId } = c.get('user');
  const { id } = c.req.param();
  const body = await c.req.json().catch(() => ({}));
  const UpdateSchema = SubSchema.partial().extend({ active: z.boolean().optional() });
  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION', message: parsed.error.message } }, 400);
  const { days, contractorId, ...rest } = parsed.data;
  const setData: Partial<typeof subscriptions.$inferInsert> = {};
  if (rest.address !== undefined) setData.address = rest.address;
  if (rest.district !== undefined) setData.district = rest.district;
  if (rest.time !== undefined) setData.time = rest.time;
  if (rest.volume !== undefined) setData.volume = rest.volume;
  if (rest.price !== undefined) setData.price = rest.price;
  if (rest.description !== undefined) setData.description = rest.description;
  if (rest.active !== undefined) setData.active = rest.active;
  if (rest.interval !== undefined) setData.interval = rest.interval;
  if (days !== undefined) setData.days = JSON.stringify(days);
  if (contractorId !== undefined) setData.contractorId = contractorId ?? undefined;
  const [sub] = await db.update(subscriptions)
    .set(setData)
    .where(and(eq(subscriptions.id, id), eq(subscriptions.customerId, userId)))
    .returning();
  if (!sub) return c.json({ error: { code: 'NOT_FOUND' } }, 404);

  let contractorName: string | null = null;
  if (sub.contractorId) {
    const [ct] = await db.select({ name: users.name }).from(users).where(eq(users.id, sub.contractorId)).limit(1);
    contractorName = ct?.name ?? null;
  }
  return c.json({ data: formatSub(sub, contractorName) });
});

// DELETE /subscriptions/:id
router.delete('/:id', async (c) => {
  const { userId } = c.get('user');
  const { id } = c.req.param();
  await db.delete(subscriptions).where(and(eq(subscriptions.id, id), eq(subscriptions.customerId, userId)));
  return c.json({ ok: true });
});

export default router;
