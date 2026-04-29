import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { users, referrals } from '../db/schema.js';
import { authMiddleware, type JwtPayload } from '../middleware/auth.js';

const referralsRouter = new Hono<{ Variables: { user: JwtPayload } }>();

referralsRouter.use('*', authMiddleware);

const FRONTEND_URL = 'https://trashgo-gamma.vercel.app';

// GET /referrals/my
referralsRouter.get('/my', async (c) => {
  const { userId } = c.get('user');

  const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (userRows.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  let user = userRows[0];

  // Generate and save referral code for existing users who don't have one
  if (!user.referralCode) {
    const code = nanoid(8).toUpperCase();
    const updated = await db.update(users).set({ referralCode: code }).where(eq(users.id, userId)).returning();
    user = updated[0];
  }

  // Optional: filter by referred user role
  const target = c.req.query('target'); // 'contractor' | 'customer' | undefined (all)

  const whereClause = target === 'contractor'
    ? and(eq(referrals.referrerId, userId), eq(users.role, 'contractor'))
    : target === 'customer'
    ? and(eq(referrals.referrerId, userId), eq(users.role, 'customer'))
    : eq(referrals.referrerId, userId);

  const myReferrals = await db
    .select({ name: users.name, role: users.role, joinedAt: users.createdAt })
    .from(referrals)
    .innerJoin(users, eq(users.id, referrals.refereeId))
    .where(whereClause);

  const baseLink = `${FRONTEND_URL}/ref/${user.referralCode}`;
  const link = target === 'contractor' ? `${baseLink}?role=contractor` : baseLink;

  return c.json({
    data: {
      code: user.referralCode,
      link,
      count: myReferrals.length,
      referrals: myReferrals.map((r) => ({
        name: r.name,
        role: r.role,
        joinedAt: r.joinedAt.toISOString(),
      })),
    },
  });
});

export default referralsRouter;
