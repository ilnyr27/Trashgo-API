import { Hono } from 'hono';
import { z } from 'zod';
import { eq, desc, sql, asc, and, ne, inArray, like } from 'drizzle-orm';
import { db } from '../db/index.js';
import { orders, orderHistory, users, messages, referrals } from '../db/schema.js';
import { authMiddleware, type JwtPayload } from '../middleware/auth.js';
import { emitToUser } from '../ws.js';
import {
  checkOrderAchievements, checkRatingAchievements, checkAsapAchievements,
  checkVolumeAchievements, checkDistrictAchievements, checkTimeAchievements,
  checkEcoAchievements, checkCustomerOrderAchievements, checkVehicleAchievements,
  checkTenureAchievements, calcLevel,
} from '../lib/achievements.js';

const ordersRouter = new Hono<{ Variables: { user: JwtPayload } }>();

// All routes require auth
ordersRouter.use('*', authMiddleware);

// Validation
const createOrderSchema = z.object({
  address: z.string().min(1).max(500),
  district: z.string().min(1).max(100),
  volume: z.number().int().min(1).max(50),
  price: z.number().int().min(10).max(10000),
  description: z.string().max(1000).default(''),
  scheduledAt: z.string().datetime().optional(),
  asap: z.boolean().default(false),
  photoUrls: z.array(z.string()).max(5).default([]),
});

const updateStatusSchema = z.object({
  status: z.enum(['accepted', 'in_progress', 'completed', 'cancelled', 'pending_confirmation']),
});

const completeOrderSchema = z.object({
  completionPhotoUrls: z.array(z.string()).max(5).default([]),
});

// GET /orders — list my orders
// ?mode=contractor → orders I accepted (contractorId = me)
// default → orders I created (customerId = me)
ordersRouter.get('/', async (c) => {
  const user = c.get('user');
  const mode = c.req.query('mode');

  const field = mode === 'contractor' ? orders.contractorId : orders.customerId;

  const result = await db.select()
    .from(orders)
    .where(eq(field, user.userId))
    .orderBy(desc(orders.createdAt))
    .limit(50);

  // Fetch counterpart names for history display (task 16)
  const counterpartIds = [...new Set(
    result.map(o => mode === 'contractor' ? o.customerId : o.contractorId).filter(Boolean) as string[]
  )];
  const counterparts: Record<string, string> = {};
  if (counterpartIds.length > 0) {
    const names = await db.select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, counterpartIds));
    names.forEach(u => { counterparts[u.id] = u.name; });
  }

  return c.json({
    data: result.map(o => ({
      ...formatOrder(o),
      ...(mode === 'contractor'
        ? { customerName: counterparts[o.customerId] ?? '' }
        : { contractorName: o.contractorId ? (counterparts[o.contractorId] ?? '') : '' }
      ),
    })),
    meta: { total: result.length },
  });
});

// GET /orders/available — all open orders except ones created by the current user
ordersRouter.get('/available', async (c) => {
  const user = c.get('user');
  const district = c.req.query('district');

  const result = await db.select()
    .from(orders)
    .where(and(eq(orders.status, 'new'), ne(orders.customerId, user.userId)))
    .orderBy(desc(orders.createdAt))
    .limit(50);

  const filtered = district
    ? result.filter((o) => o.district === district)
    : result;

  return c.json({
    data: filtered.map(formatOrder),
    meta: { total: filtered.length },
  });
});

// GET /orders/:id
ordersRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const result = await db
    .select({ order: orders, customerName: users.name, customerPhone: users.phone })
    .from(orders)
    .leftJoin(users, eq(orders.customerId, users.id))
    .where(eq(orders.id, id))
    .limit(1);

  if (result.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  }

  const row = result[0];
  let contractorPhone = '';
  let contractorName = '';
  if (row.order.contractorId) {
    const contractor = await db.select({ name: users.name, phone: users.phone })
      .from(users).where(eq(users.id, row.order.contractorId)).limit(1);
    contractorPhone = contractor[0]?.phone ?? '';
    contractorName = contractor[0]?.name ?? '';
  }

  return c.json({ data: {
    ...formatOrder(row.order),
    customerName: row.customerName ?? '',
    customerPhone: row.customerPhone ?? '',
    contractorPhone,
    contractorName,
  } });
});

