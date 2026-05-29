import { Hono } from 'hono';
import { z } from 'zod';
import { eq, desc, sql, asc, and, ne, inArray, like, lt, isNotNull, avg, count } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/index.js';
import { orders, orderHistory, users, messages, referrals, blockedAddresses } from '../db/schema.js';
import { authMiddleware, type JwtPayload } from '../middleware/auth.js';
import { rateLimit } from '../lib/rateLimit.js';
import { emitToUser } from '../ws.js';
import {
  checkOrderAchievements, checkRatingAchievements, checkAsapAchievements,
  checkVolumeAchievements, checkDistrictAchievements, checkTimeAchievements,
  checkEcoAchievements, checkCustomerOrderAchievements, checkVehicleAchievements,
  checkTenureAchievements, calcLevel,
} from '../lib/achievements.js';
import {
  sendOrderAcceptedEmail, sendOrderCompletedEmail, sendOrderConfirmedEmail, sendOrderCancelledEmail,
} from '../lib/email.js';
import { notifyUser } from '../lib/notify.js';
import { censor } from '../lib/censor.js';
import { hasActiveSubscription } from '../lib/subscriptionStatus.js';

const ordersRouter = new Hono<{ Variables: { user: JwtPayload } }>();

// All routes require auth
ordersRouter.use('*', authMiddleware);

// Strip HTML tags to prevent XSS stored in DB (F3)
function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, '').trim();
}

// Validate photo: https:// URL or base64 data image ≤5MB decoded (F2)
const photoUrlSchema = z.string().refine((s) => {
  if (s.startsWith('https://')) return true;
  const m = s.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/);
  if (!m) return false;
  // base64 length → decoded bytes ≈ len * 3/4
  return m[2].length * 0.75 <= 5 * 1024 * 1024;
}, { message: 'Photo must be an https:// URL or base64 image ≤5MB (jpeg/png/webp/gif)' });

// Validation
const createOrderSchema = z.object({
  address: z.string().min(1).max(500),
  district: z.string().min(1).max(100),
  volume: z.number().int().min(1).max(50),
  price: z.number().int().min(10).max(10000),
  description: z.string().max(1000).default(''),
  scheduledAt: z.string().datetime().optional(),
  asap: z.boolean().default(false),
  photoUrls: z.array(photoUrlSchema).max(5).default([]),
  wasteType: z.enum(['household', 'construction', 'bulky']).default('household'),
}).superRefine((data, ctx) => {
  if (!data.asap && !data.scheduledAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'scheduledAt required when asap is false', path: ['scheduledAt'] });
  }
});

const updateStatusSchema = z.object({
  status: z.enum(['accepted', 'en_route', 'in_progress', 'completed', 'cancelled', 'pending_confirmation', 'pending_payment']),
});

const completeOrderSchema = z.object({
  completionPhotoUrls: z.array(photoUrlSchema).max(5).default([]),
});

// GET /orders — list my orders (offset pagination)
// ?mode=contractor → orders I accepted (contractorId = me)
// ?offset=0&limit=20
ordersRouter.get('/', async (c) => {
  const user = c.get('user');
  const mode = c.req.query('mode');
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10) || 20));
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);

  const cu = alias(users, 'cu'); // counterpart user alias

  // Single LEFT JOIN fetches order + counterpart name in one query
  const result = mode === 'contractor'
    ? await db
        .select({ order: orders, counterpartName: cu.name })
        .from(orders)
        .leftJoin(cu, eq(cu.id, orders.customerId))
        .where(eq(orders.contractorId, user.userId))
        .orderBy(desc(orders.createdAt))
        .limit(limit + 1)
        .offset(offset)
    : await db
        .select({ order: orders, counterpartName: cu.name })
        .from(orders)
        .leftJoin(cu, eq(cu.id, orders.contractorId))
        .where(eq(orders.customerId, user.userId))
        .orderBy(desc(orders.createdAt))
        .limit(limit + 1)
        .offset(offset);

  const hasMore = result.length > limit;
  const page = hasMore ? result.slice(0, limit) : result;

  return c.json({
    data: page.map(({ order: o, counterpartName }) => ({
      ...formatOrder(o),
      ...(mode === 'contractor'
        ? { customerName: counterpartName ?? '' }
        : { contractorName: counterpartName ?? '' }
      ),
    })),
    meta: { hasMore, nextOffset: hasMore ? offset + limit : null },
  });
});

