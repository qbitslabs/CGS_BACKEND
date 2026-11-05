-- Brochure plan limits, Early Bird, add-ons, and the monthly AI reply counter.
-- Additive only. Does not change price_monthly or existing clinic rows.

DO $$ BEGIN
  CREATE TYPE "PlanModelLevel" AS ENUM ('NORMAL', 'HIGH_END');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PlanMemory" AS ENUM ('NONE', 'FULL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PlanReporting" AS ENUM ('BASIC', 'ADVANCED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ClinicAddonType" AS ENUM (
    'EXTRA_DOCTOR',
    'EXTRA_STAFF',
    'EXTRA_AI_REPLIES',
    'EXTRA_WHATSAPP_NUMBER',
    'PRIORITY_SUPPORT',
    'EXTRA_AUTOMATION'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ClinicAddonBilling" AS ENUM ('MONTHLY', 'ONE_TIME');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ClinicAddonStatus" AS ENUM ('PENDING', 'ACTIVE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "doctors_included" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "staff_included" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "whatsapp_numbers_included" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "ai_replies_monthly" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "model_level" "PlanModelLevel" NOT NULL DEFAULT 'NORMAL';
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "conversation_memory" "PlanMemory" NOT NULL DEFAULT 'NONE';
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "reporting_level" "PlanReporting" NOT NULL DEFAULT 'BASIC';
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "custom_ai_included" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "outbound_included" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "priority_support_included" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "regular_monthly_price" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "early_bird_monthly_price" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "regular_setup_fee" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "early_bird_setup_fee" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "subscription_plans" ADD COLUMN IF NOT EXISTS "automation_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "cgs_subscriptions" ADD COLUMN IF NOT EXISTS "early_bird" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "cgs_subscriptions_early_bird_idx" ON "cgs_subscriptions"("early_bird");

CREATE TABLE IF NOT EXISTS "clinic_addons" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clinic_id" UUID NOT NULL,
  "subscription_id" UUID,
  "type" "ClinicAddonType" NOT NULL,
  "price" DECIMAL(12,2) NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "billing" "ClinicAddonBilling" NOT NULL,
  "status" "ClinicAddonStatus" NOT NULL DEFAULT 'PENDING',
  "automation_key" TEXT,
  "period_start" TIMESTAMP(3),
  "period_end" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "clinic_addons_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "clinic_ai_reply_periods" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "clinic_id" UUID NOT NULL,
  "period_start" TIMESTAMP(3) NOT NULL,
  "reply_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "clinic_ai_reply_periods_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "clinic_addons"
    ADD CONSTRAINT "clinic_addons_clinic_id_fkey"
    FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "clinic_addons"
    ADD CONSTRAINT "clinic_addons_subscription_id_fkey"
    FOREIGN KEY ("subscription_id") REFERENCES "cgs_subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "clinic_ai_reply_periods"
    ADD CONSTRAINT "clinic_ai_reply_periods_clinic_id_fkey"
    FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "clinic_addons_clinic_id_status_idx" ON "clinic_addons"("clinic_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "clinic_ai_reply_periods_clinic_id_period_start_key" ON "clinic_ai_reply_periods"("clinic_id", "period_start");
