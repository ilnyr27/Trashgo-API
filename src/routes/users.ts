import { Hono } from 'hono';
import { eq, and, isNotNull, avg, count, desc, gt, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { users, orders, otpCodes } from '../db/schema.js';
import { sendEmailOtp, isEmailEnabled } from '../lib/email.js';
import { rateLimit } from '../lib/rateLimit.js';
import { censor } from '../lib/censor.js';
import { authMiddleware, type JwtPayload } from '../middleware/auth.js';

const usersRouter = new Hono<{ Variables: { user: JwtPayload } }>();

usersRouter.use('*', authMiddleware);

const TRANSPORT_MODES = ['pedestrian', 'scooter', 'bicycle', 'e-bicycle', 'moto', 'car'] as const;

const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  district: z.string().min(1).max(100).optional(),
  transportMode: z.enum(TRANSPORT_MODES).optional(),
  addresses: z.array(z.string().max(300)).max(10).optional(),
  notifPush: z.boolean().optional(),
  notifEmail: z.boolean().optional(),
  notifEmailAddress: z.string().email().max(200).optional().nullable(),
  notifTelegram: z.boolean().optional(),
  fcmToken: z.string().max(300).optional().nullable(),
  isAvailable: z.boolean().optional(),
  inn: z.string().regex(/^\d{12}$/).optional().nullable(),
});

// GET /users/me
usersRouter.get('/me', async (c) => {
  const { userId } = c.get('user');

  const result = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (result.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const u = result[0];

  // Compute avg rating: contractors receive ratingByCustomer, customers receive ratingByContractor
  const isContractor = u.role === 'contractor';
  const ratingData = await db.select({
    avgRating: avg(isContractor ? orders.ratingByCustomer : orders.ratingByContractor),
    ratingCount: count(isContractor ? orders.ratingByCustomer : orders.ratingByContractor),
  }).from(orders).where(
    isContractor
      ? and(eq(orders.contractorId, userId), isNotNull(orders.ratingByCustomer))
      : and(eq(orders.customerId, userId), isNotNull(orders.ratingByContractor))
  );

  const avgRating = ratingData[0]?.avgRating ? parseFloat(ratingData[0].avgRating) : null;
  const ratingCount = ratingData[0]?.ratingCount ?? 0;

  let parsedAddresses: string[] = [];
  try { parsedAddresses = JSON.parse(u.addresses || '[]'); } catch {}

  return c.json({
    data: {
      id: u.id,
      phone: u.phone,
      name: u.name,
      role: u.role,
      district: u.district,
      transportMode: u.transportMode,
      xp: u.xp,
      level: u.level,
      balance: u.balance,
      addresses: parsedAddresses,
      avgRating,
      ratingCount,
      notifPush: u.notifPush ?? true,
      notifEmail: u.notifEmail ?? false,
      notifEmailAddress: u.notifEmailAddress ?? null,
      notifTelegram: (u as any).notifTelegram ?? true,
      email: u.email ?? null,
      telegramLinked: !!u.telegramChatId,
      isAvailable: u.isAvailable ?? true,
      inn: u.inn ?? null,
      innVerified: u.innVerified ?? false,
      frozen: u.frozen ?? false,
      freezeReason: u.freezeReason ?? null,
      createdAt: u.createdAt.toISOString(),
    },
  });
});

// PATCH /users/me
usersRouter.patch('/me', async (c) => {
  const { userId } = c.get('user');
  const body = await c.req.json();
  const parsed = updateProfileSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION', message: 'Invalid input' } }, 400);
  }

  const { addresses, notifEmailAddress, fcmToken, inn, ...rest } = parsed.data;
  const dbSet: Record<string, unknown> = { ...rest };
  if (dbSet.name) dbSet.name = censor(String(dbSet.name));
  if (addresses !== undefined) dbSet.addresses = JSON.stringify(addresses);
  if (notifEmailAddress !== undefined) dbSet.notifEmailAddress = notifEmailAddress;
  if (fcmToken !== undefined) dbSet.fcmToken = fcmToken;
  if (inn !== undefined) dbSet.inn = inn;

  const updated = await db.update(users)
    .set(dbSet as any)
    .where(eq(users.id, userId))
    .returning();

  if (updated.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const u = updated[0];
  let patchAddresses: string[] = [];
  try { patchAddresses = JSON.parse(u.addresses || '[]'); } catch {}

  return c.json({
    data: {
      id: u.id,
      phone: u.phone,
      name: u.name,
      role: u.role,
      district: u.district,
      transportMode: u.transportMode,
      xp: u.xp,
      level: u.level,
      balance: u.balance,
      addresses: patchAddresses,
      notifPush: u.notifPush ?? true,
      notifEmail: u.notifEmail ?? false,
      notifEmailAddress: u.notifEmailAddress ?? null,
      notifTelegram: (u as any).notifTelegram ?? true,
      email: u.email ?? null,
      telegramLinked: !!(u as any).telegramChatId,
      isAvailable: u.isAvailable ?? true,
      inn: u.inn ?? null,
      innVerified: u.innVerified ?? false,
      createdAt: u.createdAt.toISOString(),
    },
  });
});

// GET /users/payment-history — last 50 completed transactions
usersRouter.get('/payment-history', async (c) => {
  const { userId } = c.get('user');
  const userRow = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  if (!userRow.length) return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);

  const isContractor = userRow[0].role === 'contractor';
  const history = await db.select({
    id: orders.id,
    price: orders.price,
    address: orders.address,
    district: orders.district,
    updatedAt: orders.updatedAt,
  }).from(orders)
    .where(
      isContractor
        ? and(eq(orders.contractorId, userId), eq(orders.status, 'completed'))
        : and(eq(orders.customerId, userId), eq(orders.status, 'completed'))
    )
    .orderBy(desc(orders.updatedAt))
    .limit(50);

  return c.json({
    data: history.map(o => ({
      id: o.id,
      amount: o.price,
      address: o.address,
      district: o.district,
      date: o.updatedAt.toISOString(),
      type: isContractor ? 'earning' : 'payment',
    })),
  });
});