// GET /orders/available — open orders (cursor pagination by createdAt)
// ?district=X&cursor=<ISO timestamp>&limit=20
ordersRouter.get('/available', async (c) => {
  const user = c.get('user');

  if (!await hasActiveSubscription(user.userId)) {
    return c.json({ error: { code: 'SUBSCRIPTION_REQUIRED', message: 'Необходим активный абонемент для просмотра заказов' } }, 403);
  }

  const district = c.req.query('district') || null;
  const cursor = c.req.query('cursor') || null;
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') ?? '20', 10) || 20));

  const conditions: ReturnType<typeof eq>[] = [
    eq(orders.status, 'new') as any,
    ne(orders.customerId, user.userId) as any,
  ];
  if (district) conditions.push(eq(orders.district, district) as any);
  if (cursor) {
    const cursorDate = new Date(cursor);
    if (!isNaN(cursorDate.getTime())) conditions.push(lt(orders.createdAt, cursorDate) as any);
  }

  // Fetch limit+1 to detect hasMore, join customer cancelCount for reliability warning
  const result = await db.select({ order: orders, customerCancelCount: users.cancelCount })
    .from(orders)
    .leftJoin(users, eq(orders.customerId, users.id))
    .where(and(...conditions))
    .orderBy(desc(orders.createdAt))
    .limit(limit + 1);

  const hasMore = result.length > limit;
  const page = hasMore ? result.slice(0, limit) : result;
  const nextCursor = hasMore ? page[page.length - 1].order.createdAt.toISOString() : null;

  return c.json({
    data: page.map(r => ({ ...formatOrder(r.order), customerCancelCount: r.customerCancelCount ?? 0 })),
    meta: { hasMore, nextCursor },
  });
});

// GET /orders/:id
ordersRouter.get('/:id', async (c) => {
  const id = c.req.param('id');

  // Round 1: main order + history in parallel
  const [result, historyRows] = await Promise.all([
    db.select({ order: orders, customerName: users.name, customerPhone: users.phone })
      .from(orders)
      .leftJoin(users, eq(orders.customerId, users.id))
      .where(eq(orders.id, id))
      .limit(1),
    db.select({ status: orderHistory.status, createdAt: orderHistory.createdAt, note: orderHistory.note })
      .from(orderHistory)
      .where(eq(orderHistory.orderId, id))
      .orderBy(asc(orderHistory.createdAt)),
  ]);

  if (result.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  }

  const row = result[0];
  const history = historyRows.map(h => ({ status: h.status, createdAt: h.createdAt.toISOString(), note: h.note }));
  const acceptedAt = historyRows.find(h => h.status === 'accepted')?.createdAt.toISOString() ?? null;

  // Round 2: contractor data + customer data in parallel
  const [contractorResult, customerResult] = await Promise.all([
    row.order.contractorId ? Promise.all([
      db.select({ name: users.name, phone: users.phone, sbpBank: users.sbpBank, isVerified: users.isVerified }).from(users).where(eq(users.id, row.order.contractorId!)).limit(1),
      db.select({ avg: avg(orders.ratingByCustomer), cnt: count(orders.ratingByCustomer) })
        .from(orders).where(and(eq(orders.contractorId, row.order.contractorId!), isNotNull(orders.ratingByCustomer))),
      db.select({ cnt: sql<number>`count(*)::int` })
        .from(orders).where(and(eq(orders.contractorId, row.order.contractorId!), eq(orders.status, 'completed'))),
    ]) : Promise.resolve([[], [{ avg: null, cnt: 0 }], [{ cnt: 0 }]] as const),
    Promise.all([
      db.select({ avg: avg(orders.ratingByContractor), cnt: count(orders.ratingByContractor) })
        .from(orders).where(and(eq(orders.customerId, row.order.customerId), isNotNull(orders.ratingByContractor))),
      db.select({ cnt: sql<number>`count(*)::int` })
        .from(orders).where(and(eq(orders.customerId, row.order.customerId), eq(orders.status, 'completed'))),
    ]),
  ]);

  const [[contractor], [cRating], [ccRow]] = contractorResult as [any[], any[], any[]];
  const [[cuRating], [custRow]] = customerResult;

  const contractorPhone = contractor?.phone ?? '';
  const contractorName = contractor?.name ?? '';
  const contractorSbpBank = contractor?.sbpBank ?? null;
  const contractorIsVerified = contractor?.isVerified ?? false;
  const contractorAvgRating = cRating?.avg ? parseFloat(cRating.avg) : null;
  const contractorRatingCount = Number(cRating?.cnt ?? 0);
  const contractorCompletedOrders = Number(ccRow?.cnt ?? 0);
  const customerAvgRating = cuRating?.avg ? parseFloat(cuRating.avg) : null;
  const customerRatingCount = Number(cuRating?.cnt ?? 0);
  const customerCompletedOrders = Number(custRow?.cnt ?? 0);

  return c.json({ data: {
    ...formatOrder(row.order),
    customerName: row.customerName ?? '',
    customerPhone: row.customerPhone ?? '',
    customerAvgRating,
    customerRatingCount,
    customerCompletedOrders,
    contractorPhone,
    contractorName,
    contractorSbpBank,
    contractorIsVerified,
    contractorAvgRating,
    contractorRatingCount,
    contractorCompletedOrders,
    acceptedAt,
    history,
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
  const text = censor((body?.text ?? '').toString().trim().slice(0, 1000));
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

  // Notify the other party via WebSocket + push + Telegram
  const recipientId = o.customerId === user.userId ? o.contractorId : o.customerId;
  if (recipientId) {
    const preview = text.length > 60 ? text.slice(0, 60) + '…' : text;
    emitToUser(recipientId, { type: 'chat', orderId: id, title: `Новое сообщение от ${senderName}`, message: preview });
    notifyUser(recipientId, `💬 ${senderName}`, preview, id);
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
    photoUrls: z.array(photoUrlSchema).max(5).optional(),
    wasteType: z.enum(['household', 'construction', 'bulky']).optional(),
  });
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: { code: 'VALIDATION', message: 'Invalid input' } }, 400);

  const d = parsed.data;
  const updated = await db.update(orders).set({
    ...(d.address !== undefined && { address: d.address }),
    ...(d.district !== undefined && { district: d.district }),
    ...(d.volume !== undefined && { volume: d.volume }),
    ...(d.price !== undefined && { price: d.price }),
    ...(d.description !== undefined && { description: censor(stripHtml(d.description)) }),
    ...(d.photoUrls !== undefined && { photoUrls: JSON.stringify(d.photoUrls) }),
    ...(d.asap !== undefined && { asap: d.asap }),
    ...((d.asap === true) && { scheduledAt: null }),
    ...((d.asap === false && d.scheduledAt) && { scheduledAt: new Date(d.scheduledAt) }),
    ...(d.wasteType !== undefined && { wasteType: d.wasteType }),
    updatedAt: new Date(),
  }).where(eq(orders.id, id)).returning();

  return c.json({ data: formatOrder(updated[0]) });
});

