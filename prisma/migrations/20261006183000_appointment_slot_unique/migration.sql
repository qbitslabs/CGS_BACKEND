-- Keep the earliest active booking when the same doctor and start time was saved more than once.
-- Later copies are cancelled so the unique slot index can be created.
UPDATE appointments AS a
SET status = 'CANCELLED',
    notes = CONCAT(COALESCE(a.notes, ''), ' [Cancelled duplicate slot; earliest booking kept]')
FROM (
  SELECT id
  FROM (
    SELECT id,
           row_number() OVER (
             PARTITION BY doctor_id, starts_at
             ORDER BY created_at ASC, id ASC
           ) AS rn
    FROM appointments
    WHERE doctor_id IS NOT NULL
      AND status NOT IN ('CANCELLED', 'NO_SHOW')
  ) ranked
  WHERE rn > 1
) dupes
WHERE a.id = dupes.id;

CREATE UNIQUE INDEX IF NOT EXISTS appointments_one_active_slot
ON appointments (doctor_id, starts_at)
WHERE doctor_id IS NOT NULL
  AND status NOT IN ('CANCELLED', 'NO_SHOW');
