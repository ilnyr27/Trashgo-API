import { Hono } from 'hono';
import { eq, and, isNotNull, avg, count, desc } from 'drizzle-orm';
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
  notifPush: z.boolean().optional(),
  notifEmail: z.boolean().optional(),
  notifEmailAddress: z.string().email().max(200).optional().nullable(),
  fcmToken: z.string().max(300).optional().nullable(),
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
      notifPush: u.notifPush ?? true,
      notifEmail: u.notifEmail ?? false,
      notifEmailAddress: u.notifEmailAddress ?? null,
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

  const { addresses, notifEmailAddress, fcmToken, ...rest } = parsed.data;
  const dbSet: Record<string, unknown> = { ...rest };
  if (addresses !== undefined) dbSet.addresses = JSON.stringify(addresses);
  if (notifEmailAddress !== undefined) dbSet.notifEmailAddress = notifEmailAddress;
  if (fcmToken !== undefined) dbSet.fcmToken = fcmToken;

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
      notifPush: u.notifPush ?? true,
      notifEmail: u.notifEmail ?? false,
      notifEmailAddress: u.notifEmailAddress ?? null,
      createdAt: u.createdAt.toISOString(),
    },
  });
});

// GET /users/payment-history — last 50 completed transactions
usersRouter.get('/payment-history', async (c) => {
  const { userId } = c.get('user');
  const userRow = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  if (!userRow.length) return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);

  const isContractor = userRow[0].role === 'contractor';
  const history = await db.select({
    id: orders.id,
    price: orders.price,
    address: orders.address,
    district: orders.district,
    updatedAt: orders.updatedAt,
  }).from(orders)
    .where(
      isContractor
        ? and(eq(orders.contractorId, userId), eq(orders.status, 'completed'))
        : and(eq(orders.customerId, userId), eq(orders.status, 'completed'))
    )
    .orderBy(desc(orders.updatedAt))
    .limit(50);

  return c.json({
    data: history.map(o => ({
      id: o.id,
      amount: o.price,
      address: o.address,
      district: o.district,
      date: o.updatedAt.toISOString(),
      type: isContractor ? 'earning' : 'payment',
    })),
  });
});

// GET /users/contractors — list of contractors with stats (for customer "find contractors" view)
usersRouter.get('/contractors', async (c) => {
  const district = c.req.query('district') || null;

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      district: users.district,
      transportMode: users.transportMode,
      level: users.level,
      xp: users.xp,
      completedOrders: count(orders.id),
      avgRating: avg(orders.ratingByCustomer),
      ratingCount: count(orders.ratingByCustomer),
    })
    .from(users)
    .leftJoin(
      orders,
      and(eq(orders.contractorId, users.id), eq(orders.status, 'completed'))
    )
    .where(
      district
        ? and(eq(users.role, 'contractor'), eq(users.district, district))
        : eq(users.role, 'contractor')
    )
    .groupBy(users.id, users.name, users.district, users.transportMode, users.level, users.xp)
    .orderBy(desc(count(orders.id)))
    .limit(50);

  return c.json({
    data: rows.map(r => ({
      id: r.id,
      name: r.name,
      district: r.district,
      transportMode: r.transportMode,
      level: Number(r.level),
      xp: Number(r.xp),
      completedOrders: Number(r.completedOrders),
      avgRating: r.avgRating ? Number(Number(r.avgRating).toFixed(1)) : null,
      ratingCount: Number(r.ratingCount),
    })),
  });
});

export default usersRouter;
