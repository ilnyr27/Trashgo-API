import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { sendPushNotification } from './firebase-admin.js';
import { sendTelegramNotification } from './telegram.js';

// Fire-and-forget: send FCM push + Telegram to a user
export function notifyUser(userId: string, title: string, body: string, orderId?: string): void {
  db.select({ fcmToken: users.fcmToken, telegramChatId: users.telegramChatId, notifPush: users.notifPush })
    .from(users).where(eq(users.id, userId)).limit(1)
    .then(([u]) => {
      if (!u) return;
      if (u.notifPush && u.fcmToken) {
        sendPushNotification(u.fcmToken, title, body, orderId ? { orderId } : {})
          .then((ok) => {
            if (!ok) db.update(users).set({ fcmToken: null } as any).where(eq(users.id, userId)).catch(() => {});
          }).catch(() => {});
      }
      if (u.telegramChatId) {
        sendTelegramNotification(u.telegramChatId, title, body).catch(() => {});
      }
    }).catch(() => {});
}

// Notify a batch of users (e.g. all contractors in a district)
export function notifyUsers(userIds: string[], title: string, body: string, orderId?: string): void {
  for (const id of userIds) notifyUser(id, title, body, orderId);
}
