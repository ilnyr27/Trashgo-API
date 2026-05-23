import { Hono } from 'hono';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { eq, and, gt, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, otpCodes, refreshTokens, referrals } from '../db/schema.js';
import { checkReferralAchievements } from '../lib/achievements.js';
import { emitToUser } from '../ws.js';
import { sendOtp, hasSms } from '../lib/sms.js';
import { hasTelegram, sendTelegramOtp, getBotUsername } from '../lib/telegram.js';
import { telegramTokens, cleanupTelegramTokens } from '../lib/telegramTokens.js';
import { verifyFirebaseIdToken, isFirebaseAdminReady } from '../lib/firebase-admin.js';
import { sendEmailOtp, isEmailEnabled } from '../lib/email.js';
import { rateLimit } from '../lib/rateLimit.js';
import { censor } from '../lib/censor.js';

const auth = new Hono();

// Validation schemas
const loginSchema = z.object({
  email: z.string().email(),
  phone: z.string().min(10).max(20).optional(),
  // Legacy phone-based login (backward compat for Telegram OTP flow)
  deliveryEmail: z.string().email().optional(),
});

const verifySchema = z.object({
  // email-based flow
  email: z.string().email().optional(),
  // legacy phone-based flow
  phone: z.string().min(10).max(20).optional(),
  code: z.string().length(4),
  role: z.enum(['customer', 'contractor']).optional(),
});

function validateInn12(inn: string): boolean {
  if (!/^\d{12}$/.test(inn)) return false;
  const d = inn.split('').map(Number);
  const w1 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
  const w2 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
  const c1 = w1.reduce((s, w, i) => s + w * d[i], 0) % 11 % 10;
  const c2 = w2.reduce((s, w, i) => s + w * d[i], 0) % 11 % 10;
  return c1 === d[10] && c2 === d[11];
}

const registerSchema = z.object({
  // Email-based registration
  email: z.string().email().optional(),
  phone: z.string().min(10).max(20),
  code: z.string().length(4),
  name: z.string().min(1).max(100),
  role: z.enum(['customer', 'contractor']),
  district: z.string().min(1).max(100),
  transportMode: z.string().optional(),
  inn: z.string().regex(/^\d{12}$/).refine(validateInn12, { message: 'Неверный ИНН (неправильная контрольная сумма)' }).optional().or(z.literal('')),
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
    { expiresIn: '7d' }
  );
  const refreshToken = jwt.sign(
    { userId, role, type: 'refresh' },
    process.env.JWT_REFRESH_SECRET!,
    { expiresIn: '90d' }
  );
  return { token, refreshToken };
}

// POST /auth/login — send OTP (email-primary flow)
auth.post('/login', async (c) => {
  const body = await c.req.json();
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION', message: 'Введите корректный email', details: parsed.error.flatten().fieldErrors } }, 400);
  }

  const { email, phone, deliveryEmail } = parsed.data;

  // Rate limit by email
  const retryAfter = rateLimit(email);
  if (retryAfter > 0) {
    c.header('Retry-After', String(retryAfter));
    return c.json({ error: { code: 'RATE_LIMITED', message: 'Слишком много попыток. Подождите.' } }, 429);
  }

  // Look up user by email
  const existingByEmail = await db.select({ id: users.id, phone: users.phone, email: users.email, telegramChatId: users.telegramChatId })
    .from(users).where(eq(users.email, email)).limit(1);

  let existingUser = existingByEmail.length > 0 ? existingByEmail[0] : null;

  // If not found by email and phone was provided — check if this is an existing user by phone (migration case)
  if (!existingUser && phone) {
    const byPhone = await db.select({ id: users.id, phone: users.phone, email: users.email, telegramChatId: users.telegramChatId })
      .from(users).where(eq(users.phone, phone)).limit(1);
    if (byPhone.length > 0) {
      if (byPhone[0].email && byPhone[0].email !== email) {
        return c.json({ error: { code: 'EMAIL_MISMATCH', message: 'Этот номер уже привязан к другому email' } }, 409);
      }
      if (!byPhone[0].email) {
        await db.update(users).set({ email }).where(eq(users.id, byPhone[0].id));
      }
      existingUser = { ...byPhone[0], email };
    }
  }

  // New user flow: if not found by email or phone, and no phone provided — ask frontend to show phone field
  if (!existingUser && !phone) {
    return c.json({ data: { otpSent: false, isNewUser: true, needsPhone: true, channel: 'email' } });
  }

  const forceCode = process.env.TEST_OTP_CODE;
  const useEmailOtp = isEmailEnabled();
  const isProd = !forceCode && useEmailOtp;
  const code = forceCode || (isProd ? String(Math.floor(1000 + Math.random() * 9000)) : '1111');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  // Store OTP keyed by email
  await db.insert(otpCodes).values({ phone: email, code, expiresAt });

  let channel: 'email' | 'telegram' | 'dev' = 'dev';
  let telegramBotLink: string | undefined;

  if (useEmailOtp) {
    await sendEmailOtp(email, code);
    channel = 'email';
  } else if (hasTelegram() && existingUser?.telegramChatId) {
    await sendTelegramOtp(existingUser.telegramChatId, code);
    channel = 'telegram';
  } else if (hasTelegram()) {
    const botUsername = await getBotUsername();
    if (botUsername) {
      cleanupTelegramTokens();
      const startToken = nanoid(8);
      telegramTokens.set(startToken, { phone: email, code, exp: Date.now() + 10 * 60 * 1000 });
      telegramBotLink = `https://t.me/${botUsername}?start=${startToken}`;
      channel = 'telegram';
    } else {
      console.log(`[OTP DEV] ${email}: ${code}`);
    }
  } else {
    console.log(`[OTP DEV] ${email}: ${code}`);
  }

  return c.json({
    data: {
      otpSent: true,
      isNewUser: existingUser === null,
      needsPhone: false,
      channel,
      deliveryEmail: email,
      ...(telegramBotLink ? { telegramBotLink } : {}),
      ...((channel === 'dev' || !!forceCode) ? { devCode: code } : {}),
    },
  });
});

