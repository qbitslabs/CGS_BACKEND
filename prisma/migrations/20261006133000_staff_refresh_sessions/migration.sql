-- Staff refresh sessions. Access tokens stay short-lived; this row is the revocable session.
CREATE TABLE "staff_refresh_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "clinic_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "replaced_by_id" UUID,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "staff_refresh_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "staff_refresh_sessions_token_hash_key" ON "staff_refresh_sessions"("token_hash");
CREATE INDEX "staff_refresh_sessions_user_id_revoked_at_idx" ON "staff_refresh_sessions"("user_id", "revoked_at");
CREATE INDEX "staff_refresh_sessions_expires_at_idx" ON "staff_refresh_sessions"("expires_at");

ALTER TABLE "staff_refresh_sessions" ADD CONSTRAINT "staff_refresh_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_refresh_sessions" ADD CONSTRAINT "staff_refresh_sessions_clinic_id_fkey" FOREIGN KEY ("clinic_id") REFERENCES "clinics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
