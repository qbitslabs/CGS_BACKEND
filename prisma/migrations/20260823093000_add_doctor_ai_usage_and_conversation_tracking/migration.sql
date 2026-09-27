-- AlterTable
ALTER TABLE "conversations" ADD COLUMN "doctor_id" UUID;

-- AlterTable
ALTER TABLE "ai_usage" ADD COLUMN "doctor_id" UUID;

-- CreateIndex
CREATE INDEX "conversations_clinic_id_doctor_id_last_activity_at_idx" ON "conversations"("clinic_id", "doctor_id", "last_activity_at");

-- CreateIndex
CREATE INDEX "ai_usage_clinic_id_doctor_id_created_at_idx" ON "ai_usage"("clinic_id", "doctor_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_usage_doctor_id_created_at_idx" ON "ai_usage"("doctor_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_usage_doctor_id_total_cost_idx" ON "ai_usage"("doctor_id", "total_cost");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
