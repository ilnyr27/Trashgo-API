import { eq, and, count as drizzleCount } from 'drizzle-orm';
import { db } from '../db/index.js';
import { orders, referrals, userAchievements, users } from '../db/schema.js';
import { sql } from 'drizzle-orm';

export interface AchievementDef {
  id: string;
  title: string;
  description: string;
  icon: string;
  xp: number;
}

export const ACHIEVEMENT_DEFS: AchievementDef[] = [
  // Order-based milestones (sequential chain — both roles)
  { id: 'first_order',  title: 'Первый шаг',      description: 'Выполни 1 заказ',       icon: '🎉', xp: 15 },
  { id: 'orders_5',     title: 'В ритме',          description: 'Выполни 5 заказов',     icon: '⭐', xp: 30 },
  { id: 'orders_10',    title: 'Опытный',          description: 'Выполни 10 заказов',    icon: '🔟', xp: 60 },
  { id: 'orders_25',    title: 'Ветеран',          description: 'Выполни 25 заказов',    icon: '💪', xp: 100 },
  { id: 'orders_50',    title: 'Профи',            description: 'Выполни 50 заказов',    icon: '🏆', xp: 200 },
  { id: 'orders_100',   title: 'Сотня',            description: 'Выполни 100 заказов',   icon: '💎', xp: 350 },
  { id: 'orders_250',   title: 'Мастер',           description: 'Выполни 250 заказов',   icon: '👑', xp: 500 },
  { id: 'orders_500',   title: 'Легенда',          description: 'Выполни 500 заказов',   icon: '🌠', xp: 1000 },
  // Rating-based (contractor only)
  { id: 'first_rating', title: 'Первый отзыв',     description: 'Получи первую оценку',  icon: '💬', xp: 10 },
  { id: 'perfect_5',    title: 'Пятёрочник',       description: 'Получи оценку 5 звёзд', icon: '🌟', xp: 10 },
  { id: 'ratings_10',   title: 'Любимчик',         description: 'Получи 10 оценок',      icon: '💛', xp: 40 },
  { id: 'ratings_50',   title: 'Народный выбор',   description: 'Получи 50 оценок',      icon: '🏅', xp: 150 },
  // Referral-based
  { id: 'first_ref',    title: 'Наставник',        description: 'Пригласи 1 человека',   icon: '🤝', xp: 25 },
  { id: 'refs_3',       title: 'Бригадир',         description: 'Пригласи 3 человека',   icon: '👷', xp: 75 },
  { id: 'refs_5',       title: 'Подрядчик',        description: 'Пригласи 5 человек',    icon: '🏗️', xp: 150 },
  { id: 'refs_10',      title: 'Вербовщик',        description: 'Пригласи 10 человек',   icon: '🎯', xp: 300 },
  // ASAP-based (contractor completing urgent orders)
  { id: 'asap_job_1',   title: 'Срочный вывоз',    description: 'Выполни срочный заказ', icon: '⚡', xp: 10 },
  { id: 'asap_job_10',  title: 'Мистер ASAP',      description: 'Выполни 10 срочных',   icon: '🚀', xp: 50 },
  { id: 'asap_job_50',  title: 'Молния',           description: 'Выполни 50 срочных',   icon: '⚡⚡', xp: 150 },
];

const XP_THRESHOLDS = [0, 100, 200, 400, 700, 1000];
function calcLevel(xp: number): number {
  for (let i = XP_THRESHOLDS.length - 1; i >= 0; i--) {
    if (xp >= XP_THRESHOLDS[i]) return i + 1;
  }
  return 1;
}

// Award XP and unlock achievement if not already unlocked
async function unlockAchievement(userId: string, def: AchievementDef): Promise<boolean> {
  const existing = await db.select()
    .from(userAchievements)
    .where(and(eq(userAchievements.userId, userId), eq(userAchievements.achievementId, def.id)))
    .limit(1);
  if (existing.length > 0) return false;

  await db.insert(userAchievements).values({ userId, achievementId: def.id, xpRewarded: def.xp });

  // Award bonus XP to user
  const [u] = await db.select({ xp: users.xp }).from(users).where(eq(users.id, userId)).limit(1);
  if (u) {
    const newXp = u.xp + def.xp;
    await db.update(users).set({ xp: newXp, level: calcLevel(newXp) }).where(eq(users.id, userId));
  }
  return true;
}