// GET /users/contractors — list of contractors with stats (for customer "find contractors" view)
usersRouter.get('/contractors', async (c) => {
  const district = c.req.query('district') || null;

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      district: users.district,
      transportMode: users.transportMode,
      level: users.level,
      xp: users.xp,
      completedOrders: count(orders.id),
      avgRating: avg(orders.ratingByCustomer),
      ratingCount: count(orders.ratingByCustomer),
    })
    .from(users)
    .leftJoin(
      orders,
      and(eq(orders.contractorId, users.id), eq(orders.status, 'completed'))
    )
    .where(
      district
        ? and(eq(users.role, 'contractor'), eq(users.district, district), eq(users.isAvailable, true))
        : and(eq(users.role, 'contractor'), eq(users.isAvailable, true))
    )
    .groupBy(users.id, users.name, users.district, users.transportMode, users.level, users.xp)
    .orderBy(desc(count(orders.id)))
    .limit(50);

  return c.json({
    data: rows.map(r => ({
      id: r.id,
      name: r.name,
      district: r.district,
      transportMode: r.transportMode,
      level: Number(r.level),
      xp: Number(r.xp),
      completedOrders: Number(r.completedOrders),
      avgRating: r.avgRating ? Number(Number(r.avgRating).toFixed(1)) : null,
      ratingCount: Number(r.ratingCount),
    })),
  });
});

// GET /users/admin/frozen — developer-only list of frozen customer accounts
// Protected by ADMIN_SECRET env var (pass as ?secret=xxx or Authorization: Bearer xxx)
usersRouter.get('/admin/frozen', async (c) => {
  const adminSecret = process.env.ADMIN_SECRET;
  const provided = c.req.query('secret') || c.req.header('Authorization')?.replace('Bearer ', '');
  if (!adminSecret || provided !== adminSecret) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Admin access required' } }, 403);
  }

  const frozen = await db.select({
    id: users.id,
    phone: users.phone,
    name: users.name,
    freezeReason: users.freezeReason,
    createdAt: users.createdAt,
  }).from(users).where(eq(users.frozen, true)).orderBy(desc(users.createdAt));

  return c.json({ data: frozen });
});

