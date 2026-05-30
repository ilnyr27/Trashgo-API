import { eq, and, gt, desc, isNotNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, accessPlans, referrals } from '../db/schema.js';

export const TRIAL_DAYS = 30;
export const PLAN_PRICE = 50;
export const REFERRAL_DISCOUNT = 10;
export const MAX_REFERRAL_BONUS = 5;

export type SubStatus = 'trial' | 'active' | 'expired';

export function trialEndsAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

export async function getSubStatus(userId: string): Promise<{ status: SubStatus; expiresAt: Date | null; trialEnd: Date }> {
  const [userRow] = await db.select({ createdAt: users.createdAt })
    .from(users).where(eq(users.id, userId)).limit(1);

  if (!userRow) return { status: 'expired', expiresAt: null, trialEnd: new Date() };

  const trialEnd = trialEndsAt(userRow.createdAt);
  const now = new Date();

  if (now < trialEnd) return { status: 'trial', expiresAt: trialEnd, trialEnd };

  const [activePlan] = await db.select({ expiresAt: accessPlans.expiresAt })
    .from(accessPlans)
    .where(and(
      eq(accessPlans.userId, userId),
      eq(accessPlans.status, 'active'),
      gt(accessPlans.expiresAt!, now),
    ))
    .orderBy(desc(accessPlans.expiresAt))
    .limit(1);

  if (activePlan?.expiresAt) return { status: 'active', expiresAt: activePlan.expiresAt, trialEnd };

  return { status: 'expired', expiresAt: null, trialEnd };
}

export async function hasActiveSubscription(userId: string): Promise<boolean> {
  const { status } = await getSubStatus(userId);
  return status === 'trial' || status === 'active';
}

export async function countActiveReferees(referrerId: string): Promise<number> {
  const now = new Date();

  const rows = await db
    .select({
      userCreatedAt: users.createdAt,
      planExpiresAt: accessPlans.expiresAt,
    })
    .from(referrals)
    .innerJoin(users, eq(users.id, referrals.refereeId))
    .leftJoin(
      accessPlans,
      and(
        eq(accessPlans.userId, referrals.refereeId),
        eq(accessPlans.status, 'active'),
        gt(accessPlans.expiresAt!, now),
      ),
    )
    .where(eq(referrals.referrerId, referrerId));

  let active = 0;
  for (const row of rows) {
    if (now < trialEndsAt(row.userCreatedAt) || row.planExpiresAt !== null) active++;
  }
  return Math.min(active, MAX_REFERRAL_BONUS);
}