// GET /orders/:id/messages
ordersRouter.get('/:id/messages', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const order = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order.length) return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  const o = order[0];
  if (o.customerId !== user.userId && o.contractorId !== user.userId) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Not your order' } }, 403);
  }

  const msgs = await db.select().from(messages)
    .where(eq(messages.orderId, id))
    .orderBy(asc(messages.createdAt))
    .limit(200);

  return c.json({ data: msgs.map(m => ({
    id: m.id,
    senderId: m.senderId,
    senderName: m.senderName,
    text: m.text,
    createdAt: m.createdAt.toISOString(),
  })) });
});

// POST /orders/:id/messages
ordersRouter.post('/:id/messages', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const text = (body?.text ?? '').toString().trim().slice(0, 1000);
  if (!text) return c.json({ error: { code: 'VALIDATION', message: 'Text required' } }, 400);

  const order = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order.length) return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  const o = order[0];
  if (o.customerId !== user.userId && o.contractorId !== user.userId) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Not your order' } }, 403);
  }

  const sender = await db.select({ name: users.name }).from(users).where(eq(users.id, user.userId)).limit(1);
  const senderName = sender[0]?.name ?? '';

  const msg = await db.insert(messages).values({ orderId: id, senderId: user.userId, senderName, text }).returning();

  // Notify the other party via WebSocket
  const recipientId = o.customerId === user.userId ? o.contractorId : o.customerId;
  if (recipientId) {
    emitToUser(recipientId, {
      type: 'chat',
      orderId: id,
      title: `Новое сообщение от ${senderName}`,
      message: text.length > 60 ? text.slice(0, 60) + '…' : text,
    });
  }

  return c.json({ data: {
    id: msg[0].id, senderId: msg[0].senderId, senderName: msg[0].senderName,
    text: msg[0].text, createdAt: msg[0].createdAt.toISOString(),
  } }, 201);
});

// PATCH /orders/:id — update order content (customer only, while status=waiting)
ordersRouter.patch('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();

  const existing = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (existing.length === 0) return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  const order = existing[0];
  if (order.customerId !== user.userId) return c.json({ error: { code: 'FORBIDDEN', message: 'Not your order' } }, 403);
  if (order.status !== 'new') return c.json({ error: { code: 'CONFLICT', message: 'Cannot edit order that is already taken' } }, 409);

  const updateSchema = z.object({
    address: z.string().min(1).max(500).optional(),
    district: z.string().min(1).max(100).optional(),
    volume: z.number().int().min(1).max(50).optional(),
    price: z.number().int().min(10).max(10000).optional(),
    description: z.string().max(1000).optional(),
    scheduledAt: z.string().datetime().optional().nullable(),
    asap: z.boolean().optional(),
    photoUrls: z.array(z.string()).max(5).optional(),
  });
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION', message: 'Invalid input' } }, 400);

  const d = parsed.data;
  const updated = await db.update(orders).set({
    ...(d.address !== undefined && { address: d.address }),
    ...(d.district !== undefined && { district: d.district }),
    ...(d.volume !== undefined && { volume: d.volume }),
    ...(d.price !== undefined && { price: d.price }),
    ...(d.description !== undefined && { description: d.description }),
    ...(d.photoUrls !== undefined && { photoUrls: JSON.stringify(d.photoUrls) }),
    ...(d.asap !== undefined && { asap: d.asap }),
    ...((d.asap === true) && { scheduledAt: null }),
    ...((d.asap === false && d.scheduledAt) && { scheduledAt: new Date(d.scheduledAt) }),
    updatedAt: new Date(),
  }).where(eq(orders.id, id)).returning();

  return c.json({ data: formatOrder(updated[0]) });
});

// POST /orders — create an order (any authenticated user)
ordersRouter.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = createOrderSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION', message: 'Invalid input', details: parsed.error.flatten().fieldErrors } }, 400);
  }

  const newOrder = await db.insert(orders).values({
    customerId: user.userId,
    address: parsed.data.address,
    district: parsed.data.district,
    volume: parsed.data.volume,
    price: parsed.data.price,
    description: parsed.data.description,
    photoUrls: JSON.stringify(parsed.data.photoUrls),
    asap: parsed.data.asap,
    scheduledAt: parsed.data.asap ? null : new Date(parsed.data.scheduledAt!),
  }).returning();

  await db.insert(orderHistory).values({
    orderId: newOrder[0].id,
    status: 'new',
    note: 'Order created',
  });

  checkCustomerOrderAchievements(user.userId).catch(() => {});

  return c.json({ data: formatOrder(newOrder[0]) }, 201);
});