// POST /orders — create an order (any authenticated user)
ordersRouter.post('/', async (c) => {
  const user = c.get('user');

  if (!await hasActiveSubscription(user.userId)) {
    return c.json({ error: { code: 'SUBSCRIPTION_REQUIRED', message: 'Необходим активный абонемент для создания заказов' } }, 403);
  }

  // Rate limit: max 10 orders per hour per user
  const retryAfter = await rateLimit(`order:${user.userId}`, 10, 60 * 60 * 1000);
  if (retryAfter > 0) {
    c.header('Retry-After', String(retryAfter));
    return c.json({ error: { code: 'RATE_LIMITED', message: 'Слишком много заказов. Подождите немного.' } }, 429);
  }

  const body = await c.req.json();
  const parsed = createOrderSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION', message: 'Invalid input', details: parsed.error.flatten().fieldErrors } }, 400);
  }

  // Check if address is blocked for this customer
  const normalizedAddress = parsed.data.address.trim().toLowerCase();
  const blocked = await db.select({ id: blockedAddresses.id })
    .from(blockedAddresses)
    .where(and(
      eq(blockedAddresses.customerId, user.userId),
      sql`lower(${blockedAddresses.address}) = ${normalizedAddress}`,
    ))
    .limit(1);
  if (blocked.length > 0) {
    return c.json({ error: { code: 'ADDRESS_BLOCKED', message: 'Этот адрес заблокирован из-за неоплаты. Обратитесь в поддержку.' } }, 403);
  }

  const newOrder = await db.insert(orders).values({
    customerId: user.userId,
    address: parsed.data.address,
    district: parsed.data.district,
    volume: parsed.data.volume,
    price: parsed.data.price,
    description: censor(stripHtml(parsed.data.description)),
    photoUrls: JSON.stringify(parsed.data.photoUrls),
    asap: parsed.data.asap,
    scheduledAt: parsed.data.asap ? null : new Date(parsed.data.scheduledAt!),
    wasteType: parsed.data.wasteType,
  }).returning();

  await db.insert(orderHistory).values({
    orderId: newOrder[0].id,
    status: 'new',
    note: 'Order created',
  });

  checkCustomerOrderAchievements(user.userId).catch(() => {});

  // Notify available contractors in the same district
  const newOrderId = newOrder[0].id;
  const notifTitle = `🗑 Новый заказ в районе ${parsed.data.district}`;
  const notifBody = `${parsed.data.volume} м³ · ${parsed.data.price}₽ · ${parsed.data.address}`;
  db.select({ id: users.id })
    .from(users)
    .where(and(
      eq(users.role, 'contractor'),
      eq(users.district, parsed.data.district),
      eq(users.frozen, false),
      eq(users.isAvailable, true),
      ne(users.id, user.userId),
    ))
    .limit(50)
    .then((contractors) => {
      for (const ct of contractors) notifyUser(ct.id, notifTitle, notifBody, newOrderId);
    }).catch(() => {});

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
    accepted: ['en_route', 'in_progress', 'cancelled'],
    en_route: ['in_progress', 'cancelled'],
    in_progress: ['pending_confirmation', 'cancelled'],
    pending_confirmation: ['pending_payment', 'cancelled'],
    pending_payment: ['completed', 'cancelled'],
  };

  const allowed = validTransitions[order.status] || [];
  if (!allowed.includes(status)) {
    return c.json({
      error: { code: 'INVALID_TRANSITION', message: `Cannot transition from ${order.status} to ${status}` },
    }, 400);
  }

  // Authorization: who can make each transition
  if (status === 'accepted') {
    if (user.userId === order.customerId) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Cannot accept your own order' } }, 403);
    }
  } else if (status === 'en_route') {
    if (user.userId !== order.contractorId) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Only the assigned contractor can set en_route' } }, 403);
    }
  } else if (status === 'in_progress') {
    if (user.userId !== order.contractorId) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Only the assigned contractor can start the order' } }, 403);
    }
  } else if (status === 'cancelled') {
    if (user.userId !== order.customerId && user.userId !== order.contractorId) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Not your order' } }, 403);
    }
  } else if (status === 'pending_confirmation' || status === 'pending_payment' || status === 'completed') {
    if (user.userId !== order.customerId && user.userId !== order.contractorId) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Not your order' } }, 403);
    }
  }

  // Customer cannot cancel once contractor is en_route or has picked up (in_progress)
  if (status === 'cancelled' && (order.status === 'in_progress' || order.status === 'en_route') && order.customerId === user.userId) {
    return c.json({ error: { code: 'ALREADY_PICKED_UP', message: 'Нельзя отменить — исполнитель уже выехал' } }, 400);
  }

  // Customer can only cancel an accepted order within 10 minutes of acceptance
  if (status === 'cancelled' && order.status === 'accepted' && order.customerId === user.userId) {
    const [hist] = await db.select({ createdAt: orderHistory.createdAt })
      .from(orderHistory)
      .where(and(eq(orderHistory.orderId, id), eq(orderHistory.status, 'accepted')))
      .limit(1);
    if (hist) {
      const minutesSince = (Date.now() - hist.createdAt.getTime()) / 60000;
      if (minutesSince > 10) {
        return c.json({ error: { code: 'CANCEL_WINDOW_EXPIRED', message: 'Отменить исполнителя можно только в течение 10 минут после принятия заказа' } }, 400);
      }
    }
  }

  // Contractor cancelling an accepted order → revert to 'new' so another contractor can take it
  const effectiveStatus = (status === 'cancelled' && order.status === 'accepted' && user.userId === order.contractorId)
    ? 'new'
    : status;

  const updates: Record<string, unknown> = {
    status: effectiveStatus,
    updatedAt: new Date(),
  };
  if (status === 'accepted') {
    updates.contractorId = user.userId;
  }
  if (effectiveStatus === 'new' && status === 'cancelled') {
    updates.contractorId = null;
  }

  const updated = await db.update(orders)
    .set(updates)
    .where(and(eq(orders.id, id), eq(orders.status, order.status)))
    .returning();

  if (updated.length === 0) {
    return c.json({ error: { code: 'CONFLICT', message: 'Order was modified concurrently — please refresh' } }, 409);
  }

  await db.insert(orderHistory).values({
    orderId: id,
    status: effectiveStatus,
    note: effectiveStatus !== status
      ? `Contractor released order (reverted to new) by user ${user.userId}`
      : `Status changed by user ${user.userId}`,
  });

  // Increment cancelCount when customer cancels an accepted order (penalty for unreliability)
  if (status === 'cancelled' && order.status === 'accepted' && order.customerId === user.userId) {
    db.execute(sql`UPDATE users SET cancel_count = cancel_count + 1 WHERE id = ${order.customerId}`).catch(() => {});
  }

  // Real-time notifications via WebSocket
  const updatedOrder = updated[0];
  const statusLabels: Record<string, string> = {
    accepted: 'Исполнитель принял заказ',
    en_route: 'Исполнитель выехал к вам',
    in_progress: 'Исполнитель выполняет заказ',
    pending_confirmation: 'Ожидает вашего подтверждения',
    completed: 'Заказ выполнен',
    cancelled: 'Заказ отменён',
    new: 'Исполнитель отказался от заказа',
  };
  const label = statusLabels[effectiveStatus] || effectiveStatus;
  const event = { type: 'order_status', orderId: id, status: effectiveStatus, title: label, message: `Заказ #${id.slice(0, 8)}` };
  if (updatedOrder.customerId) emitToUser(updatedOrder.customerId, event);
  if (updatedOrder.contractorId && updatedOrder.contractorId !== updatedOrder.customerId) {
    emitToUser(updatedOrder.contractorId, event);
  }

  // Push + Telegram notifications
  const shortId = id.slice(0, 8);
  const notifyBody = `Заказ #${shortId} · ${updatedOrder.address}`;
  if (effectiveStatus === 'accepted' || effectiveStatus === 'en_route' || effectiveStatus === 'in_progress' || effectiveStatus === 'pending_confirmation' || effectiveStatus === 'completed') {
    // Notify customer about contractor actions
    if (updatedOrder.customerId) notifyUser(updatedOrder.customerId, label, notifyBody, id);
  } else if (effectiveStatus === 'cancelled') {
    const cancelledBy = order.customerId === user.userId ? 'customer' : 'contractor';
    const notifyId = cancelledBy === 'customer' ? updatedOrder.contractorId : updatedOrder.customerId;
    if (notifyId) notifyUser(notifyId, label, notifyBody, id);
  } else if (effectiveStatus === 'new' && status === 'cancelled') {
    // Contractor released order — notify customer their order is available again
    if (updatedOrder.customerId) notifyUser(updatedOrder.customerId, 'Исполнитель отказался от заказа', `Заказ #${shortId} снова доступен для других исполнителей`, id);
  }

  // Email notifications (fire and forget)
  if (status === 'accepted' && updatedOrder.customerId) {
    db.select({ email: users.notifEmailAddress, notif: users.notifEmail })
      .from(users).where(eq(users.id, updatedOrder.customerId)).limit(1)
      .then(([cu]) => {
        if (cu?.notif && cu.email) {
          db.select({ name: users.name }).from(users).where(eq(users.id, user.userId)).limit(1).then(([c]) => {
            sendOrderAcceptedEmail(cu.email!, {
              contractorName: c?.name ?? 'Исполнитель',
              address: updatedOrder.address,
              scheduledAt: updatedOrder.scheduledAt?.toISOString() ?? null,
              price: updatedOrder.price,
              orderId: id,
            }).catch(() => {});
          }).catch(() => {});
        }
      }).catch(() => {});
  }
  if (effectiveStatus === 'cancelled') {
    const cancelledBy = order.customerId === user.userId ? 'customer' : 'contractor';
    const notifyId = cancelledBy === 'customer' ? updatedOrder.contractorId : updatedOrder.customerId;
    if (notifyId) {
      db.select({ email: users.notifEmailAddress, notif: users.notifEmail })
        .from(users).where(eq(users.id, notifyId)).limit(1)
        .then(([u]) => {
          if (u?.notif && u.email) {
            sendOrderCancelledEmail(u.email, { address: updatedOrder.address, cancelledBy }).catch(() => {});
          }
        }).catch(() => {});
    }
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

  const completeOrder = updated[0];

  // Push + Telegram: notify customer that work is done, needs confirmation
  if (completeOrder.customerId) {
    notifyUser(completeOrder.customerId, '🔔 Работа завершена', `Исполнитель выполнил заказ #${id.slice(0, 8)} — подтвердите`, id);
  }

  // Email customer to confirm (fire and forget)
  db.select({ email: users.notifEmailAddress, notif: users.notifEmail })
    .from(users).where(eq(users.id, completeOrder.customerId)).limit(1)
    .then(([cu]) => {
      if (cu?.notif && cu.email) {
        db.select({ name: users.name }).from(users).where(eq(users.id, user.userId)).limit(1).then(([ct]) => {
          sendOrderCompletedEmail(cu.email!, {
            address: completeOrder.address,
            contractorName: ct?.name ?? 'Исполнитель',
            orderId: id,
          }).catch(() => {});
        }).catch(() => {});
      }
    }).catch(() => {});

  return c.json({ data: formatOrder(updated[0]) });
});