// POST /auth/verify — verify OTP (supports email-key and legacy phone-key)
auth.post('/verify', async (c) => {
  const body = await c.req.json();
  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION', message: 'Invalid input' } }, 400);
  }

  const { email, phone, code, role } = parsed.data;
  const otpKey = email || phone || '';
  if (!otpKey) return c.json({ error: { code: 'VALIDATION', message: 'email or phone required' } }, 400);

  // Brute-force protection
  const verifyRetryAfter = rateLimit(`verify:${otpKey}`, 5, 10 * 60 * 1000);
  if (verifyRetryAfter > 0) {
    c.header('Retry-After', String(verifyRetryAfter));
    return c.json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.' } }, 429);
  }

  // Find valid OTP (key = email or phone)
  const otp = await db.select()
    .from(otpCodes)
    .where(and(
      eq(otpCodes.phone, otpKey),
      eq(otpCodes.code, code),
      eq(otpCodes.used, 0),
      gt(otpCodes.expiresAt, new Date()),
    ))
    .limit(1);

  if (otp.length === 0) {
    return c.json({ error: { code: 'INVALID_OTP', message: 'Wrong or expired code' } }, 400);
  }

  // Find user — by email (new flow) or phone (legacy)
  const userRows = email
    ? await db.select().from(users).where(eq(users.email, email)).limit(1)
    : await db.select().from(users).where(eq(users.phone, phone!)).limit(1);

  // Block frozen accounts before consuming the OTP
  if (userRows.length > 0 && (userRows[0] as any).frozen) {
    return c.json({ error: { code: 'ACCOUNT_FROZEN', message: 'Ваш аккаунт заморожен. Обратитесь в поддержку.' } }, 403);
  }

  // Mark OTP as used only after confirming the account can proceed
  await db.update(otpCodes).set({ used: 1 }).where(eq(otpCodes.id, otp[0].id));

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
  const refreshExpires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
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

  const { email, phone, code, name, role, district, transportMode, inn, refCode } = parsed.data;
  // OTP key: email (new flow) or phone (legacy)
  const otpKey = email || phone;

  // Verify OTP was used for this key
  const otp = await db.select()
    .from(otpCodes)
    .where(and(
      eq(otpCodes.phone, otpKey),
      eq(otpCodes.code, code),
      eq(otpCodes.used, 1),
    ))
    .limit(1);

  if (otp.length === 0) {
    return c.json({ error: { code: 'INVALID_OTP', message: 'Сначала подтвердите email' } }, 400);
  }

  // Check if user already exists (by email or phone)
  const existingByPhone = await db.select({ id: users.id }).from(users).where(eq(users.phone, phone)).limit(1);
  if (existingByPhone.length > 0) {
    return c.json({ error: { code: 'USER_EXISTS', message: 'Аккаунт с таким номером уже существует' } }, 409);
  }
  if (email) {
    const existingByEmail = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existingByEmail.length > 0) {
      return c.json({ error: { code: 'USER_EXISTS', message: 'Аккаунт с таким email уже существует' } }, 409);
    }
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
    name: censor(name),
    role,
    district,
    ...(email ? { email } : {}),
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
  const refreshExpires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
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
  const refreshExpires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
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
  const refreshExpires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
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
    const refreshExpires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
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

// POST /auth/request-telegram — generate Telegram bot link as SMS fallback
// Returns a deep link so the user can get their OTP via the bot instead of SMS
auth.post('/request-telegram', async (c) => {
  if (!hasTelegram()) {
    return c.json({ error: { code: 'NOT_CONFIGURED', message: 'Telegram bot not configured' } }, 503);
  }

  const body = await c.req.json().catch(() => ({}));
  const phone = String(body?.phone ?? '').trim();
  if (!phone) {
    return c.json({ error: { code: 'VALIDATION', message: 'Phone required' } }, 400);
  }

  const retryAfter = rateLimit(`tg:${phone}`, 3, 5 * 60 * 1000);
  if (retryAfter > 0) {
    c.header('Retry-After', String(retryAfter));
    return c.json({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }, 429);
  }

  // Reuse existing valid OTP or create new one
  const existing = await db.select()
    .from(otpCodes)
    .where(and(eq(otpCodes.phone, phone), eq(otpCodes.used, 0), gt(otpCodes.expiresAt, new Date())))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);

  let code: string;
  if (existing.length > 0) {
    code = existing[0].code;
  } else {
    code = String(Math.floor(1000 + Math.random() * 9000));
    await db.insert(otpCodes).values({ phone, code, expiresAt: new Date(Date.now() + 10 * 60 * 1000) });
  }

  const botUsername = await getBotUsername();
  if (!botUsername) {
    return c.json({ error: { code: 'BOT_UNAVAILABLE', message: 'Telegram bot unavailable' } }, 503);
  }

  cleanupTelegramTokens();
  const startToken = nanoid(8);
  telegramTokens.set(startToken, { phone, code, exp: Date.now() + 10 * 60 * 1000 });
  const telegramBotLink = `https://t.me/${botUsername}?start=${startToken}`;

  return c.json({ data: { telegramBotLink } });
});

export default auth;
