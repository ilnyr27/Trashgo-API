import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { authMiddleware, type JwtPayload } from '../middleware/auth.js';

const usersRouter = new Hono<{ Variables: { user: JwtPayload } }>();

usersRouter.use('*', authMiddleware);

const updateProfileSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  district: z.string().min(1).max(100).optional(),
});

// GET /users/me
usersRouter.get('/me', async (c) => {
  const { userId } = c.get('user');

  const result = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (result.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const u = result[0];
  return c.json({
    data: {
      id: u.id,
      phone: u.phone,
      name: u.name,
      role: u.role,
      district: u.district,
      xp: u.xp,
      level: u.level,
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

  const updated = await db.update(users)
    .set(parsed.data)
    .where(eq(users.id, userId))
    .returning();

  if (updated.length === 0) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'User not found' } }, 404);
  }

  const u = updated[0];
  return c.json({
    data: {
      id: u.id,
      phone: u.phone,
      name: u.name,
      role: u.role,
      district: u.district,
      xp: u.xp,
      level: u.level,
      createdAt: u.createdAt.toISOString(),
    },
  });
});

export default usersRouter;
