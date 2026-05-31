import { Hono } from 'hono';
import { eq, count, sum, like, desc, sql, or, ilike, and, isNotNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, orders, orderHistory, supportMessages, blockedAddresses, referrals, userAchievements, refreshTokens, otpCodes, messages, subscriptions, accessPlans, promoCodes } from '../db/schema.js';
import { notifyUser } from '../lib/notify.js';
import { notifyAdmin } from '../lib/telegram.js';
import { sendPushNotification } from '../lib/firebase-admin.js';

const adminRouter = new Hono();

function checkAdmin(c: any): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  const provided = c.req.header('Authorization')?.replace('Bearer ', '');
  return provided === secret;
}

function forbidden(c: any) {
  return c.json({ error: { code: 'FORBIDDEN', message: 'Admin access required' } }, 403);
}

// GET /admin/stats
adminRouter.get('/stats', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);

  const [totalUsers] = await db.select({ cnt: count() }).from(users);
  const [frozenUsers] = await db.select({ cnt: count() }).from(users).where(eq(users.frozen, true));

  const orderStats = await db.select({ status: orders.status, cnt: count() })
    .from(orders).groupBy(orders.status);

  const [revenue] = await db.select({ total: sum(orders.price) })
    .from(orders).where(eq(orders.status, 'completed'));

  const [disputes] = await db.select({ cnt: count() })
    .from(orderHistory).where(like(orderHistory.note, 'DISPUTE:%'));

  const [paymentDisputes] = await db.select({ cnt: count() })
    .from(orderHistory).where(like(orderHistory.note, 'PAYMENT_DISPUTE:%'));

  const [recentOrders] = await db.select({ cnt: sql<number>`count(*)::int` })
    .from(orders).where(sql`created_at > now() - interval '7 days'`);

  const [activeSubscribers] = await db.select({ cnt: sql<number>`count(*)::int` })
    .from(accessPlans).where(and(eq(accessPlans.status, 'active'), sql`${accessPlans.expiresAt} > NOW()`));

  const [trialUsers] = await db.select({ cnt: sql<number>`count(*)::int` })
    .from(users).where(sql`created_at > now() - interval '30 days'`);

  const [monthlyRevenue] = await db.select({ total: sum(accessPlans.priceAtPurchase) })
    .from(accessPlans)
    .where(and(eq(accessPlans.status, 'active'), sql`${accessPlans.createdAt} > date_trunc('month', NOW())`));

  const statusMap: Record<string, number> = {};
  orderStats.forEach(s => { statusMap[s.status] = Number(s.cnt); });

  return c.json({ data: {
    users: Number(totalUsers?.cnt ?? 0),
    frozenUsers: Number(frozenUsers?.cnt ?? 0),
    orders: statusMap,
    revenue: Number(revenue?.total ?? 0),
    disputes: Number(disputes?.cnt ?? 0),
    paymentDisputes: Number(paymentDisputes?.cnt ?? 0),
    recentOrders: Number(recentOrders?.cnt ?? 0),
    activeSubscribers: Number(activeSubscribers?.cnt ?? 0),
    trialUsers: Number(trialUsers?.cnt ?? 0),
    subscriptionRevenue: Number(monthlyRevenue?.total ?? 0),
  } });
});

// GET /admin/frozen
adminRouter.get('/frozen', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const frozen = await db.select({
    id: users.id, phone: users.phone, name: users.name,
    freezeReason: users.freezeReason, createdAt: users.createdAt,
  }).from(users).where(eq(users.frozen, true)).orderBy(desc(users.createdAt));
  return c.json({ data: frozen });
});

// POST /admin/freeze/:id
adminRouter.post('/freeze/:id', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const reason = (body as any)?.reason || 'Заморожен администратором';
  await db.update(users).set({ frozen: true, freezeReason: reason } as any).where(eq(users.id, id));
  return c.json({ data: { ok: true } });
});

// POST /admin/unfreeze/:id
adminRouter.post('/unfreeze/:id', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const id = c.req.param('id');
  await db.update(users).set({ frozen: false, freezeReason: null } as any).where(eq(users.id, id));
  return c.json({ data: { ok: true } });
});

// POST /admin/verify/:id — mark contractor as verified and notify them
adminRouter.post('/verify/:id', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const id = c.req.param('id');
  await db.update(users).set({ isVerified: true } as any).where(eq(users.id, id));
  notifyUser(id, '✅ Аккаунт верифицирован', 'Ваш аккаунт проверен! Теперь вы можете принимать заказы.');
  return c.json({ data: { ok: true } });
});