// POST /orders/:id/confirm — customer confirms work done, moves to pending_payment (SBP transfer step)
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
        .set({ status: 'pending_payment', updatedAt: new Date() })
        .where(and(eq(orders.id, id), eq(orders.status, 'pending_confirmation')))
        .returning();

      if (updated.length === 0) {
        throw Object.assign(new Error('RACE'), { code: 'ALREADY_CONFIRMED' });
      }

      await tx.insert(orderHistory).values({
        orderId: id,
        status: 'pending_payment',
        note: `Work confirmed by customer ${user.userId}, awaiting SBP payment confirmation`,
      });

      return updated[0];
    });
  } catch (err: any) {
    if (err?.code === 'ALREADY_CONFIRMED') {
      return c.json({ error: { code: 'CONFLICT', message: 'Order already confirmed' } }, 409);
    }
    throw err;
  }

  // Notify contractor: customer confirmed work, waiting for payment
  if (order.contractorId) {
    const msg = `Ожидайте оплату по СБП ${order.price}₽ — затем нажмите «Деньги получены»`;
    emitToUser(order.contractorId, { type: 'order_status', orderId: id, title: '💳 Заказчик подтвердил работу', message: msg });
    notifyUser(order.contractorId, '💳 Заказчик подтвердил работу', msg, id);
  }

  return c.json({ data: formatOrder(confirmed) });
});

