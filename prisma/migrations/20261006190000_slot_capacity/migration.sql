-- A 30-minute slot may hold more than one appointment. Capacity lives on the doctor.
DROP INDEX IF EXISTS appointments_one_active_slot;

ALTER TABLE doctors
ADD COLUMN IF NOT EXISTS max_bookings_per_slot INTEGER NOT NULL DEFAULT 1;
