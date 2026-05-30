import { db } from '../db/index.js';
import { subscriptions, orders, users } from '../db/schema.js';
import { eq, and, gte } from 'drizzle-orm';
import { emitToUser } from '../ws.js';
import { sendSubscriptionOrderEmail } from './email.js';

// Prevent double-run within the same calendar day (Moscow time)
let lastRunDate = '';

/** Returns current date string and hour in Moscow time (UTC+3). */
function moscowNow() {
  const now = new Date();
  // Use Intl to get Moscow date reliably (handles DST-free zone correctly)
  const dateStr = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' }); // 'YYYY-MM-DD'
  const hour = parseInt(now.toLocaleTimeString('en-US', { timeZone: 'Europe/Moscow', hour: 'numeric', hour12: false }), 10);
  const jsDay = new Date(dateStr + 'T12:00:00+03:00').getDay(); // 0=Sun
  const isoDay = jsDay === 0 ? 7 : jsDay; // 1=Mon…7=Sun
  return { dateStr, hour, isoDay };
}

/** Create orders from all active subscriptions that match today's weekday. */
export async function runSubscriptionCron() {
  const { dateStr, hour, isoDay } = moscowNow();

  // Run only between 06:00–06:59 Moscow time
  if (hour !== 6) return;

  // Avoid double-run within same day
  if (lastRunDate === dateStr) return;
  lastRunDate = dateStr;

  console.log(`[SubscriptionCron] ${dateStr} weekday=${isoDay}`);

  const allSubs = await db.select().from(subscriptions).where(eq(subscriptions.active, true));
  let created = 0;

  for (const sub of allSubs) {
    let days: number[];
    try { days = JSON.parse(sub.days); } catch { continue; }

    if (!days.includes(isoDay)) continue;

    // Check interval: biweekly = every other week, monthly = first occurrence of weekday in month
    const subInterval = (sub as any).interval ?? 'weekly';
    if (subInterval === 'biweekly') {
      // Count how many full weeks have passed since subscription was created
      const createdMoscow = new Date(sub.createdAt.getTime());
      const todayMs = new Date(`${dateStr}T12:00:00+03:00`).getTime();
      const weeksSinceCreation = Math.floor((todayMs - createdMoscow.getTime()) / (7 * 24 * 60 * 60 * 1000));
      if (weeksSinceCreation % 2 !== 0) continue;  // skip odd weeks
    } else if (subInterval === 'monthly') {
      // Only run on the first occurrence of this weekday in the current month
      const todayDate = new Date(`${dateStr}T12:00:00+03:00`);
      const dayOfMonth = todayDate.getDate();
      if (dayOfMonth > 7) continue;  // first occurrence is always within days 1-7
    }

    // Dedup: skip if we already created an order from this subscription today
    const todayMidnightMoscow = new Date(`${dateStr}T00:00:00+03:00`);
    const existing = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(
        eq(orders.subscriptionId, sub.id),
        gte(orders.createdAt, todayMidnightMoscow),
      ))
      .limit(1);

    if (existing.length > 0) continue;

    // Build scheduledAt: today at sub.time in Moscow time
    const scheduledAt = new Date(`${dateStr}T${sub.time}:00+03:00`);

    try {
      const hasContractor = !!sub.contractorId;
      const [newOrder] = await db.insert(orders).values({
        customerId: sub.customerId,
        subscriptionId: sub.id,
        address: sub.address,
        district: sub.district,
        volume: sub.volume,
        price: sub.price,
        description: sub.description || 'Создан автоматически по подписке',
        asap: false,
        scheduledAt,
        status: hasContractor ? 'accepted' : 'new',
        ...(hasContractor ? { contractorId: sub.contractorId! } : {}),
      }).returning({ id: orders.id });

      emitToUser(sub.customerId, {
        type: 'subscription_order_created',
        title: '📅 Заказ по подписке создан',
        message: hasContractor
          ? `Заказ на ${dateStr} назначен вашему исполнителю`
          : `Заказ на ${dateStr} по адресу ${sub.address} выставлен исполнителям`,
        orderId: newOrder.id,
      });

      // Email notification (fire and forget)
      db.select({ email: users.notifEmailAddress, notif: users.notifEmail })
        .from(users).where(eq(users.id, sub.customerId)).limit(1)
        .then(([u]) => {
          if (u?.notif && u.email) {
            sendSubscriptionOrderEmail(u.email, {
              address: sub.address,
              scheduledDate: scheduledAt.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long' }),
              price: sub.price,
            }).catch((e: any) => console.error('[SubscriptionCron] Email error:', e?.message));
          }
        }).catch((e: any) => console.error('[SubscriptionCron] Email fetch error:', e?.message));

      created++;
      console.log(`[SubscriptionCron] Created order ${newOrder.id} for sub ${sub.id}`);
    } catch (e: any) {
      console.error(`[SubscriptionCron] Failed for sub ${sub.id}:`, e.message);
    }
  }

  console.log(`[SubscriptionCron] Done: ${created} orders created`);
}

/**
 * Start the subscription cron.
 * Checks every 30 minutes if it's the 6 AM window; also tries once on startup
 * (catches up if the server was restarted during the 6 AM hour).
 */
export function startSubscriptionCron() {
  setInterval(runSubscriptionCron, 30 * 60 * 1000);
  // Delayed startup check so DB is ready
  setTimeout(runSubscriptionCron, 8000);
}