// POST /orders/:id/confirm-payment — contractor confirms SBP payment received → completed
ordersRouter.post('/:id/confirm-payment', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const current = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (current.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  }

  const order = current[0];
  if (order.contractorId !== user.userId) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Not your order' } }, 403);
  }
  if (order.status !== 'pending_payment') {
    return c.json({ error: { code: 'INVALID_TRANSITION', message: 'Order must be pending_payment' } }, 400);
  }

  let completed;
  try {
    completed = await db.transaction(async (tx) => {
      const updated = await tx.update(orders)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(and(eq(orders.id, id), eq(orders.status, 'pending_payment')))
        .returning();

      if (updated.length === 0) {
        throw Object.assign(new Error('RACE'), { code: 'ALREADY_COMPLETED' });
      }

      // Credit contractor balance + XP
      const contractorRow = await tx.select({ xp: users.xp }).from(users)
        .where(eq(users.id, order.contractorId!)).limit(1);
      const newXp = (contractorRow[0]?.xp ?? 0) + 10;
      await tx.update(users)
        .set({ balance: sql`balance + ${order.price}`, xp: newXp, level: calcLevel(newXp) })
        .where(eq(users.id, order.contractorId!));

      // Customer XP
      const customerRow = await tx.select({ xp: users.xp }).from(users)
        .where(eq(users.id, order.customerId)).limit(1);
      const customerNewXp = (customerRow[0]?.xp ?? 0) + 10;
      await tx.update(users)
        .set({ xp: customerNewXp, level: calcLevel(customerNewXp) })
        .where(eq(users.id, order.customerId));

      await tx.insert(orderHistory).values({
        orderId: id,
        status: 'completed',
        note: `Payment confirmed by contractor ${user.userId}`,
      });

      return updated[0];
    });
  } catch (err: any) {
    if (err?.code === 'ALREADY_COMPLETED') {
      return c.json({ error: { code: 'CONFLICT', message: 'Order already completed' } }, 409);
    }
    throw err;
  }

  // Notify customer: order fully done
  const doneMsg = `Исполнитель подтвердил получение оплаты ${order.price}₽`;
  emitToUser(order.customerId, { type: 'order_status', orderId: id, title: '✅ Заказ завершён', message: doneMsg });
  notifyUser(order.customerId, '✅ Заказ завершён', doneMsg, id);

  // Email contractor: payment confirmed (fire and forget)
  db.select({ email: users.notifEmailAddress, notif: users.notifEmail })
    .from(users).where(eq(users.id, order.contractorId!)).limit(1)
    .then(([ct]) => {
      if (ct?.notif && ct.email) {
        sendOrderConfirmedEmail(ct.email, { address: order.address, amount: order.price }).catch(() => {});
      }
    }).catch(() => {});

  // Achievements (fire and forget)
  checkEcoAchievements(order.customerId).catch(() => {});
  checkOrderAchievements(order.contractorId!, 'contractor').catch(() => {});
  checkVolumeAchievements(order.contractorId!).catch(() => {});
  checkDistrictAchievements(order.contractorId!).catch(() => {});
  checkTimeAchievements(order.contractorId!).catch(() => {});
  checkVehicleAchievements(order.contractorId!).catch(() => {});
  checkTenureAchievements(order.contractorId!).catch(() => {});
  if (order.asap) checkAsapAchievements(order.contractorId!).catch(() => {});

  // Referral bonus: if contractor was referred, check 150₽ milestone + 5% monthly
  try {
    const contractorRow = await db.select({ referredBy: users.referredBy })
      .from(users).where(eq(users.id, order.contractorId!)).limit(1);
    const referrerId = contractorRow[0]?.referredBy;

    if (referrerId) {
      const refRow = await db.select().from(referrals)
        .where(and(eq(referrals.referrerId, referrerId), eq(referrals.refereeId, order.contractorId!)))
        .limit(1);
      const ref = refRow[0];

      if (ref) {
        const [countRow] = await db.select({ cnt: sql<number>`count(*)` })
          .from(orders)
          .where(and(eq(orders.contractorId, order.contractorId!), eq(orders.status, 'completed')));
        const refeeOrderCount = Number(countRow?.cnt ?? 0);

        if (!ref.bonus150Paid && refeeOrderCount >= 5) {
          const claimed = await db.update(referrals)
            .set({ bonus150Paid: true })
            .where(and(eq(referrals.id, ref.id), eq(referrals.bonus150Paid, false)))
            .returning({ id: referrals.id });
          if (claimed.length > 0) {
            await db.update(users).set({ balance: sql`balance + 150` }).where(eq(users.id, referrerId));
            emitToUser(referrerId, { type: 'order_status', orderId: id, title: '💰 Бонус за напарника!', message: 'Ваш напарник выполнил 5 заказов — вам начислено +150₽' });
          }
        }

        if (ref.bonusExpiresAt && new Date() < ref.bonusExpiresAt) {
          const cap = 500;
          const bonus5pct = Math.floor(order.price * 0.05);
          const alreadyUsed = ref.bonusMonthlyUsed ?? 0;
          const canAward = Math.min(bonus5pct, cap - alreadyUsed);
          if (canAward > 0) {
            const awarded = await db.update(referrals)
              .set({ bonusMonthlyUsed: sql`LEAST(bonus_monthly_used + ${canAward}, ${cap})` })
              .where(and(eq(referrals.id, ref.id), sql`bonus_monthly_used < ${cap}`))
              .returning({ bonusMonthlyUsed: referrals.bonusMonthlyUsed });
            if (awarded.length > 0) {
              await db.update(users).set({ balance: sql`balance + ${canAward}` }).where(eq(users.id, referrerId));
              emitToUser(referrerId, { type: 'order_status', orderId: id, title: `💰 +${canAward}₽ бонус`, message: `5% от заказа напарника (${order.price}₽)` });
            }
          }
        }
      }
    }
  } catch { /* referral bonus failure doesn't block main flow */ }

  return c.json({ data: formatOrder(completed) });
});