// PATCH /orders/:id/status — update order status (any authenticated user)
ordersRouter.patch('/:id/status', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = updateStatusSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION', message: 'Invalid status' } }, 400);
  }

  const { status } = parsed.data;

  const current = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (current.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  }

  const order = current[0];

  // Validate state machine
  const validTransitions: Record<string, string[]> = {
    new: ['accepted', 'cancelled'],
    accepted: ['in_progress', 'cancelled'],
    in_progress: ['pending_confirmation', 'cancelled'],
    pending_confirmation: ['completed', 'cancelled'],
  };

  const allowed = validTransitions[order.status] || [];
  if (!allowed.includes(status)) {
    return c.json({
      error: { code: 'INVALID_TRANSITION', message: `Cannot transition from ${order.status} to ${status}` },
    }, 400);
  }

  const updates: Record<string, unknown> = {
    status,
    updatedAt: new Date(),
  };
  if (status === 'accepted') {
    updates.contractorId = user.userId;
  }

  const updated = await db.update(orders)
    .set(updates)
    .where(eq(orders.id, id))
    .returning();

  await db.insert(orderHistory).values({
    orderId: id,
    status,
    note: `Status changed by user ${user.userId}`,
  });

  // Real-time notifications via WebSocket
  const updatedOrder = updated[0];
  const statusLabels: Record<string, string> = {
    accepted: 'Исполнитель принял заказ',
    in_progress: 'Исполнитель выполняет заказ',
    pending_confirmation: 'Ожидает вашего подтверждения',
    completed: 'Заказ выполнен',
    cancelled: 'Заказ отменён',
  };
  const label = statusLabels[status] || status;
  const event = { type: 'order_status', orderId: id, status, title: label, message: `Заказ #${id.slice(0, 8)}` };
  if (updatedOrder.customerId) emitToUser(updatedOrder.customerId, event);
  if (updatedOrder.contractorId && updatedOrder.contractorId !== updatedOrder.customerId) {
    emitToUser(updatedOrder.contractorId, event);
  }

  return c.json({ data: formatOrder(updated[0]) });
});

// POST /orders/:id/complete — contractor uploads completion photo, moves to pending_confirmation
ordersRouter.post('/:id/complete', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = completeOrderSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION', message: 'Invalid input' } }, 400);
  }

  const current = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (current.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  }

  const order = current[0];
  if (order.contractorId !== user.userId) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Not your order' } }, 403);
  }
  if (order.status !== 'in_progress') {
    return c.json({ error: { code: 'INVALID_TRANSITION', message: 'Order must be in_progress' } }, 400);
  }

  const updated = await db.update(orders)
    .set({
      status: 'pending_confirmation',
      completionPhotoUrls: JSON.stringify(parsed.data.completionPhotoUrls),
      updatedAt: new Date(),
    })
    .where(eq(orders.id, id))
    .returning();

  await db.insert(orderHistory).values({
    orderId: id,
    status: 'pending_confirmation',
    note: `Contractor ${user.userId} submitted completion photos`,
  });

  return c.json({ data: formatOrder(updated[0]) });
});