// GET /admin/disputes — customer disputes (DISPUTE: prefix in orderHistory.note)
adminRouter.get('/disputes', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const rows = await db.select({
    id: orderHistory.id,
    orderId: orderHistory.orderId,
    note: orderHistory.note,
    createdAt: orderHistory.createdAt,
    orderStatus: orders.status,
    address: orders.address,
    price: orders.price,
    customerId: orders.customerId,
    contractorId: orders.contractorId,
  }).from(orderHistory)
    .leftJoin(orders, eq(orderHistory.orderId, orders.id))
    .where(like(orderHistory.note, 'DISPUTE:%'))
    .orderBy(desc(orderHistory.createdAt))
    .limit(50);
  return c.json({ data: rows });
});

// GET /admin/disputes/payment — payment disputes (PAYMENT_DISPUTE: prefix)
adminRouter.get('/disputes/payment', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const rows = await db.select({
    id: orderHistory.id,
    orderId: orderHistory.orderId,
    note: orderHistory.note,
    createdAt: orderHistory.createdAt,
    orderStatus: orders.status,
    address: orders.address,
    price: orders.price,
    customerId: orders.customerId,
    contractorId: orders.contractorId,
  }).from(orderHistory)
    .leftJoin(orders, eq(orderHistory.orderId, orders.id))
    .where(like(orderHistory.note, 'PAYMENT_DISPUTE:%'))
    .orderBy(desc(orderHistory.createdAt))
    .limit(50);
  return c.json({ data: rows });
});

// GET /admin/users?q=xxx&offset=0 — list all users or search by phone/name
adminRouter.get('/users', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const q = (c.req.query('q') ?? c.req.query('phone') ?? '').trim();
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);
  const limit = 30;

  const baseSelect = {
    id: users.id, phone: users.phone, name: users.name, role: users.role,
    frozen: users.frozen, freezeReason: users.freezeReason,
    balance: users.balance, xp: users.xp, createdAt: users.createdAt,
    telegramLinked: users.telegramChatId,
    isVerified: users.isVerified,
  };

  const rows = q
    ? await db.select(baseSelect).from(users)
        .where(or(ilike(users.phone, `%${q}%`), ilike(users.name, `%${q}%`)))
        .orderBy(desc(users.createdAt)).limit(limit)
    : await db.select(baseSelect).from(users)
        .orderBy(desc(users.createdAt)).limit(limit + 1).offset(offset);

  const hasMore = !q && rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // Bulk-fetch active access plans for returned users
  const userIds = page.map(r => r.id);
  const now = new Date();
  const TRIAL_MS = 30 * 24 * 60 * 60 * 1000;
  const activePlans = userIds.length > 0
    ? await db.select({ userId: accessPlans.userId }).from(accessPlans)
        .where(and(
          sql`${accessPlans.userId} = ANY(ARRAY[${sql.raw(userIds.map(id => `'${id}'`).join(','))}]::uuid[])`,
          eq(accessPlans.status, 'active'),
          sql`${accessPlans.expiresAt} > NOW()`,
        ))
    : [];
  const activePlanSet = new Set(activePlans.map(p => p.userId));

  return c.json({
    data: page.map(r => {
      const subStatus = (now.getTime() - r.createdAt.getTime()) < TRIAL_MS
        ? 'trial'
        : activePlanSet.has(r.id) ? 'active' : 'expired';
      return { ...r, telegramLinked: !!r.telegramLinked, subscriptionStatus: subStatus };
    }),
    meta: { hasMore, nextOffset: hasMore ? offset + limit : null },
  });
});

// GET /admin/users/:id/orders — orders for a specific user
adminRouter.get('/users/:id/orders', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const id = c.req.param('id');
  const rows = await db.select({
    id: orders.id, address: orders.address, status: orders.status,
    price: orders.price, createdAt: orders.createdAt,
    customerId: orders.customerId, contractorId: orders.contractorId,
  }).from(orders)
    .where(or(eq(orders.customerId, id), eq(orders.contractorId, id)))
    .orderBy(desc(orders.createdAt))
    .limit(50);
  return c.json({ data: rows });
});

