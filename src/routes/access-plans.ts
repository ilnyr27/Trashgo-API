import { Hono } from 'hono';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accessPlans, users, promoCodes } from '../db/schema.js';
import { authMiddleware, type JwtPayload } from '../middleware/auth.js';
import { getSubStatus, countActiveReferees, PLAN_PRICE, REFERRAL_DISCOUNT } from '../lib/subscriptionStatus.js';
import { notifyAdmin } from '../lib/telegram.js';

const router = new Hono<{ Variables: { user: JwtPayload } }>();
router.use('*', authMiddleware);

// GET /access-plans/status
router.get('/status', async (c) => {
  const { userId } = c.get('user');

  const { status, expiresAt, trialEnd } = await getSubStatus(userId);
  const activeReferrals = await countActiveReferees(userId);
  const discountAmount = activeReferrals * REFERRAL_DISCOUNT;
  const nextPrice = Math.max(0, PLAN_PRICE - discountAmount);

  const hasPending = (await db.select({ id: accessPlans.id })
    .from(accessPlans)
    .where(and(eq(accessPlans.userId, userId), eq(accessPlans.status, 'pending')))
    .limit(1)).length > 0;

  return c.json({ data: {
    status,
    expiresAt: expiresAt?.toISOString() ?? null,
    trialEndsAt: trialEnd.toISOString(),
    activeReferrals,
    discountAmount,
    nextPrice,
    hasPendingRequest: hasPending,
  } });
});

// GET /access-plans/history
router.get('/history', async (c) => {
  const { userId } = c.get('user');

  const history = await db.select()
    .from(accessPlans)
    .where(eq(accessPlans.userId, userId))
    .orderBy(desc(accessPlans.createdAt))
    .limit(20);

  return c.json({ data: history.map(p => ({
    id: p.id,
    status: p.status,
    priceAtPurchase: p.priceAtPurchase,
    paymentRef: p.paymentRef,
    startsAt: p.startsAt?.toISOString() ?? null,
    expiresAt: p.expiresAt?.toISOString() ?? null,
    confirmedAt: p.confirmedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
  })) });
});

// POST /access-plans/request — request manual payment confirmation
router.post('/request', async (c) => {
  const { userId } = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const paymentRef = typeof body.paymentRef === 'string' ? body.paymentRef.trim().slice(0, 200) : null;
  const promoCodeInput = typeof body.promoCode === 'string' ? body.promoCode.trim().toUpperCase().slice(0, 50) : null;

  const existing = await db.select({ id: accessPlans.id })
    .from(accessPlans)
    .where(and(eq(accessPlans.userId, userId), eq(accessPlans.status, 'pending')))
    .limit(1);

  if (existing.length > 0) {
    return c.json({ error: { code: 'ALREADY_PENDING', message: 'У вас уже есть ожидающий запрос на активацию' } }, 409);
  }

  const activeReferrals = await countActiveReferees(userId);
  let priceAtPurchase = Math.max(0, PLAN_PRICE - activeReferrals * REFERRAL_DISCOUNT);
  let promoDiscount = 0;
  let validPromoCode: string | null = null;

  if (promoCodeInput) {
    const [promo] = await db.select().from(promoCodes)
      .where(eq(promoCodes.code, promoCodeInput))
      .limit(1);
    if (!promo) {
      return c.json({ error: { code: 'INVALID_PROMO', message: 'Промокод не найден' } }, 400);
    }
    if (promo.expiresAt && promo.expiresAt < new Date()) {
      return c.json({ error: { code: 'PROMO_EXPIRED', message: 'Промокод истёк' } }, 400);
    }
    if (promo.maxUses > 0 && promo.usedCount >= promo.maxUses) {
      return c.json({ error: { code: 'PROMO_EXHAUSTED', message: 'Промокод исчерпан' } }, 400);
    }
    promoDiscount = promo.discountAmount;
    validPromoCode = promo.code;
    priceAtPurchase = Math.max(0, priceAtPurchase - promoDiscount);
    await db.execute(sql`UPDATE promo_codes SET used_count = used_count + 1 WHERE id = ${promo.id}`);
  }

  const [plan] = await db.insert(accessPlans).values({
    userId,
    status: 'pending',
    priceAtPurchase,
    discountApplied: (activeReferrals * REFERRAL_DISCOUNT) + promoDiscount,
    ...(paymentRef ? { paymentRef } : {}),
    ...(validPromoCode ? { promoCode: validPromoCode } : {}),
  }).returning();

  // Notify admin
  const [userRow] = await db.select({ name: users.name, phone: users.phone }).from(users).where(eq(users.id, userId)).limit(1);
  notifyAdmin(
    `💳 *Новый запрос на абонемент*\n\n` +
    `Пользователь: ${userRow?.name ?? '—'}\n` +
    `Сумма: ${priceAtPurchase}₽\n` +
    (validPromoCode ? `Промокод: ${validPromoCode} (−${promoDiscount}₽)\n` : '') +
    (paymentRef ? `Реквизит: ${paymentRef}\n` : '') +
    `\nПодтвердите в /admin → Абонементы`
  ).catch(() => {});

  return c.json({ data: {
    id: plan.id,
    priceAtPurchase: plan.priceAtPurchase,
    discountApplied: plan.discountApplied,
    promoCode: plan.promoCode ?? null,
    status: 'pending',
    createdAt: plan.createdAt.toISOString(),
  } }, 201);
});

// GET /access-plans/promo-check/:code — validate a promo code
router.get('/promo-check/:code', async (c) => {
  const code = c.req.param('code').toUpperCase().trim();
  const [promo] = await db.select().from(promoCodes).where(eq(promoCodes.code, code)).limit(1);
  if (!promo) return c.json({ error: { code: 'INVALID_PROMO', message: 'Промокод не найден' } }, 404);
  if (promo.expiresAt && promo.expiresAt < new Date()) return c.json({ error: { code: 'PROMO_EXPIRED', message: 'Промокод истёк' } }, 400);
  if (promo.maxUses > 0 && promo.usedCount >= promo.maxUses) return c.json({ error: { code: 'PROMO_EXHAUSTED', message: 'Промокод исчерпан' } }, 400);
  return c.json({ data: { code: promo.code, discountAmount: promo.discountAmount } });
});

export default router;