// POST /orders/:id/rate — leave a rating for the other party
ordersRouter.post('/:id/rate', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const rating = Number(body?.rating);
  const review = body?.review ? String(body.review).slice(0, 300).trim() : null;
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
    // Customer rates contractor — atomic to prevent double-rating under concurrent requests
    const ratingUpdate = await db.update(orders)
      .set({ ratingByCustomer: rating, ...(review ? { reviewByCustomer: review } : {}) } as any)
      .where(and(eq(orders.id, id), sql`${orders.ratingByCustomer} IS NULL`))
      .returning({ id: orders.id });
    if (ratingUpdate.length === 0) {
      return c.json({ error: { code: 'ALREADY_RATED', message: 'Already rated' } }, 400);
    }
    if (order.contractorId) {
      const contractor = await db.select({ xp: users.xp }).from(users).where(eq(users.id, order.contractorId)).limit(1);
      const newXp = (contractor[0]?.xp ?? 0) + rating;
      const newLevel = calcLevel(newXp);
      await db.update(users).set({ xp: newXp, level: newLevel }).where(eq(users.id, order.contractorId));
      checkRatingAchievements(order.contractorId, rating).catch(() => {});
    }
  } else if (order.contractorId === user.userId) {
    // Contractor rates customer — atomic
    const ratingUpdate = await db.update(orders)
      .set({ ratingByContractor: rating })
      .where(and(eq(orders.id, id), sql`${orders.ratingByContractor} IS NULL`))
      .returning({ id: orders.id });
    if (ratingUpdate.length === 0) {
      return c.json({ error: { code: 'ALREADY_RATED', message: 'Already rated' } }, 400);
    }
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

// POST /orders/:id/payment-dispute — contractor claims they didn't receive payment
// Freezes the customer account and logs for admin review
ordersRouter.post('/:id/payment-dispute', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const current = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (current.length === 0) return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  const order = current[0];

  if (order.contractorId !== user.userId) return c.json({ error: { code: 'FORBIDDEN', message: 'Not your order' } }, 403);
  if (order.status !== 'completed') return c.json({ error: { code: 'INVALID', message: 'Order must be completed' } }, 400);

  const existing = await db.select({ id: orderHistory.id })
    .from(orderHistory)
    .where(and(eq(orderHistory.orderId, id), like(orderHistory.note, 'PAYMENT_DISPUTE:%')))
    .limit(1);
  if (existing.length > 0) return c.json({ error: { code: 'CONFLICT', message: 'Payment dispute already filed' } }, 409);

  await db.insert(orderHistory).values({
    orderId: id,
    status: 'completed',
    note: `PAYMENT_DISPUTE: contractor ${user.userId} claims non-payment`,
  });

  await db.update(users)
    .set({ frozen: true, freezeReason: `Payment dispute on order ${id} — contractor reported non-payment` } as any)
    .where(eq(users.id, order.customerId));

  emitToUser(user.userId, { type: 'order_status', orderId: id, title: 'Спор принят', message: 'Аккаунт заказчика заморожен до выяснения обстоятельств' });

  return c.json({ data: { ok: true } });
});

