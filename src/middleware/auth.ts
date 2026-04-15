import { createMiddleware } from 'hono/factory';
import jwt from 'jsonwebtoken';

export interface JwtPayload {
  userId: string;
  role: 'customer' | 'contractor';
}

// Adds user to context if valid JWT present
export const authMiddleware = createMiddleware<{
  Variables: { user: JwtPayload };
}>(async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing token' } }, 401);
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
    c.set('user', payload);
    await next();
  } catch {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }, 401);
  }
});

// Role guard
export function requireRole(role: 'customer' | 'contractor') {
  return createMiddleware<{ Variables: { user: JwtPayload } }>(async (c, next) => {
    const user = c.get('user');
    if (user.role !== role) {
      return c.json({ error: { code: 'FORBIDDEN', message: `Requires ${role} role` } }, 403);
    }
    await next();
  });
}
