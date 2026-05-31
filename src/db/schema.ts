import { pgTable, uuid, varchar, text, integer, boolean, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';

// Enums
export const userRoleEnum = pgEnum('user_role', ['customer', 'contractor']);
export const orderStatusEnum = pgEnum('order_status', [
  'new', 'accepted', 'en_route', 'in_progress', 'pending_confirmation', 'pending_payment', 'completed', 'cancelled',
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
  notifTelegram: boolean('notif_telegram').notNull().default(true),
  telegramChatId: varchar('telegram_chat_id', { length: 30 }),
  email: varchar('email', { length: 200 }).unique(),
  inn: varchar('inn', { length: 12 }),
  innVerified: boolean('inn_verified').notNull().default(false),
  fcmToken: varchar('fcm_token', { length: 300 }),
  sbpBank: varchar('sbp_bank', { length: 100 }),
  frozen: boolean('frozen').notNull().default(false),
  freezeReason: varchar('freeze_reason', { length: 500 }),
  isAvailable: boolean('is_available').notNull().default(true),
  isVerified: boolean('is_verified').notNull().default(false),
  cancelCount: integer('cancel_count').notNull().default(0),
  deletedAt: timestamp('deleted_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// OTP codes
export const otpCodes = pgTable('otp_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: varchar('phone', { length: 200 }).notNull(),
  code: varchar('code', { length: 6 }).notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  used: integer('used').notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Subscriptions (recurring pickup schedules) — declared before orders so orders can reference it
export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').notNull().references(() => users.id),
  contractorId: uuid('contractor_id').references(() => users.id),
  address: text('address').notNull(),
  district: varchar('district', { length: 100 }).notNull().default(''),
  days: text('days').notNull().default('[]'),  // JSON array of weekday numbers [1..7], 1=Mon
  time: varchar('time', { length: 8 }).notNull().default('18:00'),
  volume: integer('volume').notNull().default(1),
  price: integer('price').notNull(),
  description: text('description').notNull().default(''),
  active: boolean('active').notNull().default(true),
  interval: varchar('interval', { length: 20 }).notNull().default('weekly'),  // 'weekly' | 'biweekly' | 'monthly'
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('idx_subscriptions_customer').on(table.customerId),
]);

// Orders
export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').notNull().references(() => users.id),
  contractorId: uuid('contractor_id').references(() => users.id),
  subscriptionId: uuid('subscription_id').references(() => subscriptions.id),
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
  wasteType: varchar('waste_type', { length: 50 }).notNull().default('household'),
  ratingByCustomer: integer('rating_by_customer'),
  reviewByCustomer: text('review_by_customer'),
  ratingByContractor: integer('rating_by_contractor'),
  etaMinutes: integer('eta_minutes'),
  enRouteAt: timestamp('en_route_at'),
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
  text: text('text').notNull().default(''),
  photoUrl: text('photo_url'),
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

// Support messages (user → admin chat)
export const supportMessages = pgTable('support_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  message: text('message').notNull(),
  reply: text('reply'),
  repliedAt: timestamp('replied_at'),
  status: varchar('status', { length: 20 }).notNull().default('open'), // open | closed
  readAt: timestamp('read_at'),
  category: varchar('category', { length: 50 }),
  isBotReply: boolean('is_bot_reply').notNull().default(false),
  escalated: boolean('escalated').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('idx_support_user').on(table.userId, table.createdAt),
]);

// Blocked addresses (non-payment fraud prevention)
export const blockedAddresses = pgTable('blocked_addresses', {
  id: uuid('id').primaryKey().defaultRandom(),
  address: text('address').notNull(),
  customerId: uuid('customer_id').notNull().references(() => users.id),
  contractorId: uuid('contractor_id').notNull().references(() => users.id),
  orderId: uuid('order_id').references(() => orders.id),
  reason: text('reason').notNull().default(''),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('idx_blocked_addresses_customer').on(table.customerId),
]);

// Refresh tokens
export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  token: varchar('token', { length: 255 }).unique().notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Rate limit buckets (persistent across restarts, auto-cleaned by cron)
export const rateLimits = pgTable('rate_limits', {
  key: varchar('key', { length: 200 }).primaryKey(),
  count: integer('count').notNull().default(1),
  resetAt: timestamp('reset_at').notNull(),
}, (table) => [
  index('idx_rate_limits_reset').on(table.resetAt),
]);

// Access plans (monthly 50₽ service subscription — distinct from recurring pickup schedules)
export const accessPlans = pgTable('access_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  status: varchar('status', { length: 20 }).notNull().default('pending'), // pending | active | expired
  priceAtPurchase: integer('price_at_purchase').notNull().default(50),
  paymentRef: varchar('payment_ref', { length: 200 }),
  promoCode: varchar('promo_code', { length: 50 }),
  discountApplied: integer('discount_applied').notNull().default(0),
  startsAt: timestamp('starts_at'),
  expiresAt: timestamp('expires_at'),
  confirmedAt: timestamp('confirmed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('idx_access_plans_user').on(table.userId),
]);

export const promoCodes = pgTable('promo_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: varchar('code', { length: 50 }).notNull().unique(),
  discountAmount: integer('discount_amount').notNull().default(0),
  maxUses: integer('max_uses').notNull().default(0),
  usedCount: integer('used_count').notNull().default(0),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('idx_promo_codes_code').on(table.code),
]);
