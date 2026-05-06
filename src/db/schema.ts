import { pgTable, uuid, varchar, text, integer, boolean, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';

// Enums
export const userRoleEnum = pgEnum('user_role', ['customer', 'contractor']);
export const orderStatusEnum = pgEnum('order_status', [
  'new', 'accepted', 'in_progress', 'pending_confirmation', 'completed', 'cancelled',
]);

// Users
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: varchar('phone', { length: 20 }).unique().notNull(),
  name: varchar('name', { length: 100 }).notNull().default(''),
  role: userRoleEnum('role').notNull(),
  district: varchar('district', { length: 100 }).notNull().default(''),
  transportMode: varchar('transport_mode', { length: 50 }).notNull().default('car'),
  xp: integer('xp').notNull().default(0),
  level: integer('level').notNull().default(1),
  balance: integer('balance').notNull().default(0),
  passwordHash: varchar('password_hash', { length: 255 }),
  referralCode: varchar('referral_code', { length: 12 }).unique(),
  referredBy: uuid('referred_by'),
  addresses: text('addresses').notNull().default('[]'),
  notifPush: boolean('notif_push').notNull().default(true),
  notifEmail: boolean('notif_email').notNull().default(false),
  notifEmailAddress: varchar('notif_email_address', { length: 200 }),
  telegramChatId: varchar('telegram_chat_id', { length: 30 }),
  inn: varchar('inn', { length: 12 }),
  fcmToken: varchar('fcm_token', { length: 300 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// OTP codes
export const otpCodes = pgTable('otp_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: varchar('phone', { length: 20 }).notNull(),
  code: varchar('code', { length: 6 }).notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  used: integer('used').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Orders
export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').notNull().references(() => users.id),
  contractorId: uuid('contractor_id').references(() => users.id),
  address: text('address').notNull(),
  district: varchar('district', { length: 100 }).notNull(),
  status: orderStatusEnum('status').notNull().default('new'),
  volume: integer('volume').notNull(),
  price: integer('price').notNull(),
  description: text('description').notNull().default(''),
  photoUrls: text('photo_urls').notNull().default('[]'),
  completionPhotoUrls: text('completion_photo_urls').notNull().default('[]'),
  scheduledAt: timestamp('scheduled_at'),
  asap: boolean('asap').notNull().default(false),
  ratingByCustomer: integer('rating_by_customer'),
  ratingByContractor: integer('rating_by_contractor'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  index('idx_orders_district_status').on(table.district, table.status),
  index('idx_orders_customer').on(table.customerId, table.createdAt),
  index('idx_orders_contractor').on(table.contractorId, table.status),
]);

// Order history (audit log)
export const orderHistory = pgTable('order_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  status: orderStatusEnum('status').notNull(),
  note: text('note').notNull().default(''),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Chat messages
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').notNull().references(() => orders.id),
  senderId: uuid('sender_id').notNull().references(() => users.id),
  senderName: varchar('sender_name', { length: 100 }).notNull().default(''),
  text: text('text').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('idx_messages_order').on(table.orderId, table.createdAt),
]);

// Referrals
export const referrals = pgTable('referrals', {
  id: uuid('id').primaryKey().defaultRandom(),
  referrerId: uuid('referrer_id').notNull().references(() => users.id),
  refereeId: uuid('referee_id').notNull().references(() => users.id),
  bonus150Paid: boolean('bonus_150_paid').notNull().default(false),
  bonusExpiresAt: timestamp('bonus_expires_at'),
  bonusMonthlyUsed: integer('bonus_monthly_used').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// User achievements (unlocked)
export const userAchievements = pgTable('user_achievements', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  achievementId: varchar('achievement_id', { length: 50 }).notNull(),
  xpRewarded: integer('xp_rewarded').notNull().default(0),
  unlockedAt: timestamp('unlocked_at').notNull().defaultNow(),
}, (table) => [
  index('idx_user_achievements_user').on(table.userId),
]);

// Subscriptions (recurring pickup schedules)
export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').notNull().references(() => users.id),
  address: text('address').notNull(),
  district: varchar('district', { length: 100 }).notNull().default(''),
  days: text('days').notNull().default('[]'),  // JSON-serialized array of weekday numbers [1..7]
  time: varchar('time', { length: 8 }).notNull().default('18:00'),
  price: integer('price').notNull(),
  description: text('description').notNull().default(''),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('idx_subscriptions_customer').on(table.customerId),
]);

// Refresh tokens
export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  token: varchar('token', { length: 255 }).unique().notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
