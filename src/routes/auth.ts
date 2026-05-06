import { Hono } from 'hono';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { eq, and, gt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, otpCodes, refreshTokens, referrals } from '../db/schema.js';
import { checkReferralAchievements } from '../lib/achievements.js';
import { emitToUser } from '../ws.js';
import { sendOtp, hasSms } from '../lib/sms.js';
import { hasTelegram, sendTelegramOtp, getBotUsername } from '../lib/telegram.js';
import { verifyFirebaseIdToken, isFirebaseAdminReady } from '../lib/firebase-admin.js';
import { sendEmailOtp, isEmailEnabled } from '../lib/email.js';

const auth = new Hono();

// Validation schemas
const loginSchema = z.object({
  phone: z.string().min(10).max(20),
  deliveryEmail: z.string().email().optional(),
});

const verifySchema = z.object({
  phone: z.string().min(10).max(20),
  code: z.string().length(4),
  role: z.enum(['customer', 'contractor']).optional(),
});

const registerSchema = z.object({
  phone: z.string().min(10).max(20),
  code: z.string().length(4),
  name: z.string().min(1).max(100),
  role: z.enum(['customer', 'contractor']),
  district: z.string().min(1).max(100),
  transportMode: z.string().optional(),
  inn: z.string().regex(/^\d{12}$/).optional().or(z.literal('')),
  refCode: z.string().optional(),
});

function formatUser(u: { id: string; phone: string; name: string; role: string; district: string; xp: number; level: number; createdAt: Date }) {
  return { id: u.id, phone: u.phone, name: u.name, role: u.role, district: u.district, xp: u.xp, level: u.level, createdAt: u.createdAt.toISOString() };
}

// Generate tokens
function generateTokens(userId: string, role: 'customer' | 'contractor') {
  const token = jwt.sign(
    { userId, role },
    process.env.JWT_SECRET!,
    { expiresIn: '15m' }
  );
  const refreshToken = jwt.sign(
    { userId, role, type: 'refresh' },
    process.env.JWT_REFRESH_SECRET!,
    { expiresIn: '30d' }
  );
  return { token, refreshToken };
}

// POST /auth/login — send OTP
auth.post('/login', async (c) => {
  const body = await c.req.json();
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION', message: 'Invalid phone', details: parsed.error.flatten().fieldErrors } }, 400);
  }

  const { phone, deliveryEmail } = parsed.data;

  const useTelegram = hasTelegram();
  const useSms = hasSms();
  const useEmail = isEmailEnabled() && !!deliveryEmail;
  const forceCode = process.env.TEST_OTP_CODE;
  const isProd = !forceCode && (useTelegram || useSms || useEmail);
  const code = forceCode || (isProd ? String(Math.floor(1000 + Math.random() * 9000)) : '1111');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await db.insert(otpCodes).values({ phone, code, expiresAt });

  const existing = await db.select({ id: users.id, telegramChatId: users.telegramChatId })
    .from(users).where(eq(users.phone, phone)).limit(1);

  let channel: 'telegram' | 'sms' | 'dev' | 'email' = 'dev';
  let telegramBotLink: string | undefined;

  // Email takes priority if explicitly requested
  if (useEmail && deliveryEmail) {
    await sendEmailOtp(deliveryEmail, code);
    channel = 'email';
  } else if (useTelegram) {
    const chatId = existing[0]?.telegramChatId;
    if (chatId) {
      await sendTelegramOtp(chatId, code);
      channel = 'telegram';
    } else {
      const botUsername = await getBotUsername();
      const phoneEncoded = encodeURIComponent(phone);
      telegramBotLink = botUsername ? `https://t.me/${botUsername}?start=${phoneEncoded}` : undefined;
      channel = 'telegram';
    }
  } else if (useSms) {
    await sendOtp(phone, code);
    channel = 'sms';
  } else {
    console.log(`[OTP DEV] ${phone}: ${code}`);
    channel = 'dev';
  }

  return c.json({
    data: {
      otpSent: channel !== 'telegram' || !!existing[0]?.telegramChatId,
      isNewUser: existing.length === 0,
      channel,
      ...(telegramBotLink ? { telegramBotLink } : {}),
      ...(deliveryEmail && channel === 'email' ? { deliveryEmail } : {}),
      ...((channel === 'dev' || !!forceCode) ? { devCode: code } : {}),
    },
  });
});

