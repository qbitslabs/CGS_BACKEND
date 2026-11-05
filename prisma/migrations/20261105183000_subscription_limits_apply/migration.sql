-- Turns brochure limits on only when an admin applies the plan.
-- Existing subscriptions stay false, so current clinics keep working.
ALTER TABLE "cgs_subscriptions" ADD COLUMN IF NOT EXISTS "limits_apply" BOOLEAN NOT NULL DEFAULT false;
