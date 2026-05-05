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
  chain?: string;
}

export const ACHIEVEMENT_DEFS: AchievementDef[] = [
  // ─── Chain 1: Заказы исполнителя ───────────────────────────────
  { id: 'first_order',  chain: 'orders',    title: 'Первый шаг',       description: 'Выполни 1 заказ',          icon: '🎉', xp: 15 },
  { id: 'orders_5',     chain: 'orders',    title: 'В ритме',           description: 'Выполни 5 заказов',        icon: '⭐', xp: 30 },
  { id: 'orders_10',    chain: 'orders',    title: 'Опытный',           description: 'Выполни 10 заказов',       icon: '🔟', xp: 60 },
  { id: 'orders_25',    chain: 'orders',    title: 'Ветеран',           description: 'Выполни 25 заказов',       icon: '💪', xp: 100 },
  { id: 'orders_50',    chain: 'orders',    title: 'Профи',             description: 'Выполни 50 заказов',       icon: '🏆', xp: 200 },
  { id: 'orders_100',   chain: 'orders',    title: 'Сотня',             description: 'Выполни 100 заказов',      icon: '💎', xp: 350 },
  { id: 'orders_250',   chain: 'orders',    title: 'Мастер',            description: 'Выполни 250 заказов',      icon: '👑', xp: 500 },
  { id: 'orders_500',   chain: 'orders',    title: 'Легенда',           description: 'Выполни 500 заказов',      icon: '🌠', xp: 1000 },

  // ─── Chain 2: Рейтинг ──────────────────────────────────────────
  { id: 'first_rating', chain: 'rating',    title: 'Первый отзыв',      description: 'Получи первую оценку',     icon: '💬', xp: 10 },
  { id: 'perfect_5',    chain: 'rating',    title: 'Пятёрочник',        description: 'Получи оценку 5 звёзд',   icon: '🌟', xp: 10 },
  { id: 'ratings_10',   chain: 'rating',    title: 'Любимчик',          description: 'Получи 10 оценок',         icon: '💛', xp: 40 },
  { id: 'ratings_50',   chain: 'rating',    title: 'Народный выбор',    description: 'Получи 50 оценок',         icon: '🏅', xp: 150 },

  // ─── Chain 3: Качество сервиса ─────────────────────────────────
  { id: 'quality_4_5',  chain: 'quality',   title: 'Хороший сервис',    description: 'Средний рейтинг 4.5+ за 5 заказов',  icon: '⭐', xp: 50 },
  { id: 'quality_4_8',  chain: 'quality',   title: 'Отличный сервис',   description: 'Средний рейтинг 4.8+ за 10 заказов', icon: '🌟', xp: 120 },
  { id: 'quality_5_0',  chain: 'quality',   title: 'Безупречный',       description: 'Средний рейтинг 5.0 за 10 заказов',  icon: '💫', xp: 250 },

  // ─── Chain 4: ASAP ─────────────────────────────────────────────
  { id: 'asap_job_1',   chain: 'asap',      title: 'Срочный вывоз',     description: 'Выполни срочный заказ',    icon: '⚡', xp: 10 },
  { id: 'asap_job_10',  chain: 'asap',      title: 'Мистер ASAP',       description: 'Выполни 10 срочных',       icon: '🚀', xp: 50 },
  { id: 'asap_job_50',  chain: 'asap',      title: 'Молния',            description: 'Выполни 50 срочных',       icon: '⚡⚡', xp: 150 },

  // ─── Chain 5: Объём (мешки) ────────────────────────────────────
  { id: 'volume_10',    chain: 'volume',    title: 'Носильщик',         description: 'Вынеси 10 мешков суммарно',   icon: '🎒', xp: 20 },
  { id: 'volume_50',    chain: 'volume',    title: 'Грузчик',           description: 'Вынеси 50 мешков суммарно',   icon: '📦', xp: 75 },
  { id: 'volume_200',   chain: 'volume',    title: 'Силач',             description: 'Вынеси 200 мешков суммарно',  icon: '💪', xp: 200 },
  { id: 'volume_500',   chain: 'volume',    title: 'Геркулес',          description: 'Вынеси 500 мешков суммарно',  icon: '🏋️', xp: 400 },

  // ─── Chain 6: Районы Казани ────────────────────────────────────
  { id: 'districts_2',  chain: 'districts', title: 'Путешественник',    description: 'Работай в 2 районах города',  icon: '🗺️', xp: 30 },
  { id: 'districts_4',  chain: 'districts', title: 'Городской',         description: 'Работай в 4 районах города',  icon: '🌆', xp: 80 },
  { id: 'districts_7',  chain: 'districts', title: 'Хозяин города',     description: 'Работай во всех 7 районах',   icon: '🏙️', xp: 200 },

  // ─── Chain 7: Ранняя пташка ────────────────────────────────────
  { id: 'morning_1',    chain: 'morning',   title: 'Ранняя пташка',     description: 'Выполни заказ до 09:00',      icon: '🌅', xp: 25 },
  { id: 'morning_5',    chain: 'morning',   title: 'Жаворонок',         description: 'Выполни 5 заказов до 09:00',  icon: '☀️', xp: 75 },

  // ─── Chain 8: Ночная смена ─────────────────────────────────────
  { id: 'night_1',      chain: 'night',     title: 'Ночная смена',      description: 'Выполни заказ после 21:00',   icon: '🌙', xp: 25 },
  { id: 'night_5',      chain: 'night',     title: 'Сова',              description: 'Выполни 5 заказов после 21:00', icon: '🦉', xp: 75 },

  // ─── Chain 9: Выходные ─────────────────────────────────────────
  { id: 'weekend_3',    chain: 'weekend',   title: 'Выходной герой',    description: 'Выполни 3 заказа в выходные', icon: '📅', xp: 40 },
  { id: 'weekend_10',   chain: 'weekend',   title: 'Без выходных',      description: 'Выполни 10 заказов в выходные', icon: '🔥', xp: 100 },

  // ─── Chain 10: Реферралы ───────────────────────────────────────
  { id: 'first_ref',    chain: 'referral',  title: 'Наставник',         description: 'Пригласи 1 человека',         icon: '🤝', xp: 25 },
  { id: 'refs_3',       chain: 'referral',  title: 'Бригадир',          description: 'Пригласи 3 человека',         icon: '👷', xp: 75 },
  { id: 'refs_5',       chain: 'referral',  title: 'Подрядчик',         description: 'Пригласи 5 человек',          icon: '🏗️', xp: 150 },
  { id: 'refs_10',      chain: 'referral',  title: 'Вербовщик',         description: 'Пригласи 10 человек',         icon: '🎯', xp: 300 },

  // ─── Chain 11: Заказчик (создание заказов) ─────────────────────
  { id: 'customer_first',    chain: 'customer', title: 'Первый заказ',   description: 'Создай первый заказ',         icon: '🎊', xp: 10 },
  { id: 'customer_orders_5', chain: 'customer', title: 'Постоянный',     description: 'Создай 5 заказов',            icon: '🔄', xp: 30 },
  { id: 'customer_orders_20',chain: 'customer', title: 'Верный клиент',  description: 'Создай 20 заказов',           icon: '💎', xp: 100 },
  { id: 'customer_orders_50',chain: 'customer', title: 'Постоянный клиент', description: 'Создай 50 заказов',        icon: '👑', xp: 250 },

  // ─── Chain 12: Экология (заказчик) ────────────────────────────
  { id: 'eco_1',        chain: 'eco',       title: 'Эко-старт',         description: 'Первый вклад в чистоту города', icon: '🌱', xp: 20 },
  { id: 'eco_10',       chain: 'eco',       title: 'Эко-боец',          description: '10 вывозов за чистый город',  icon: '♻️', xp: 60 },
  { id: 'eco_50',       chain: 'eco',       title: 'Эко-герой',         description: '50 вывозов — ты меняешь мир', icon: '🌍', xp: 150 },

  // ─── Chain 13: Транспорт ───────────────────────────────────────
  { id: 'vehicle_car',   chain: 'vehicle',  title: 'Автомобилист',      description: 'Выполни 5 заказов на машине',  icon: '🚗', xp: 40 },
  { id: 'vehicle_truck', chain: 'vehicle',  title: 'Дальнобойщик',      description: 'Выполни 5 заказов на газели', icon: '🚚', xp: 60 },

  // ─── Chain 14: Верность платформе ─────────────────────────────
  { id: 'tenure_30',    chain: 'tenure',    title: 'Свой человек',      description: 'Месяц на платформе',          icon: '📅', xp: 50 },
  { id: 'tenure_180',   chain: 'tenure',    title: 'Ветеран платформы', description: 'Полгода на платформе',        icon: '🏆', xp: 150 },
];