// POST /orders/:id/block-customer — contractor blocks customer's address for non-payment
ordersRouter.post('/:id/block-customer', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const current = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (current.length === 0) return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  const order = current[0];

  if (order.contractorId !== user.userId) return c.json({ error: { code: 'FORBIDDEN', message: 'Not your order' } }, 403);

  const alreadyBlocked = await db.select({ id: blockedAddresses.id })
    .from(blockedAddresses)
    .where(and(eq(blockedAddresses.customerId, order.customerId), sql`lower(${blockedAddresses.address}) = lower(${order.address})`))
    .limit(1);
  if (alreadyBlocked.length > 0) return c.json({ error: { code: 'CONFLICT', message: 'Address already blocked' } }, 409);

  await db.insert(blockedAddresses).values({
    address: order.address,
    customerId: order.customerId,
    contractorId: user.userId,
    orderId: id,
    reason: `Non-payment on order ${id}`,
  });

  await db.update(users)
    .set({ frozen: true, freezeReason: `Заблокирован за неоплату заказа ${id}` } as any)
    .where(eq(users.id, order.customerId));

  await db.insert(orderHistory).values({
    orderId: id,
    status: order.status,
    note: `BLOCK: contractor ${user.userId} blocked customer address for non-payment`,
  });

  notifyUser(order.customerId, '⛔ Аккаунт заморожен', 'Исполнитель заблокировал вас за неоплату. Оспорьте блокировку в профиле.', id);

  return c.json({ data: { ok: true } });
});

