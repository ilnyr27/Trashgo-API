DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'order_status' AND e.enumlabel = 'pending_confirmation'
  ) THEN
    ALTER TYPE "public"."order_status" ADD VALUE 'pending_confirmation' BEFORE 'completed';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"sender_name" varchar(100) DEFAULT '' NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referrer_id" uuid NOT NULL,
	"referee_id" uuid NOT NULL,
	"bonus_150_paid" boolean DEFAULT false NOT NULL,
	"bonus_expires_at" timestamp,
	"bonus_monthly_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"address" text NOT NULL,
	"district" varchar(100) DEFAULT '' NOT NULL,
	"days" text DEFAULT '[]' NOT NULL,
	"time" varchar(8) DEFAULT '18:00' NOT NULL,
	"price" integer NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "user_achievements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"achievement_id" varchar(50) NOT NULL,
	"xp_rewarded" integer DEFAULT 0 NOT NULL,
	"unlocked_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "orders" ALTER COLUMN "scheduled_at" DROP NOT NULL;

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "photo_urls" text DEFAULT '[]' NOT NULL;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "completion_photo_urls" text DEFAULT '[]' NOT NULL;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "asap" boolean DEFAULT false NOT NULL;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "rating_by_customer" integer;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "rating_by_contractor" integer;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "transport_mode" varchar(50) DEFAULT 'car' NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "balance" integer DEFAULT 0 NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "referral_code" varchar(12);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "referred_by" uuid;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "addresses" text DEFAULT '[]' NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notif_push" boolean DEFAULT true NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notif_email" boolean DEFAULT false NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "notif_email_address" varchar(200);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "telegram_chat_id" varchar(30);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_order_id_orders_id_fk') THEN
    ALTER TABLE "messages" ADD CONSTRAINT "messages_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_sender_id_users_id_fk') THEN
    ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'referrals_referrer_id_users_id_fk') THEN
    ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_id_users_id_fk" FOREIGN KEY ("referrer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'referrals_referee_id_users_id_fk') THEN
    ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referee_id_users_id_fk" FOREIGN KEY ("referee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_customer_id_users_id_fk') THEN
    ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_achievements_user_id_users_id_fk') THEN
    ALTER TABLE "user_achievements" ADD CONSTRAINT "user_achievements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_messages_order" ON "messages" USING btree ("order_id","created_at");
CREATE INDEX IF NOT EXISTS "idx_subscriptions_customer" ON "subscriptions" USING btree ("customer_id");
CREATE INDEX IF NOT EXISTS "idx_user_achievements_user" ON "user_achievements" USING btree ("user_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_referral_code_unique') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_referral_code_unique" UNIQUE("referral_code");
  END IF;
END $$;
