import { Hono } from 'hono';
import { db } from '../db/index.js';
import { orders, users } from '../db/schema.js';
import { eq, desc, and, count as drizzleCount, avg } from 'drizzle-orm';

const router = new Hono();

// GET /leaderboard?district=xxx&limit=20
router.get('/', async (c) => {
  const district = c.req.query('district');
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 50);

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      district: users.district,
      level: users.level,
      xp: users.xp,
      ordersCompleted: drizzleCount(orders.id),
      avgRating: avg(orders.ratingByCustomer),
    })
    .from(orders)
    .innerJoin(users, eq(users.id, orders.contractorId))
    .where(
      district
        ? and(eq(orders.status, 'completed'), eq(users.district, district))
        : eq(orders.status, 'completed')
    )
    .groupBy(users.id, users.name, users.district, users.level, users.xp)
    .orderBy(desc(drizzleCount(orders.id)))
    .limit(limit);

  return c.json({
    data: rows.map((r, i) => ({
      rank: i + 1,
      id: r.id,
      name: r.name,
      district: r.district,
      level: r.level,
      xp: r.xp,
      ordersCompleted: Number(r.ordersCompleted),
      avgRating: r.avgRating ? Number(Number(r.avgRating).toFixed(1)) : null,
    })),
  });
});

export default router;