// POST /users/admin/unfreeze/:id — unfreeze a customer account
usersRouter.post('/admin/unfreeze/:id', async (c) => {
  const adminSecret = process.env.ADMIN_SECRET;
  const provided = c.req.query('secret') || c.req.header('Authorization')?.replace('Bearer ', '');
  if (!adminSecret || provided !== adminSecret) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Admin access required' } }, 403);
  }
  const id = c.req.param('id');
  await db.update(users).set({ frozen: false, freezeReason: null } as any).where(eq(users.id, id));
  return c.json({ data: { ok: true } });
});

// GET /users/my-contractors — contractors the customer has worked with
usersRouter.get('/my-contractors', async (c) => {
  const { userId } = c.get('user');
  // Get distinct contractors from customer's completed orders
  const rows = await db
    .selectDistinct({
      id: users.id,
      name: users.name,
      district: users.district,
      transportMode: users.transportMode,
      xp: users.xp,
      level: users.level,
      avgRating: avg(orders.ratingByCustomer),
      ordersCompleted: count(orders.id),
    })
    .from(orders)
    .innerJoin(users, eq(users.id, orders.contractorId))
    .where(and(eq(orders.customerId, userId), eq(orders.status, 'completed'), isNotNull(orders.contractorId)))
    .groupBy(users.id, users.name, users.district, users.transportMode, users.xp, users.level)
    .orderBy(desc(count(orders.id)))
    .limit(20);

  return c.json({ data: rows.map(r => ({
    id: r.id,
    name: r.name,
    district: r.district,
    transportMode: r.transportMode,
    xp: r.xp,
    level: r.level,
    avgRating: r.avgRating ? Number(Number(r.avgRating).toFixed(1)) : null,
    ordersCompleted: Number(r.ordersCompleted),
  })) });
});

// POST /users/appeal-freeze — submit an appeal for account unfreeze
usersRouter.post('/appeal-freeze', async (c) => {
  const { userId } = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const reason = ((body as any)?.reason ?? '').toString().trim().slice(0, 500);
  if (!reason) return c.json({ error: { code: 'VALIDATION', message: 'Reason required' } }, 400);

  const row = await db.select({ id: users.id, frozen: users.frozen }).from(users).where(eq(users.id, userId)).limit(1);
  if (!row[0]?.frozen) return c.json({ error: { code: 'NOT_FROZEN', message: 'Account is not frozen' } }, 400);

  // Store appeal in freeze reason as suffix (simple approach without extra table)
  await db.update(users)
    .set({ freezeReason: `[Оспорено]: ${reason}` } as any)
    .where(eq(users.id, userId));

  return c.json({ data: { ok: true } });
});

// POST /users/verify-inn — check self-employment status via FNS API
usersRouter.post('/verify-inn', async (c) => {
  const { userId } = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const inn = (body as any)?.inn?.toString().trim() ?? '';
  if (!/^\d{12}$/.test(inn)) {
    return c.json({ error: { code: 'VALIDATION', message: 'ИНН должен содержать 12 цифр' } }, 400);
  }

  const today = new Date().toISOString().slice(0, 10);
  let selfEmployed = false;
  try {
    const res = await fetch('https://statusnpd.nalog.ru/api/v1/tracker/taxpayers_status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ inn, requestDate: today }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json() as any;
      selfEmployed = data?.status === true || data?.taxpayerStatus === 1;
    }
  } catch (e: any) {
    console.warn('[FNS] Verification failed:', e.message);
    return c.json({ error: { code: 'FNS_UNAVAILABLE', message: 'Сервис ФНС недоступен — попробуйте позже' } }, 503);
  }

  // Save inn + verification result
  await db.update(users)
    .set({ inn, innVerified: selfEmployed } as any)
    .where(eq(users.id, userId));

  return c.json({ data: { inn, selfEmployed } });
});