// POST /auth/verify — verify OTP for existing user
auth.post('/verify', async (c) => {
  const body = await c.req.json();
  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION', message: 'Invalid input' } }, 400);
  }

  const { phone, code, role } = parsed.data;

  // Find valid OTP
  const otp = await db.select()
    .from(otpCodes)
    .where(and(
      eq(otpCodes.phone, phone),
      eq(otpCodes.code, code),
      eq(otpCodes.used, 0),
      gt(otpCodes.expiresAt, new Date()),
    ))
    .limit(1);

  if (otp.length === 0) {
    return c.json({ error: { code: 'INVALID_OTP', message: 'Wrong or expired code' } }, 400);
  }

  // Mark OTP as used
  await db.update(otpCodes).set({ used: 1 }).where(eq(otpCodes.id, otp[0].id));

  // Find user
  const userRows = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
  if (userRows.length === 0) {
    return c.json({
      data: { verified: true, isNewUser: true },
    });
  }

  let userRow = userRows[0];

  // Update role if the user is switching roles
  if (role && role !== userRow.role) {
    await db.update(users).set({ role }).where(eq(users.id, userRow.id));
    userRow = { ...userRow, role };
  }

  // Generate tokens
  const tokens = generateTokens(userRow.id, userRow.role);

  // Store refresh token
  const refreshExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.insert(refreshTokens).values({
    userId: userRow.id,
    token: tokens.refreshToken,
    expiresAt: refreshExpires,
  });

  return c.json({
    data: {
      user: {
        id: userRow.id,
        phone: userRow.phone,
        name: userRow.name,
        role: userRow.role,
        district: userRow.district,
        xp: userRow.xp,
        level: userRow.level,
        createdAt: userRow.createdAt.toISOString(),
      },
      token: tokens.token,
      refreshToken: tokens.refreshToken,
    },
  });
});

// POST /auth/register — register new user (after OTP verified)
auth.post('/register', async (c) => {
  const body = await c.req.json();
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION', message: 'Invalid input', details: parsed.error.flatten().fieldErrors } }, 400);
  }

  const { phone, code, name, role, district, transportMode, inn, refCode } = parsed.data;

  // Verify OTP was used for this phone
  const otp = await db.select()
    .from(otpCodes)
    .where(and(
      eq(otpCodes.phone, phone),
      eq(otpCodes.code, code),
      eq(otpCodes.used, 1),
    ))
    .limit(1);

  if (otp.length === 0) {
    return c.json({ error: { code: 'INVALID_OTP', message: 'Verify phone first' } }, 400);
  }

  // Check if user already exists
  const existing = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
  if (existing.length > 0) {
    return c.json({ error: { code: 'USER_EXISTS', message: 'User already registered' } }, 409);
  }

  // Resolve referrer if refCode provided
  let referrerId: string | undefined;
  if (refCode) {
    const referrer = await db.select({ id: users.id }).from(users).where(eq(users.referralCode, refCode)).limit(1);
    if (referrer.length > 0) referrerId = referrer[0].id;
  }

  // Generate unique referral code for new user
  const newReferralCode = nanoid(8).toUpperCase();

  // Create user
  const newUser = await db.insert(users).values({
    phone,
    name,
    role,
    district,
    ...(transportMode ? { transportMode } : {}),
    ...(inn ? { inn } : {}),
    referralCode: newReferralCode,
    referredBy: referrerId,
  }).returning();

  // Record referral relationship
  if (referrerId) {
    const bonusExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    await db.insert(referrals).values({ referrerId, refereeId: newUser[0].id, bonusExpiresAt });
    // Check referral achievements for the referrer (fire and forget)
    checkReferralAchievements(referrerId).catch(() => {});
    // Notify referrer via SSE
    const bonusMsg = role === 'contractor'
      ? `Напарник присоединился! После 5 заказов вы получите +150₽`
      : `Сосед зарегистрировался — ваша скидка увеличилась`;
    emitToUser(referrerId, { type: 'xp', title: '👥 Новый реферал!', message: bonusMsg });
  }

  const user = newUser[0];
  const tokens = generateTokens(user.id, user.role);

  // Store refresh token
  const refreshExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.insert(refreshTokens).values({
    userId: user.id,
    token: tokens.refreshToken,
    expiresAt: refreshExpires,
  });

  return c.json({
    data: {
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        role: user.role,
        district: user.district,
        xp: user.xp,
        level: user.level,
        createdAt: user.createdAt.toISOString(),
      },
      token: tokens.token,
      refreshToken: tokens.refreshToken,
    },
  }, 201);
});