// POST /orders/:id/confirm — customer confirms completion, credits contractor balance
ordersRouter.post('/:id/confirm', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const current = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (current.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  }

  const order = current[0];
  if (order.customerId !== user.userId) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Not your order' } }, 403);
  }
  if (order.status !== 'pending_confirmation') {
    return c.json({ error: { code: 'INVALID_TRANSITION', message: 'Order must be pending_confirmation' } }, 400);
  }

  let confirmed;
  try {
    confirmed = await db.transaction(async (tx) => {
      const updated = await tx.update(orders)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(and(eq(orders.id, id), eq(orders.status, 'pending_confirmation')))
        .returning();

      if (updated.length === 0) {
        throw Object.assign(new Error('RACE'), { code: 'ALREADY_CONFIRMED' });
      }

      if (order.contractorId) {
        const contractorRow = await tx.select({ xp: users.xp }).from(users)
          .where(eq(users.id, order.contractorId)).limit(1);
        const newXp = (contractorRow[0]?.xp ?? 0) + 10;
        await tx.update(users)
          .set({ balance: sql`balance + ${order.price}`, xp: newXp, level: calcLevel(newXp) })
          .where(eq(users.id, order.contractorId));
      }

      const customerRow = await tx.select({ xp: users.xp }).from(users)
        .where(eq(users.id, order.customerId)).limit(1);
      const customerNewXp = (customerRow[0]?.xp ?? 0) + 10;
      await tx.update(users)
        .set({ xp: customerNewXp, level: calcLevel(customerNewXp) })
        .where(eq(users.id, order.customerId));

      await tx.insert(orderHistory).values({
        orderId: id,
        status: 'completed',
        note: `Confirmed by customer ${user.userId}`,
      });

      return updated[0];
    });
  } catch (err: any) {
    if (err?.code === 'ALREADY_CONFIRMED') {
      return c.json({ error: { code: 'CONFLICT', message: 'Order already confirmed' } }, 409);
    }
    throw err;
  }

  // Check achievements for both parties (fire and forget — don't block response)
  checkEcoAchievements(order.customerId).catch(() => {});
  if (order.contractorId) {
    checkOrderAchievements(order.contractorId, 'contractor').catch(() => {});
    checkVolumeAchievements(order.contractorId).catch(() => {});
    checkDistrictAchievements(order.contractorId).catch(() => {});
    checkTimeAchievements(order.contractorId).catch(() => {});
    checkVehicleAchievements(order.contractorId).catch(() => {});
    checkTenureAchievements(order.contractorId).catch(() => {});
    if (order.asap) checkAsapAchievements(order.contractorId).catch(() => {});

    // Referral bonus: if contractor was referred, check 150₽ milestone + 5% monthly
    try {
      const contractorRow = await db.select({ referredBy: users.referredBy })
        .from(users).where(eq(users.id, order.contractorId)).limit(1);
      const referrerId = contractorRow[0]?.referredBy;

      if (referrerId) {
        const refRow = await db.select().from(referrals)
          .where(and(eq(referrals.referrerId, referrerId), eq(referrals.refereeId, order.contractorId)))
          .limit(1);
        const ref = refRow[0];

        if (ref) {
          // Count completed orders by referee
          const [countRow] = await db.select({ cnt: sql<number>`count(*)` })
            .from(orders)
            .where(and(eq(orders.contractorId, order.contractorId), eq(orders.status, 'completed')));
          const refeeOrderCount = Number(countRow?.cnt ?? 0);

          // Award 150₽ bonus after referee's 5th completed order
          if (!ref.bonus150Paid && refeeOrderCount >= 5) {
            await db.update(users).set({ balance: sql`balance + 150` }).where(eq(users.id, referrerId));
            await db.update(referrals).set({ bonus150Paid: true }).where(eq(referrals.id, ref.id));
            emitToUser(referrerId, { type: 'order_status', orderId: id, title: '💰 Бонус за напарника!', message: 'Ваш напарник выполнил 5 заказов — вам начислено +150₽' });
          }

          // 5% bonus during referee's first 30 days, cap 500₽/month
          if (ref.bonusExpiresAt && new Date() < ref.bonusExpiresAt) {
            const cap = 500;
            const bonus5pct = Math.floor(order.price * 0.05);
            const alreadyUsed = ref.bonusMonthlyUsed ?? 0;
            const canAward = Math.min(bonus5pct, cap - alreadyUsed);
            if (canAward > 0) {
              await db.update(users).set({ balance: sql`balance + ${canAward}` }).where(eq(users.id, referrerId));
              await db.update(referrals).set({ bonusMonthlyUsed: alreadyUsed + canAward }).where(eq(referrals.id, ref.id));
              emitToUser(referrerId, { type: 'order_status', orderId: id, title: `💰 +${canAward}₽ бонус`, message: `5% от заказа напарника (${order.price}₽)` });
            }
          }
        }
      }
    } catch { /* referral bonus failure doesn't block main flow */ }
  }

  return c.json({ data: formatOrder(confirmed) });
});

