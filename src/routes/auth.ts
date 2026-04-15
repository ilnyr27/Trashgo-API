import { Hono } from 'hono';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { eq, and, gt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, otpCodes, refreshTokens } from '../db/schema.js';

const auth = new Hono();

// Validation schemas
const loginSchema = z.object({
  phone: z.string().min(10).max(20),
});

const verifySchema = z.object({
  phone: z.string().min(10).max(20),
  code: z.string().length(4),
});

const registerSchema = z.object({
  phone: z.string().min(10).max(20),
  code: z.string().length(4),
  name: z.string().min(1).max(100),
  role: z.enum(['customer', 'contractor']),
  district: z.string().min(1).max(100),
});

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

  const { phone } = parsed.data;

  // Generate 4-digit OTP
  const code = String(Math.floor(1000 + Math.random() * 9000));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

  await db.insert(otpCodes).values({ phone, code, expiresAt });

  // Check if user exists
  const existing = await db.select().from(users).where(eq(users.phone, phone)).limit(1);

  // In production: send SMS here
  // For dev: log the code
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[OTP] ${phone}: ${code}`);
  }

  return c.json({
    data: {
      otpSent: true,
      isNewUser: existing.length === 0,
      // Dev only — remove in production
      ...(process.env.NODE_ENV !== 'production' && { devCode: code }),
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

  const { phone, code } = parsed.data;

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
  const user = await db.select().from(users).where(eq(users.phone, phone)).limit(1);
  if (user.length === 0) {
    return c.json({
      data: { verified: true, isNewUser: true },
    });
  }

  // Generate tokens
  const tokens = generateTokens(user[0].id, user[0].role);

  // Store refresh token
  const refreshExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.insert(refreshTokens).values({
    userId: user[0].id,
    token: tokens.refreshToken,
    expiresAt: refreshExpires,
  });

  return c.json({
    data: {
      user: {
        id: user[0].id,
        phone: user[0].phone,
        name: user[0].name,
        role: user[0].role,
        district: user[0].district,
        xp: user[0].xp,
        level: user[0].level,
        createdAt: user[0].createdAt.toISOString(),
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

  const { phone, code, name, role, district } = parsed.data;

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

  // Create user
  const newUser = await db.insert(users).values({
    phone,
    name,
    role,
    district,
  }).returning();

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