// Extended XP thresholds — 11 levels
const XP_THRESHOLDS = [0, 100, 250, 500, 900, 1400, 2100, 3000, 4200, 5800, 8000];

export function calcLevel(xp: number): number {
  for (let i = XP_THRESHOLDS.length - 1; i >= 0; i--) {
    if (xp >= XP_THRESHOLDS[i]) return i + 1;
  }
  return 1;
}

async function unlockAchievement(userId: string, def: AchievementDef): Promise<boolean> {
  const existing = await db.select()
    .from(userAchievements)
    .where(and(eq(userAchievements.userId, userId), eq(userAchievements.achievementId, def.id)))
    .limit(1);
  if (existing.length > 0) return false;

  await db.insert(userAchievements).values({ userId, achievementId: def.id, xpRewarded: def.xp });

  const [u] = await db.select({ xp: users.xp }).from(users).where(eq(users.id, userId)).limit(1);
  if (u) {
    const newXp = u.xp + def.xp;
    await db.update(users).set({ xp: newXp, level: calcLevel(newXp) }).where(eq(users.id, userId));
  }
  return true;
}

// ─── Chain 1: Order count ──────────────────────────────────────────────────
export async function checkOrderAchievements(userId: string, role: 'customer' | 'contractor') {
  const field = role === 'contractor' ? orders.contractorId : orders.customerId;
  const [row] = await db.select({ cnt: drizzleCount() })
    .from(orders)
    .where(and(eq(field, userId), eq(orders.status, 'completed')));
  const cnt = Number(row?.cnt ?? 0);

  const milestones = [
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

// ─── Chains 2+3: Rating count + quality ───────────────────────────────────
export async function checkRatingAchievements(userId: string, ratingReceived: number) {
  const ratingRows = await db.select({ rating: orders.ratingByCustomer })
    .from(orders)
    .where(and(eq(orders.contractorId, userId), sql`${orders.ratingByCustomer} IS NOT NULL`));

  const cnt = ratingRows.length;
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

  // Quality chain
  if (cnt >= 5) {
    const avg = ratingRows.reduce((s, r) => s + (r.rating ?? 0), 0) / cnt;
    if (avg >= 4.5) {
      const def = ACHIEVEMENT_DEFS.find(d => d.id === 'quality_4_5');
      if (def) await unlockAchievement(userId, def);
    }
    if (cnt >= 10 && avg >= 4.8) {
      const def = ACHIEVEMENT_DEFS.find(d => d.id === 'quality_4_8');
      if (def) await unlockAchievement(userId, def);
    }
    if (cnt >= 10 && avg >= 5.0) {
      const def = ACHIEVEMENT_DEFS.find(d => d.id === 'quality_5_0');
      if (def) await unlockAchievement(userId, def);
    }
  }
}

// ─── Chain 4: ASAP ─────────────────────────────────────────────────────────
export async function checkAsapAchievements(userId: string) {
  const [row] = await db.select({ cnt: drizzleCount() })
    .from(orders)
    .where(and(eq(orders.contractorId, userId), eq(orders.status, 'completed'), eq(orders.asap, true)));
  const cnt = Number(row?.cnt ?? 0);

  for (const m of [{ count: 1, id: 'asap_job_1' }, { count: 10, id: 'asap_job_10' }, { count: 50, id: 'asap_job_50' }]) {
    if (cnt >= m.count) {
      const def = ACHIEVEMENT_DEFS.find(d => d.id === m.id);
      if (def) await unlockAchievement(userId, def);
    }
  }
}

// ─── Chain 5: Volume (total bags carried) ──────────────────────────────────
export async function checkVolumeAchievements(userId: string) {
  const [row] = await db
    .select({ total: sql<number>`COALESCE(SUM(${orders.volume}), 0)` })
    .from(orders)
    .where(and(eq(orders.contractorId, userId), eq(orders.status, 'completed')));
  const total = Number(row?.total ?? 0);

  for (const m of [{ count: 10, id: 'volume_10' }, { count: 50, id: 'volume_50' }, { count: 200, id: 'volume_200' }, { count: 500, id: 'volume_500' }]) {
    if (total >= m.count) {
      const def = ACHIEVEMENT_DEFS.find(d => d.id === m.id);
      if (def) await unlockAchievement(userId, def);
    }
  }
}

// ─── Chain 6: Districts ────────────────────────────────────────────────────
export async function checkDistrictAchievements(userId: string) {
  const rows = await db
    .selectDistinct({ district: orders.district })
    .from(orders)
    .where(and(eq(orders.contractorId, userId), eq(orders.status, 'completed')));
  const cnt = rows.length;

  for (const m of [{ count: 2, id: 'districts_2' }, { count: 4, id: 'districts_4' }, { count: 7, id: 'districts_7' }]) {
    if (cnt >= m.count) {
      const def = ACHIEVEMENT_DEFS.find(d => d.id === m.id);
      if (def) await unlockAchievement(userId, def);
    }
  }
}

// ─── Chains 7+8+9: Time of day + weekends ─────────────────────────────────
export async function checkTimeAchievements(userId: string) {
  const rows = await db
    .select({ scheduledAt: orders.scheduledAt, createdAt: orders.createdAt })
    .from(orders)
    .where(and(eq(orders.contractorId, userId), eq(orders.status, 'completed')));

  let morningCount = 0;
  let nightCount = 0;
  let weekendCount = 0;

  for (const o of rows) {
    const dt = o.scheduledAt ?? o.createdAt;
    const hour = dt.getHours();
    const dow = dt.getDay();
    if (hour < 9) morningCount++;
    if (hour >= 21) nightCount++;
    if (dow === 0 || dow === 6) weekendCount++;
  }

  const checks = [
    { cnt: morningCount, milestones: [{ count: 1, id: 'morning_1' }, { count: 5, id: 'morning_5' }] },
    { cnt: nightCount,   milestones: [{ count: 1, id: 'night_1' },   { count: 5, id: 'night_5' }] },
    { cnt: weekendCount, milestones: [{ count: 3, id: 'weekend_3' }, { count: 10, id: 'weekend_10' }] },
  ];
  for (const { cnt, milestones } of checks) {
    for (const m of milestones) {
      if (cnt >= m.count) {
        const def = ACHIEVEMENT_DEFS.find(d => d.id === m.id);
        if (def) await unlockAchievement(userId, def);
      }
    }
  }
}

// ─── Chain 10: Referrals ───────────────────────────────────────────────────
export async function checkReferralAchievements(referrerId: string) {
  const [row] = await db.select({ cnt: drizzleCount() })
    .from(referrals)
    .where(eq(referrals.referrerId, referrerId));
  const cnt = Number(row?.cnt ?? 0);

  for (const m of [{ count: 1, id: 'first_ref' }, { count: 3, id: 'refs_3' }, { count: 5, id: 'refs_5' }, { count: 10, id: 'refs_10' }]) {
    if (cnt >= m.count) {
      const def = ACHIEVEMENT_DEFS.find(d => d.id === m.id);
      if (def) await unlockAchievement(referrerId, def);
    }
  }
}

// ─── Chain 11: Customer order creation ────────────────────────────────────
export async function checkCustomerOrderAchievements(userId: string) {
  const [row] = await db.select({ cnt: drizzleCount() })
    .from(orders)
    .where(eq(orders.customerId, userId));
  const cnt = Number(row?.cnt ?? 0);

  for (const m of [{ count: 1, id: 'customer_first' }, { count: 5, id: 'customer_orders_5' }, { count: 20, id: 'customer_orders_20' }, { count: 50, id: 'customer_orders_50' }]) {
    if (cnt >= m.count) {
      const def = ACHIEVEMENT_DEFS.find(d => d.id === m.id);
      if (def) await unlockAchievement(userId, def);
    }
  }
}

// ─── Chain 12: Eco (customer completed orders) ────────────────────────────
export async function checkEcoAchievements(userId: string) {
  const [row] = await db.select({ cnt: drizzleCount() })
    .from(orders)
    .where(and(eq(orders.customerId, userId), eq(orders.status, 'completed')));
  const cnt = Number(row?.cnt ?? 0);

  for (const m of [{ count: 1, id: 'eco_1' }, { count: 10, id: 'eco_10' }, { count: 50, id: 'eco_50' }]) {
    if (cnt >= m.count) {
      const def = ACHIEVEMENT_DEFS.find(d => d.id === m.id);
      if (def) await unlockAchievement(userId, def);
    }
  }
}

// ─── Chain 13: Vehicle type ────────────────────────────────────────────────
export async function checkVehicleAchievements(userId: string) {
  const [u] = await db.select({ transportMode: users.transportMode }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u) return;

  const [row] = await db.select({ cnt: drizzleCount() })
    .from(orders)
    .where(and(eq(orders.contractorId, userId), eq(orders.status, 'completed')));
  const cnt = Number(row?.cnt ?? 0);

  if (cnt >= 5 && u.transportMode === 'car') {
    const def = ACHIEVEMENT_DEFS.find(d => d.id === 'vehicle_car');
    if (def) await unlockAchievement(userId, def);
  }
  if (cnt >= 5 && u.transportMode === 'truck') {
    const def = ACHIEVEMENT_DEFS.find(d => d.id === 'vehicle_truck');
    if (def) await unlockAchievement(userId, def);
  }
}

// ─── Chain 14: Tenure ─────────────────────────────────────────────────────
export async function checkTenureAchievements(userId: string) {
  const [u] = await db.select({ createdAt: users.createdAt }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u) return;

  const daysSince = (Date.now() - u.createdAt.getTime()) / (1000 * 60 * 60 * 24);

  if (daysSince >= 30) {
    const def = ACHIEVEMENT_DEFS.find(d => d.id === 'tenure_30');
    if (def) await unlockAchievement(userId, def);
  }
  if (daysSince >= 180) {
    const def = ACHIEVEMENT_DEFS.find(d => d.id === 'tenure_180');
    if (def) await unlockAchievement(userId, def);
  }
}