// POST /orders/:id/rate — leave a rating for the other party
ordersRouter.post('/:id/rate', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const rating = Number(body?.rating);
  if (!rating || rating < 1 || rating > 5) {
    return c.json({ error: { code: 'VALIDATION', message: 'Rating must be 1-5' } }, 400);
  }

  const current = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (current.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  }
  const order = current[0];
  if (order.status !== 'completed') {
    return c.json({ error: { code: 'INVALID', message: 'Order must be completed' } }, 400);
  }

  if (order.customerId === user.userId) {
    // Customer rates contractor
    if (order.ratingByCustomer) {
      return c.json({ error: { code: 'ALREADY_RATED', message: 'Already rated' } }, 400);
    }
    await db.update(orders).set({ ratingByCustomer: rating }).where(eq(orders.id, id));
    if (order.contractorId) {
      const contractor = await db.select({ xp: users.xp }).from(users).where(eq(users.id, order.contractorId)).limit(1);
      const newXp = (contractor[0]?.xp ?? 0) + rating;
      const newLevel = calcLevel(newXp);
      await db.update(users).set({ xp: newXp, level: newLevel }).where(eq(users.id, order.contractorId));
      // Check rating achievements for the contractor who received the rating
      checkRatingAchievements(order.contractorId, rating).catch(() => {});
    }
  } else if (order.contractorId === user.userId) {
    // Contractor rates customer
    if (order.ratingByContractor) {
      return c.json({ error: { code: 'ALREADY_RATED', message: 'Already rated' } }, 400);
    }
    await db.update(orders).set({ ratingByContractor: rating }).where(eq(orders.id, id));
  } else {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Not your order' } }, 403);
  }

  return c.json({ data: { ok: true } });
});

// POST /orders/:id/dispute — customer reports work not done correctly (task 29)
ordersRouter.post('/:id/dispute', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const reason = String(body?.reason || '').slice(0, 500);

  const current = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (current.length === 0) return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  const order = current[0];
  if (order.customerId !== user.userId) return c.json({ error: { code: 'FORBIDDEN', message: 'Not your order' } }, 403);
  if (order.status !== 'pending_confirmation') return c.json({ error: { code: 'INVALID', message: 'Order must be pending_confirmation' } }, 400);

  const existingDispute = await db.select({ id: orderHistory.id })
    .from(orderHistory)
    .where(and(eq(orderHistory.orderId, id), like(orderHistory.note, 'DISPUTE:%')))
    .limit(1);
  if (existingDispute.length > 0) {
    return c.json({ error: { code: 'CONFLICT', message: 'Dispute already filed for this order' } }, 409);
  }

  await db.insert(orderHistory).values({ orderId: id, status: 'pending_confirmation', note: `DISPUTE: ${reason || 'No reason'}` });

  emitToUser(user.userId, { type: 'order_status', orderId: id, title: 'Жалоба принята', message: 'Поддержка рассмотрит обращение в течение 7 дней' });
  if (order.contractorId) {
    emitToUser(order.contractorId, { type: 'order_status', orderId: id, title: 'Открыт спор по заказу', message: 'Заказчик сообщил о проблеме — ожидайте решения поддержки' });
  }

  return c.json({ data: { ok: true } });
});

// Helper
function formatOrder(o: typeof orders.$inferSelect) {
  let photoUrls: string[] = [];
  let completionPhotoUrls: string[] = [];
  try { photoUrls = JSON.parse(o.photoUrls || '[]'); } catch {}
  try { completionPhotoUrls = JSON.parse(o.completionPhotoUrls || '[]'); } catch {}
  return {
    id: o.id,
    customerId: o.customerId,
    contractorId: o.contractorId,
    address: o.address,
    district: o.district,
    status: o.status,
    volume: o.volume,
    price: o.price,
    description: o.description,
    photoUrls,
    completionPhotoUrls,
    asap: o.asap ?? false,
    scheduledAt: o.scheduledAt ? o.scheduledAt.toISOString() : null,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
    ratingByCustomer: o.ratingByCustomer ?? null,
    ratingByContractor: o.ratingByContractor ?? null,
  };
}

export default ordersRouter;
