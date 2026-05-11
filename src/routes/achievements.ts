import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { orders, referrals, userAchievements, users } from '../db/schema.js';
import { authMiddleware, type JwtPayload } from '../middleware/auth.js';
import { ACHIEVEMENT_DEFS } from '../lib/achievements.js';

const achievementsRouter = new Hono<{ Variables: { user: JwtPayload } }>();
achievementsRouter.use('*', authMiddleware);

// GET /achievements/my — full list with unlocked status + progress per achievement
achievementsRouter.get('/my', async (c) => {
  const { userId } = c.get('user');

  const [
    unlockedRows,
    [completedContractor],
    [completedCustomer],
    [totalCustOrders],
    [asapRow],
    [volumeRow],
    distinctDistrictRows,
    ratingRows,
    [referralRow],
    [userRow],
  ] = await Promise.all([
    db.select().from(userAchievements).where(eq(userAchievements.userId, userId)),
    db.select({ cnt: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.contractorId, userId), eq(orders.status, 'completed'))),
    db.select({ cnt: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.customerId, userId), eq(orders.status, 'completed'))),
    db.select({ cnt: sql<number>`count(*)::int` }).from(orders).where(eq(orders.customerId, userId)),
    db.select({ cnt: sql<number>`count(*)::int` }).from(orders).where(and(eq(orders.contractorId, userId), eq(orders.status, 'completed'), eq(orders.asap, true))),
    db.select({ total: sql<number>`COALESCE(SUM(${orders.volume}), 0)` }).from(orders).where(and(eq(orders.contractorId, userId), eq(orders.status, 'completed'))),
    db.selectDistinct({ district: orders.district }).from(orders).where(and(eq(orders.contractorId, userId), eq(orders.status, 'completed'))),
    db.select({ rating: orders.ratingByCustomer }).from(orders).where(and(eq(orders.contractorId, userId), sql`${orders.ratingByCustomer} IS NOT NULL`)),
    db.select({ cnt: sql<number>`count(*)::int` }).from(referrals).where(eq(referrals.referrerId, userId)),
    db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId)).limit(1),
  ]);

  const cc = Number(completedContractor?.cnt ?? 0);
  const cust = Number(completedCustomer?.cnt ?? 0);
  const custTotal = Number(totalCustOrders?.cnt ?? 0);
  const asap = Number(asapRow?.cnt ?? 0);
  const vol = Number(volumeRow?.total ?? 0);
  const dists = distinctDistrictRows.length;
  const ratings = ratingRows.length;
  const refs = Number(referralRow?.cnt ?? 0);
  const daysSince = userRow ? (Date.now() - new Date(userRow.createdAt).getTime()) / 86400000 : 0;

  const progressMap: Record<string, { progress: number; maxProgress: number }> = {
    first_order:         { progress: Math.min(cc, 1),   maxProgress: 1 },
    orders_5:            { progress: Math.min(cc, 5),   maxProgress: 5 },
    orders_10:           { progress: Math.min(cc, 10),  maxProgress: 10 },
    orders_25:           { progress: Math.min(cc, 25),  maxProgress: 25 },
    orders_50:           { progress: Math.min(cc, 50),  maxProgress: 50 },
    orders_100:          { progress: Math.min(cc, 100), maxProgress: 100 },
    orders_250:          { progress: Math.min(cc, 250), maxProgress: 250 },
    orders_500:          { progress: Math.min(cc, 500), maxProgress: 500 },
    first_rating:        { progress: Math.min(ratings, 1),  maxProgress: 1 },
    ratings_10:          { progress: Math.min(ratings, 10), maxProgress: 10 },
    ratings_50:          { progress: Math.min(ratings, 50), maxProgress: 50 },
    asap_job_1:          { progress: Math.min(asap, 1),  maxProgress: 1 },
    asap_job_10:         { progress: Math.min(asap, 10), maxProgress: 10 },
    asap_job_50:         { progress: Math.min(asap, 50), maxProgress: 50 },
    volume_10:           { progress: Math.min(vol, 10),  maxProgress: 10 },
    volume_50:           { progress: Math.min(vol, 50),  maxProgress: 50 },
    volume_200:          { progress: Math.min(vol, 200), maxProgress: 200 },
    volume_500:          { progress: Math.min(vol, 500), maxProgress: 500 },
    districts_2:         { progress: Math.min(dists, 2), maxProgress: 2 },
    districts_4:         { progress: Math.min(dists, 4), maxProgress: 4 },
    districts_7:         { progress: Math.min(dists, 7), maxProgress: 7 },
    first_ref:           { progress: Math.min(refs, 1),  maxProgress: 1 },
    refs_3:              { progress: Math.min(refs, 3),  maxProgress: 3 },
    refs_5:              { progress: Math.min(refs, 5),  maxProgress: 5 },
    refs_10:             { progress: Math.min(refs, 10), maxProgress: 10 },
    customer_first:      { progress: Math.min(custTotal, 1),  maxProgress: 1 },
    customer_orders_5:   { progress: Math.min(custTotal, 5),  maxProgress: 5 },
    customer_orders_20:  { progress: Math.min(custTotal, 20), maxProgress: 20 },
    customer_orders_50:  { progress: Math.min(custTotal, 50), maxProgress: 50 },
    eco_1:               { progress: Math.min(cust, 1),  maxProgress: 1 },
    eco_10:              { progress: Math.min(cust, 10), maxProgress: 10 },
    eco_50:              { progress: Math.min(cust, 50), maxProgress: 50 },
    tenure_30:           { progress: Math.min(Math.floor(daysSince), 30),  maxProgress: 30 },
    tenure_180:          { progress: Math.min(Math.floor(daysSince), 180), maxProgress: 180 },
  };

  const unlockedIds = new Set(unlockedRows.map(u => u.achievementId));

  const result = ACHIEVEMENT_DEFS.map(def => ({
    id: def.id,
    title: def.title,
    description: def.description,
    icon: def.icon,
    xp: def.xp,
    chain: def.chain,
    unlocked: unlockedIds.has(def.id),
    unlockedAt: unlockedRows.find(u => u.achievementId === def.id)?.unlockedAt?.toISOString() ?? null,
    ...(progressMap[def.id] ?? {}),
  }));

  return c.json({ data: result });
});

export default achievementsRouter;