// DELETE /admin/users/:id — permanently delete a user account
adminRouter.delete('/users/:id', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const id = c.req.param('id');

  const [user] = await db.select({ id: users.id, phone: users.phone }).from(users).where(eq(users.id, id)).limit(1);
  if (!user) return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);

  try {
    // Nullify contractorId on orders where this user was contractor
    await db.execute(sql`UPDATE orders SET contractor_id = NULL WHERE contractor_id = ${id}`);

    // Delete order-related data for customer orders
    const customerOrders = await db.select({ id: orders.id }).from(orders).where(eq(orders.customerId, id));
    for (const o of customerOrders) {
      await db.delete(messages).where(eq(messages.orderId, o.id));
      await db.delete(orderHistory).where(eq(orderHistory.orderId, o.id));
    }
    await db.delete(orders).where(eq(orders.customerId, id));

    // Delete subscriptions
    await db.delete(subscriptions).where(eq(subscriptions.customerId, id));
    await db.execute(sql`UPDATE subscriptions SET contractor_id = NULL WHERE contractor_id = ${id}`);

    // Delete user-level records
    await db.delete(blockedAddresses).where(eq(blockedAddresses.customerId, id));
    await db.execute(sql`DELETE FROM blocked_addresses WHERE contractor_id = ${id}`);
    await db.delete(userAchievements).where(eq(userAchievements.userId, id));
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, id));
    await db.delete(supportMessages).where(eq(supportMessages.userId, id));
    await db.execute(sql`DELETE FROM otp_codes WHERE phone = (SELECT phone FROM users WHERE id = ${id})`);
    await db.execute(sql`DELETE FROM otp_codes WHERE phone = (SELECT email FROM users WHERE id = ${id})`);
    await db.execute(sql`DELETE FROM referrals WHERE referrer_id = ${id} OR referee_id = ${id}`);
    // Delete all messages sent by this user (FK constraint: messages.sender_id → users.id)
    await db.delete(messages).where(eq(messages.senderId, id));

    await db.delete(users).where(eq(users.id, id));
  } catch (e: any) {
    return c.json({ error: { code: 'DELETE_FAILED', message: e.message } }, 500);
  }

  return c.json({ data: { ok: true } });
});

// POST /admin/disputes/:id/close — mark dispute as resolved
adminRouter.post('/disputes/:id/close', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const resolution = (body as any)?.resolution || 'Закрыт администратором';
  await db.update(orderHistory)
    .set({ note: sql`note || ' [CLOSED: ' || ${resolution} || ']'` } as any)
    .where(eq(orderHistory.id, id));
  return c.json({ data: { ok: true } });
});

// GET /admin/support?status=open|escalated|all — list support messages
adminRouter.get('/support', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const status = c.req.query('status') ?? 'open';
  const rows = await db.select({
    id: supportMessages.id,
    message: supportMessages.message,
    reply: supportMessages.reply,
    repliedAt: supportMessages.repliedAt,
    status: supportMessages.status,
    createdAt: supportMessages.createdAt,
    userId: supportMessages.userId,
    userName: users.name,
    userPhone: users.phone,
    telegramChatId: users.telegramChatId,
    readAt: supportMessages.readAt,
    category: supportMessages.category,
    isBotReply: supportMessages.isBotReply,
    escalated: supportMessages.escalated,
  }).from(supportMessages)
    .leftJoin(users, eq(supportMessages.userId, users.id))
    .where(
      status === 'all' ? sql`true` :
      status === 'escalated' ? eq(supportMessages.escalated, true) :
      eq(supportMessages.status, status)
    )
    .orderBy(desc(supportMessages.createdAt))
    .limit(100);
  return c.json({ data: rows.map(r => ({ ...r, repliedAt: r.repliedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(), readAt: r.readAt?.toISOString() ?? null, category: r.category ?? null })) });
});

// GET /admin/support/count — count open + escalated support messages
adminRouter.get('/support/count', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const [[openRow], [escalatedRow]] = await Promise.all([
    db.select({ cnt: count() }).from(supportMessages).where(eq(supportMessages.status, 'open')),
    db.select({ cnt: count() }).from(supportMessages).where(eq(supportMessages.escalated, true)),
  ]);
  return c.json({ data: { open: Number(openRow?.cnt ?? 0), escalated: Number(escalatedRow?.cnt ?? 0) } });
});

