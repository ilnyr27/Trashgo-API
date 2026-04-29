import { Hono } from 'hono';
import { eq, and, isNotNull, avg, count } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { users, orders } from '../db/schema.js';
import { authMiddleware, type JwtPayload } from '../middleware/auth.js';

const usersRouter = new Hono<{ Variables: { user: JwtPayload } }>();

usersRouter.use('*', authMiddleware);

const TRANSPORT_MODES = ['pedestrian', 'scooter', 'bicycle', 'e-bicycle', 'moto', 'car'] as const;

const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  district: z.string().min(1).max(100).optional(),
  transportMode: z.enum(TRANSPORT_MODES).optional(),
  addresses: z.array(z.string().max(300)).max(10).optional(),
});

// GET /users/me
usersRouter.get('/me', async (c) => {
  const { userId } = c.get('user');

  const result = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (result.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const u = result[0];

  // Compute avg rating: contractors receive ratingByCustomer, customers receive ratingByContractor
  const isContractor = u.role === 'contractor';
  const ratingData = await db.select({
    avgRating: avg(isContractor ? orders.ratingByCustomer : orders.ratingByContractor),
    ratingCount: count(isContractor ? orders.ratingByCustomer : orders.ratingByContractor),
  }).from(orders).where(
    isContractor
      ? and(eq(orders.contractorId, userId), isNotNull(orders.ratingByCustomer))
      : and(eq(orders.customerId, userId), isNotNull(orders.ratingByContractor))
  );

  const avgRating = ratingData[0]?.avgRating ? parseFloat(ratingData[0].avgRating) : null;
  const ratingCount = ratingData[0]?.ratingCount ?? 0;

  let parsedAddresses: string[] = [];
  try { parsedAddresses = JSON.parse(u.addresses || '[]'); } catch {}

  return c.json({
    data: {
      id: u.id,
      phone: u.phone,
      name: u.name,
      role: u.role,
      district: u.district,
      transportMode: u.transportMode,
      xp: u.xp,
      level: u.level,
      balance: u.balance,
      addresses: parsedAddresses,
      avgRating,
      ratingCount,
      createdAt: u.createdAt.toISOString(),
    },
  });
});

// PATCH /users/me
usersRouter.patch('/me', async (c) => {
  const { userId } = c.get('user');
  const body = await c.req.json();
  const parsed = updateProfileSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION', message: 'Invalid input' } }, 400);
  }

  const { addresses, ...rest } = parsed.data;
  const dbSet: Record<string, unknown> = { ...rest };
  if (addresses !== undefined) dbSet.addresses = JSON.stringify(addresses);

  const updated = await db.update(users)
    .set(dbSet as any)
    .where(eq(users.id, userId))
    .returning();

  if (updated.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const u = updated[0];
  let patchAddresses: string[] = [];
  try { patchAddresses = JSON.parse(u.addresses || '[]'); } catch {}

  return c.json({
    data: {
      id: u.id,
      phone: u.phone,
      name: u.name,
      role: u.role,
      district: u.district,
      transportMode: u.transportMode,
      xp: u.xp,
      level: u.level,
      balance: u.balance,
      addresses: patchAddresses,
      createdAt: u.createdAt.toISOString(),
    },
  });
});

export default usersRouter;
