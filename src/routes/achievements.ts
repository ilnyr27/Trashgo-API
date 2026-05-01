import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { userAchievements } from '../db/schema.js';
import { authMiddleware, type JwtPayload } from '../middleware/auth.js';
import { ACHIEVEMENT_DEFS } from '../lib/achievements.js';

const achievementsRouter = new Hono<{ Variables: { user: JwtPayload } }>();
achievementsRouter.use('*', authMiddleware);

// GET /achievements/my — return user's unlocked achievements merged with all defs
achievementsRouter.get('/my', async (c) => {
  const { userId } = c.get('user');

  const unlocked = await db.select()
    .from(userAchievements)
    .where(eq(userAchievements.userId, userId));

  const unlockedIds = new Set(unlocked.map(u => u.achievementId));

  const result = ACHIEVEMENT_DEFS.map(def => ({
    id: def.id,
    title: def.title,
    description: def.description,
    icon: def.icon,
    xp: def.xp,
    unlocked: unlockedIds.has(def.id),
    unlockedAt: unlocked.find(u => u.achievementId === def.id)?.unlockedAt?.toISOString() ?? null,
  }));

  return c.json({ data: result });
});

export default achievementsRouter;