// POST /admin/support/:id/reply — admin replies to a support message
adminRouter.post('/support/:id/reply', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const reply = ((body as any)?.reply ?? '').toString().trim();
  if (!reply) return c.json({ error: { code: 'VALIDATION', message: 'Reply required' } }, 400);

  const [updated] = await db.update(supportMessages)
    .set({ reply, repliedAt: new Date(), status: 'closed' } as any)
    .where(eq(supportMessages.id, id))
    .returning();

  if (!updated) return c.json({ error: { code: 'NOT_FOUND', message: 'Message not found' } }, 404);

  // Notify user about admin reply via push + Telegram
  notifyUser(updated.userId, '💬 Ответ поддержки', reply);

  return c.json({ data: { ok: true } });
});

// POST /admin/run-subscription-cron — manually trigger subscription cron for testing
adminRouter.post('/run-subscription-cron', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const { runSubscriptionCron } = await import('../lib/subscriptionCron.js');
  await runSubscriptionCron();
  return c.json({ data: { ok: true, note: 'Ran. Creates orders only during 06:00 Moscow hour unless that window is active.' } });
});

// GET /admin/access-plans/pending — list pending payment requests
adminRouter.get('/access-plans/pending', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);

  const rows = await db.select({
    plan: accessPlans,
    userName: users.name,
    userPhone: users.phone,
    userCreatedAt: users.createdAt,
  })
    .from(accessPlans)
    .leftJoin(users, eq(accessPlans.userId, users.id))
    .where(eq(accessPlans.status, 'pending'))
    .orderBy(desc(accessPlans.createdAt));

  return c.json({ data: rows.map(r => ({
    id: r.plan.id,
    userId: r.plan.userId,
    userName: r.userName ?? '—',
    userPhone: r.userPhone ?? '—',
    priceAtPurchase: r.plan.priceAtPurchase,
    paymentRef: r.plan.paymentRef,
    createdAt: r.plan.createdAt.toISOString(),
    userRegisteredAt: r.userCreatedAt?.toISOString() ?? null,
  })) });
});

// POST /admin/access-plans/:id/confirm — activate a pending plan (30 days from now)
adminRouter.post('/access-plans/:id/confirm', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);

  const id = c.req.param('id');
  const [plan] = await db.select().from(accessPlans).where(eq(accessPlans.id, id)).limit(1);
  if (!plan) return c.json({ error: { code: 'NOT_FOUND' } }, 404);
  if (plan.status !== 'pending') return c.json({ error: { code: 'NOT_PENDING', message: 'Plan is not in pending state' } }, 409);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  await db.update(accessPlans).set({
    status: 'active',
    startsAt: now,
    expiresAt,
    confirmedAt: now,
  }).where(eq(accessPlans.id, id));

  const expiryLabel = expiresAt.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' });
  notifyUser(plan.userId, '✅ TrashGo', `Абонемент активирован до ${expiryLabel}`);

  return c.json({ data: { id, status: 'active', expiresAt: expiresAt.toISOString() } });
});

// POST /admin/access-plans/:id/reject — reject and remove a pending plan
adminRouter.post('/access-plans/:id/reject', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);

  const id = c.req.param('id');
  const [plan] = await db.select({ id: accessPlans.id, status: accessPlans.status })
    .from(accessPlans).where(eq(accessPlans.id, id)).limit(1);
  if (!plan) return c.json({ error: { code: 'NOT_FOUND' } }, 404);
  if (plan.status !== 'pending') return c.json({ error: { code: 'NOT_PENDING' } }, 409);

  await db.delete(accessPlans).where(eq(accessPlans.id, id));

  return c.json({ data: { id, deleted: true } });
});

// POST /admin/grant-subscription — grant subscription by phone (search + activate in one step)
adminRouter.post('/grant-subscription', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const body = await c.req.json().catch(() => ({}));
  const phone = typeof body.phone === 'string' ? body.phone.trim() : null;
  const months = typeof body.months === 'number' && body.months > 0 ? Math.min(body.months, 12) : 1;
  if (!phone) return c.json({ error: { code: 'VALIDATION', message: 'phone required' } }, 400);

  const [user] = await db.select({ id: users.id, name: users.name, phone: users.phone })
    .from(users).where(eq(users.phone, phone)).limit(1);
  if (!user) return c.json({ error: { code: 'NOT_FOUND', message: 'Пользователь с таким номером не найден' } }, 404);

  const now = new Date();
  const [existing] = await db.select({ id: accessPlans.id, expiresAt: accessPlans.expiresAt })
    .from(accessPlans).where(and(eq(accessPlans.userId, user.id), eq(accessPlans.status, 'active')))
    .orderBy(desc(accessPlans.expiresAt)).limit(1);

  const baseDate = (existing?.expiresAt && existing.expiresAt > now) ? existing.expiresAt : now;
  const newExpiry = new Date(baseDate.getTime() + months * 30 * 24 * 60 * 60 * 1000);

  if (existing) {
    await db.update(accessPlans).set({ expiresAt: newExpiry }).where(eq(accessPlans.id, existing.id));
  } else {
    await db.insert(accessPlans).values({ userId: user.id, status: 'active', priceAtPurchase: 0, paymentRef: 'admin-grant', startsAt: now, expiresAt: newExpiry, confirmedAt: now } as any);
  }

  const expiryLabel = newExpiry.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' });
  notifyUser(user.id, '✅ TrashGo', `Администратор активировал абонемент до ${expiryLabel}`);
  return c.json({ data: { userId: user.id, name: user.name, phone: user.phone, expiresAt: newExpiry.toISOString() } });
});

