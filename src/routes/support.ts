import { Hono } from 'hono';
import { eq, desc, sql, and, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { supportMessages, users } from '../db/schema.js';
import { authMiddleware, type JwtPayload } from '../middleware/auth.js';
import { sendTelegramNotification } from '../lib/telegram.js';
import { censor } from '../lib/censor.js';

const supportRouter = new Hono<{ Variables: { user: JwtPayload } }>();
supportRouter.use('*', authMiddleware);

// Rule-based bot reply generator
function generateBotReply(message: string, category: string | null): string {
  const lower = message.toLowerCase();

  if (category === 'order' || /заказ|исполнитель|не пришёл|не приехал|не забрал|отмен|принял|приехал|забрал|опоздал/.test(lower)) {
    return '📋 Отвечаю на вопросы о заказах:\n\n' +
      '• Отменить заказ — кнопка «Отменить» в деталях заказа, пока исполнитель не принял\n' +
      '• Исполнитель не приехал — заказ вернётся в очередь автоматически через 24 часа\n' +
      '• Исполнитель опаздывает — напишите ему в чат заказа\n' +
      '• Статус заказа — в разделе «Мои заказы»\n\n' +
      'Это ответило на ваш вопрос?';
  }

  if (category === 'payment' || /оплат|деньг|сбп|перевод|не заплатил|не перевёл|баланс|вывод|не пришли деньги|не получил деньг/.test(lower)) {
    return '💳 Отвечаю на вопросы об оплате:\n\n' +
      '• Как платить — через СБП напрямую исполнителю после подтверждения заказа\n' +
      '• Клиент не заплатил — откройте спор через кнопку в деталях заказа\n' +
      '• Баланс и история — в разделе «Выплаты» в профиле\n' +
      '• Комиссия платформы — 0%, все деньги идут исполнителю\n\n' +
      'Это помогло?';
  }

  if (category === 'tech' || /ошибк|не работает|вылетает|не загружается|баг|сломал|приложен|белый экран|чёрный экран/.test(lower)) {
    return '⚙️ По техническим вопросам:\n\n' +
      '• Попробуйте обновить страницу (потяните вниз или нажмите F5)\n' +
      '• Очистите кэш браузера (Настройки → Конфиденциальность → Очистить данные)\n' +
      '• Переустановите приложение, если добавляли на экран\n' +
      '• Проверьте подключение к интернету\n\n' +
      'Проблема решилась?';
  }

  if (/пароль|войти|вход|регистрация|телефон|код|смс|аккаунт|удали|профил|номер/.test(lower)) {
    return '👤 По вопросам аккаунта:\n\n' +
      '• Вход — по номеру телефона + одноразовый код из SMS или Telegram\n' +
      '• Нет кода — проверьте, привязан ли Telegram-бот (раздел «Уведомления»)\n' +
      '• Смена номера телефона — только через оператора поддержки\n' +
      '• Удаление аккаунта — обратитесь к оператору\n\n' +
      'Это ответило на ваш вопрос?';
  }

  if (/подписк|расписани|еженедельн|регулярн|автозаказ/.test(lower)) {
    return '🔄 По вопросам подписки:\n\n' +
      '• Подписка — автоматически создаёт заказы по расписанию (раздел «Подписки»)\n' +
      '• Управление — Мои заказы → Подписки\n' +
      '• Приостановить или отменить — кнопка в настройках подписки\n\n' +
      'Это помогло?';
  }

  // Default
  return '👋 Привет! Я — автоматический помощник TrashGo.\n\n' +
    'Посмотрите раздел «Частые вопросы» — там есть ответы на большинство вопросов о заказах, оплате и работе приложения.\n\n' +
    'Если не нашли нужного — нажмите «Нужен оператор» и живой сотрудник ответит в рабочее время (пн–пт 9:00–21:00).';
}

// POST /support — send a support message
supportRouter.post('/', async (c) => {
  const { userId } = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const message = censor(((body as any)?.message ?? '').toString().trim().slice(0, 2000));
  if (!message) return c.json({ error: { code: 'VALIDATION', message: 'Message required' } }, 400);
  const category = ((body as any)?.category ?? '').toString().trim().slice(0, 50) || null;

  const [[row], [sender]] = await Promise.all([
    db.insert(supportMessages).values({ userId, message, ...(category ? { category } : {}) }).returning(),
    db.select({ name: users.name, phone: users.phone }).from(users).where(eq(users.id, userId)).limit(1),
  ]);

  // Generate and save bot reply immediately
  const botReply = generateBotReply(message, category);
  await db.update(supportMessages)
    .set({ reply: botReply, repliedAt: new Date(), isBotReply: true } as any)
    .where(eq(supportMessages.id, row.id));

  return c.json({
    data: {
      id: row.id,
      message: row.message,
      createdAt: row.createdAt.toISOString(),
      status: row.status,
      reply: botReply,
      repliedAt: new Date().toISOString(),
      category: row.category ?? null,
      readAt: null,
      isBotReply: true,
      escalated: false,
    }
  }, 201);
});

// GET /support — get my support thread
supportRouter.get('/', async (c) => {
  const { userId } = c.get('user');

  const rows = await db.select().from(supportMessages)
    .where(eq(supportMessages.userId, userId))
    .orderBy(desc(supportMessages.createdAt))
    .limit(50);

  return c.json({
    data: rows.map(r => ({
      id: r.id,
      message: r.message,
      reply: r.reply,
      repliedAt: r.repliedAt?.toISOString() ?? null,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      category: r.category ?? null,
      readAt: r.readAt?.toISOString() ?? null,
      isBotReply: r.isBotReply,
      escalated: r.escalated,
    })),
  });
});

// PATCH /support/read-all — mark all replied messages as read by the user
supportRouter.patch('/read-all', async (c) => {
  const { userId } = c.get('user');
  await db.update(supportMessages)
    .set({ readAt: new Date() } as any)
    .where(sql`user_id = ${userId} AND reply IS NOT NULL AND read_at IS NULL`);
  return c.json({ data: { ok: true } });
});

// POST /support/:id/escalate — user requests a human operator
supportRouter.post('/:id/escalate', async (c) => {
  const { userId } = c.get('user');
  const id = c.req.param('id');

  const [row] = await db.update(supportMessages)
    .set({ escalated: true, status: 'open' } as any)
    .where(and(eq(supportMessages.id, id), eq(supportMessages.userId, userId)))
    .returning();

  if (!row) return c.json({ error: { code: 'NOT_FOUND', message: 'Message not found' } }, 404);

  // Notify admin via Telegram
  const adminChatId = process.env.ADMIN_TELEGRAM_CHAT_ID;
  if (adminChatId) {
    const [sender] = await db.select({ name: users.name, phone: users.phone })
      .from(users).where(eq(users.id, userId)).limit(1);
    const who = sender?.name || sender?.phone || userId.slice(-8);
    sendTelegramNotification(
      adminChatId,
      `🚨 Требуется оператор — ${who}`,
      `Бот не помог. Сообщение: "${row.message.slice(0, 200)}"`
    ).catch(() => {});
  }

  return c.json({ data: { ok: true } });
});

export default supportRouter;