// POST /auth/verify-firebase — verify Firebase Phone Auth ID token (free SMS via Firebase)
auth.post('/verify-firebase', async (c) => {
  if (!isFirebaseAdminReady()) {
    return c.json({ error: { code: 'NOT_CONFIGURED', message: 'Firebase not configured on server' } }, 503);
  }
  const body = await c.req.json().catch(() => ({}));
  const { idToken } = body;
  if (!idToken) return c.json({ error: { code: 'VALIDATION', message: 'Missing idToken' } }, 400);

  const phone = await verifyFirebaseIdToken(idToken);
  if (!phone) return c.json({ error: { code: 'INVALID_TOKEN', message: 'Invalid Firebase ID token' } }, 401);

  const existing = await db.select().from(users).where(eq(users.phone, phone)).limit(1);

  if (existing.length === 0) {
    // New user — issue short-lived phone-verified token for registration
    const tempToken = jwt.sign(
      { phone, type: 'firebase_verified' },
      process.env.JWT_SECRET!,
      { expiresIn: '10m' }
    );
    return c.json({ data: { isNewUser: true, phone, tempToken } });
  }

  const userRow = existing[0];
  const tokens = generateTokens(userRow.id, userRow.role);
  const refreshExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.insert(refreshTokens).values({ userId: userRow.id, token: tokens.refreshToken, expiresAt: refreshExpires });

  return c.json({
    data: {
      user: formatUser(userRow),
      token: tokens.token,
      refreshToken: tokens.refreshToken,
    },
  });
});

// POST /auth/register-firebase — register new user after Firebase phone verification
auth.post('/register-firebase', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { tempToken, name, role, district, transportMode, inn, refCode } = body;

  if (!tempToken || !name || !role || !district) {
    return c.json({ error: { code: 'VALIDATION', message: 'Missing fields' } }, 400);
  }
  if (!['customer', 'contractor'].includes(role)) {
    return c.json({ error: { code: 'VALIDATION', message: 'Invalid role' } }, 400);
  }

  let phone: string;
  try {
    const payload = jwt.verify(tempToken, process.env.JWT_SECRET!) as { phone: string; type: string };
    if (payload.type !== 'firebase_verified') throw new Error('Wrong token type');
    phone = payload.phone;
  } catch {
    return c.json({ error: { code: 'INVALID_TOKEN', message: 'Invalid or expired verification token' } }, 401);
  }

  const existing = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
  if (existing.length > 0) {
    return c.json({ error: { code: 'USER_EXISTS', message: 'User already registered' } }, 409);
  }

  let referrerId: string | undefined;
  if (refCode) {
    const referrer = await db.select({ id: users.id }).from(users).where(eq(users.referralCode, refCode)).limit(1);
    if (referrer.length > 0) referrerId = referrer[0].id;
  }

  const newReferralCode = nanoid(8).toUpperCase();
  const newUser = await db.insert(users).values({
    phone, name, role, district,
    ...(transportMode ? { transportMode } : {}),
    ...(inn ? { inn } : {}),
    referralCode: newReferralCode,
    referredBy: referrerId,
  }).returning();

  if (referrerId) {
    const bonusExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.insert(referrals).values({ referrerId, refereeId: newUser[0].id, bonusExpiresAt });
    checkReferralAchievements(referrerId).catch(() => {});
    const bonusMsg = role === 'contractor'
      ? `Напарник присоединился! После 5 заказов вы получите +150₽`
      : `Сосед зарегистрировался — ваша скидка увеличилась`;
    emitToUser(referrerId, { type: 'xp', title: '👥 Новый реферал!', message: bonusMsg });
  }

  const user = newUser[0];
  const tokens = generateTokens(user.id, user.role);
  const refreshExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.insert(refreshTokens).values({ userId: user.id, token: tokens.refreshToken, expiresAt: refreshExpires });

  return c.json({ data: { user: formatUser(user), token: tokens.token, refreshToken: tokens.refreshToken } }, 201);
});

// POST /auth/refresh — refresh access token
auth.post('/refresh', async (c) => {
  const body = await c.req.json();
  const { refreshToken: token } = body;

  if (!token) {
    return c.json({ error: { code: 'VALIDATION', message: 'Missing refresh token' } }, 400);
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET!) as { userId: string; role: 'customer' | 'contractor' };

    // Check token exists in DB
    const stored = await db.select()
      .from(refreshTokens)
      .where(and(
        eq(refreshTokens.token, token),
        gt(refreshTokens.expiresAt, new Date()),
      ))
      .limit(1);

    if (stored.length === 0) {
      return c.json({ error: { code: 'INVALID_TOKEN', message: 'Token revoked or expired' } }, 401);
    }

    // Delete old token, issue new pair
    await db.delete(refreshTokens).where(eq(refreshTokens.token, token));

    const tokens = generateTokens(payload.userId, payload.role);
    const refreshExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.insert(refreshTokens).values({
      userId: payload.userId,
      token: tokens.refreshToken,
      expiresAt: refreshExpires,
    });

    return c.json({ data: tokens });
  } catch {
    return c.json({ error: { code: 'INVALID_TOKEN', message: 'Invalid refresh token' } }, 401);
  }
});

export default auth;