// Check and award order-count achievements
export async function checkOrderAchievements(userId: string, role: 'customer' | 'contractor') {
  const field = role === 'contractor' ? orders.contractorId : orders.customerId;
  const [row] = await db.select({ cnt: drizzleCount() })
    .from(orders)
    .where(and(eq(field, userId), eq(orders.status, 'completed')));
  const cnt = Number(row?.cnt ?? 0);

  const milestones: Array<{ count: number; id: string }> = [
    { count: 1,   id: 'first_order' },
    { count: 5,   id: 'orders_5' },
    { count: 10,  id: 'orders_10' },
    { count: 25,  id: 'orders_25' },
    { count: 50,  id: 'orders_50' },
    { count: 100, id: 'orders_100' },
    { count: 250, id: 'orders_250' },
    { count: 500, id: 'orders_500' },
  ];

  for (const m of milestones) {
    if (cnt >= m.count) {
      const def = ACHIEVEMENT_DEFS.find(d => d.id === m.id);
      if (def) await unlockAchievement(userId, def);
    }
  }
}

// Check rating achievements — called after a rating is given to userId (contractor)
export async function checkRatingAchievements(userId: string, ratingReceived: number) {
  const [row] = await db.select({ cnt: drizzleCount() })
    .from(orders)
    .where(and(
      eq(orders.contractorId, userId),
      sql`rating_by_customer IS NOT NULL`,
    ));
  const cnt = Number(row?.cnt ?? 0);

  const ratingMilestones = [
    { count: 1,  id: 'first_rating' },
    { count: 10, id: 'ratings_10' },
    { count: 50, id: 'ratings_50' },
  ];
  for (const m of ratingMilestones) {
    if (cnt >= m.count) {
      const def = ACHIEVEMENT_DEFS.find(d => d.id === m.id);
      if (def) await unlockAchievement(userId, def);
    }
  }
  if (ratingReceived === 5) {
    const def = ACHIEVEMENT_DEFS.find(d => d.id === 'perfect_5')!;
    await unlockAchievement(userId, def);
  }
}

// Check ASAP achievements — called for contractor after completing an asap order
export async function checkAsapAchievements(userId: string) {
  const [row] = await db.select({ cnt: drizzleCount() })
    .from(orders)
    .where(and(
      eq(orders.contractorId, userId),
      eq(orders.status, 'completed'),
      eq(orders.asap, true),
    ));
  const cnt = Number(row?.cnt ?? 0);

  const milestones = [
    { count: 1,  id: 'asap_job_1' },
    { count: 10, id: 'asap_job_10' },
    { count: 50, id: 'asap_job_50' },
  ];
  for (const m of milestones) {
    if (cnt >= m.count) {
      const def = ACHIEVEMENT_DEFS.find(d => d.id === m.id);
      if (def) await unlockAchievement(userId, def);
    }
  }
}

// Check referral achievements for the referrer
export async function checkReferralAchievements(referrerId: string) {
  const [row] = await db.select({ cnt: drizzleCount() })
    .from(referrals)
    .where(eq(referrals.referrerId, referrerId));
  const cnt = Number(row?.cnt ?? 0);

  const milestones = [
    { count: 1,  id: 'first_ref' },
    { count: 3,  id: 'refs_3' },
    { count: 5,  id: 'refs_5' },
    { count: 10, id: 'refs_10' },
  ];

  for (const m of milestones) {
    if (cnt >= m.count) {
      const def = ACHIEVEMENT_DEFS.find(d => d.id === m.id);
      if (def) await unlockAchievement(referrerId, def);
    }
  }
}