// POST /admin/users/:id/extend-subscription — grant or extend +30 days access plan
adminRouter.post('/users/:id/extend-subscription', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const id = c.req.param('id');

  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
  if (!user) return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);

  const now = new Date();

  // Find existing active plan to extend from its expiry; otherwise start from now
  const [existing] = await db.select({ id: accessPlans.id, expiresAt: accessPlans.expiresAt, status: accessPlans.status })
    .from(accessPlans)
    .where(and(eq(accessPlans.userId, id), eq(accessPlans.status, 'active')))
    .orderBy(desc(accessPlans.expiresAt))
    .limit(1);

  const baseDate = (existing?.expiresAt && existing.expiresAt > now) ? existing.expiresAt : now;
  const newExpiry = new Date(baseDate.getTime() + 30 * 24 * 60 * 60 * 1000);

  if (existing) {
    await db.update(accessPlans).set({ expiresAt: newExpiry }).where(eq(accessPlans.id, existing.id));
  } else {
    await db.insert(accessPlans).values({
      userId: id,
      status: 'active',
      priceAtPurchase: 0,
      paymentRef: 'admin-grant',
      startsAt: now,
      expiresAt: newExpiry,
      confirmedAt: now,
    } as any);
  }

  const expiryLabel = newExpiry.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric' });
  notifyUser(id, '✅ TrashGo', `Абонемент продлён до ${expiryLabel}`);

  return c.json({ data: { userId: id, expiresAt: newExpiry.toISOString() } });
});

// POST /admin/broadcast-update — push "update available" to all users with FCM tokens
adminRouter.post('/broadcast-update', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);

  const rows = await db.select({ id: users.id, fcmToken: users.fcmToken })
    .from(users)
    .where(isNotNull(users.fcmToken));

  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row.fcmToken) continue;
    const ok = await sendPushNotification(
      row.fcmToken,
      '🔄 Вышла новая версия TrashGo!',
      'Обновите приложение — доступны новые функции',
      { url: '/download' },
    );
    if (ok) sent++; else failed++;
  }

  return c.json({ data: { sent, failed, total: rows.length } });
});

// GET /admin/promo-codes
adminRouter.get('/promo-codes', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const rows = await db.select().from(promoCodes).orderBy(desc(promoCodes.createdAt));
  return c.json({ data: rows.map(p => ({
    id: p.id,
    code: p.code,
    discountAmount: p.discountAmount,
    maxUses: p.maxUses,
    usedCount: p.usedCount,
    expiresAt: p.expiresAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
  })) });
});

// POST /admin/promo-codes
adminRouter.post('/promo-codes', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const body = await c.req.json().catch(() => ({}));
  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase().slice(0, 50) : null;
  const discountAmount = typeof body.discountAmount === 'number' ? body.discountAmount : 0;
  const maxUses = typeof body.maxUses === 'number' ? body.maxUses : 0;
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (!code) return c.json({ error: { code: 'VALIDATION', message: 'code required' } }, 400);
  const [promo] = await db.insert(promoCodes).values({ code, discountAmount, maxUses, ...(expiresAt ? { expiresAt } : {}) }).returning();
  return c.json({ data: promo }, 201);
});

// DELETE /admin/promo-codes/:id
adminRouter.delete('/promo-codes/:id', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const id = c.req.param('id');
  await db.delete(promoCodes).where(eq(promoCodes.id, id));
  return c.json({ data: { ok: true } });
});

export default adminRouter;