// POST /users/request-email-change — send OTP to new email
usersRouter.post('/request-email-change', async (c) => {
  const { userId } = c.get('user');
  const { email } = await c.req.json().catch(() => ({}));

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
    return c.json({ error: { code: 'VALIDATION', message: 'Введите корректный email' } }, 400);
  }

  const retryAfter = rateLimit(`email_change:${userId}`, 3, 10 * 60 * 1000);
  if (retryAfter > 0) {
    c.header('Retry-After', String(retryAfter));
    return c.json({ error: { code: 'RATE_LIMITED', message: 'Слишком много попыток. Подождите.' } }, 429);
  }

  // Check email not already taken by another user
  const taken = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.email, email as string), ne(users.id, userId))).limit(1);
  if (taken.length > 0) {
    return c.json({ error: { code: 'EMAIL_TAKEN', message: 'Этот email уже используется другим аккаунтом' } }, 409);
  }

  const forceCode = process.env.TEST_OTP_CODE;
  const code = forceCode || String(Math.floor(1000 + Math.random() * 9000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  const otpKey = `ec:${userId}`;

  // Invalidate previous pending email-change OTPs for this user
  try {
    await db.update(otpCodes).set({ used: 1 }).where(and(eq(otpCodes.phone, otpKey), eq(otpCodes.used, 0)));
    await db.insert(otpCodes).values({ phone: otpKey, code, expiresAt });
  } catch (e: any) {
    console.error('[request-email-change] DB error:', e?.message);
    return c.json({ error: { code: 'DB_ERROR', message: 'Ошибка сервера. Попробуйте позже.' } }, 500);
  }

  if (isEmailEnabled()) {
    await sendEmailOtp(email as string, code);
  } else {
    console.log(`[OTP DEV] email-change ${email}: ${code}`);
  }

  return c.json({
    data: {
      sent: true,
      ...((!isEmailEnabled() || forceCode) ? { devCode: code } : {}),
    },
  });
});

// POST /users/confirm-email-change — verify OTP and save new email
usersRouter.post('/confirm-email-change', async (c) => {
  const { userId } = c.get('user');
  const { email, code } = await c.req.json().catch(() => ({}));

  if (!email || !code) {
    return c.json({ error: { code: 'VALIDATION', message: 'email и code обязательны' } }, 400);
  }

  const verifyRetryAfter = rateLimit(`ec_verify:${userId}`, 5, 10 * 60 * 1000);
  if (verifyRetryAfter > 0) {
    c.header('Retry-After', String(verifyRetryAfter));
    return c.json({ error: { code: 'RATE_LIMITED', message: 'Слишком много попыток' } }, 429);
  }

  const otpKey = `ec:${userId}`;
  const otp = await db.select().from(otpCodes)
    .where(and(
      eq(otpCodes.phone, otpKey),
      eq(otpCodes.code, String(code)),
      eq(otpCodes.used, 0),
      gt(otpCodes.expiresAt, new Date()),
    )).limit(1);

  if (otp.length === 0) {
    return c.json({ error: { code: 'INVALID_OTP', message: 'Неверный или истёкший код' } }, 400);
  }

  // Check email not taken (race condition guard)
  const taken = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.email, String(email)), ne(users.id, userId))).limit(1);
  if (taken.length > 0) {
    return c.json({ error: { code: 'EMAIL_TAKEN', message: 'Этот email уже занят' } }, 409);
  }

  await db.update(otpCodes).set({ used: 1 }).where(eq(otpCodes.id, otp[0].id));
  await db.update(users).set({ email: String(email) }).where(eq(users.id, userId));

  return c.json({ data: { ok: true, email } });
});

export default usersRouter;