// POST /orders/:id/unassign-contractor — customer removes unresponsive contractor, order reverts to new
ordersRouter.post('/:id/unassign-contractor', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');

  const current = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (current.length === 0) return c.json({ error: { code: 'NOT_FOUND', message: 'Order not found' } }, 404);
  const order = current[0];

  if (order.customerId !== user.userId) return c.json({ error: { code: 'FORBIDDEN', message: 'Only the customer can unassign the contractor' } }, 403);
  if (order.status !== 'accepted') return c.json({ error: { code: 'INVALID_STATUS', message: 'Order is not in accepted state' } }, 400);
  if (order.contractorId === null) return c.json({ error: { code: 'NO_CONTRACTOR', message: 'No contractor assigned' } }, 400);

  const prevContractorId = order.contractorId;

  await db.update(orders)
    .set({ status: 'new', contractorId: null, updatedAt: new Date() })
    .where(eq(orders.id, id));

  await db.insert(orderHistory).values({
    orderId: id,
    status: 'new',
    note: `Contractor ${prevContractorId} removed by customer ${user.userId} due to no response`,
  });

  const event = { type: 'order_status', orderId: id, status: 'new', title: 'Заказчик убрал вас с заказа', message: `Заказ #${id.slice(0, 8)}` };
  emitToUser(prevContractorId, event);
  notifyUser(prevContractorId, 'Заказчик убрал вас с заказа', `Заказ #${id.slice(0, 8)} · ${order.address}`, id);

  return c.json({ ok: true });
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
    wasteType: o.wasteType ?? 'household',
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
    ratingByCustomer: o.ratingByCustomer ?? null,
    reviewByCustomer: (o as any).reviewByCustomer ?? null,
    ratingByContractor: o.ratingByContractor ?? null,
  };
}

export default ordersRouter;
