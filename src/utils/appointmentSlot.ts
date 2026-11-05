/* Serialize bookings for one doctor so two requests cannot take the same slot. */
import { Prisma } from '@prisma/client';
import { clinicTimeString } from './timezone.js';

type Tx = Prisma.TransactionClient;

export async function assertDoctorSlotAvailable(
  tx: Tx,
  params: {
    clinicId: string;
    doctorId: string;
    startsAt: Date;
    endsAt: Date;
    excludeAppointmentId?: string;
    samePatientId?: string;
  }
) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM doctors
    WHERE id = CAST(${params.doctorId} AS uuid)
      AND clinic_id = CAST(${params.clinicId} AS uuid)
    FOR UPDATE
  `;

  if (!locked.length) {
    throw new Error('DOCTOR_NOT_IN_CLINIC');
  }

  if (params.samePatientId) {
    const own = await tx.appointment.findFirst({
      where: {
        clinicId: params.clinicId,
        patientId: params.samePatientId,
        doctorId: params.doctorId,
        startsAt: params.startsAt,
        status: { notIn: ['CANCELLED', 'NO_SHOW'] },
      },
    });
    if (own) return own;
  }

  const doctor = await tx.doctor.findFirst({
    where: { id: params.doctorId, clinicId: params.clinicId },
    select: { maxBookingsPerSlot: true },
  });
  const capacity = Math.min(20, Math.max(1, doctor?.maxBookingsPerSlot || 1));
  const taken = await tx.appointment.count({
    where: {
      clinicId: params.clinicId,
      doctorId: params.doctorId,
      startsAt: params.startsAt,
      ...(params.excludeAppointmentId ? { id: { not: params.excludeAppointmentId } } : {}),
      status: { notIn: ['CANCELLED', 'NO_SHOW'] },
    },
  });

  if (taken >= capacity) {
    throw new Error('SLOT_ALREADY_BOOKED');
  }

  const overlapping = await tx.appointment.findFirst({
    where: {
      clinicId: params.clinicId,
      doctorId: params.doctorId,
      ...(params.excludeAppointmentId ? { id: { not: params.excludeAppointmentId } } : {}),
      status: { notIn: ['CANCELLED', 'NO_SHOW'] },
      startsAt: { lt: params.endsAt, not: params.startsAt },
      endsAt: { gt: params.startsAt },
    },
    select: { id: true },
  });
  if (overlapping) {
    throw new Error('SLOT_ALREADY_BOOKED');
  }
}

/** A different start time that still covers this window. Same start is a capacity check. */
export function overlapsDifferentStart(
  startsAt: Date,
  endsAt: Date,
  existing: { startsAt: Date; endsAt: Date }
): boolean {
  if (existing.startsAt.getTime() === startsAt.getTime()) return false;
  return existing.startsAt < endsAt && existing.endsAt > startsAt;
}

export function minutesFromSlotLabel(label: string): number | null {
  const match = label.trim().match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return null;
  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const period = match[3].toUpperCase();
  if (period === 'PM' && hours < 12) hours += 12;
  if (period === 'AM' && hours === 12) hours = 0;
  return hours * 60 + minutes;
}

/** Drop slots that overlap a booking with a different start. Same-start rows stay under capacity. */
export function filterSlotsForBookings(input: {
  slots: string[];
  slotMinutes: number;
  capacity: number;
  booked: { startsAt: Date; endsAt: Date }[];
  timeZone: string;
}): string[] {
  const ranges = input.booked
    .map((row) => ({
      start: minutesFromSlotLabel(clinicTimeString(new Date(row.startsAt), input.timeZone)),
      end: minutesFromSlotLabel(clinicTimeString(new Date(row.endsAt), input.timeZone)),
    }))
    .filter((row): row is { start: number; end: number } => row.start != null && row.end != null && row.end > row.start);

  return input.slots.filter((slot) => {
    const start = minutesFromSlotLabel(slot);
    if (start == null) return false;
    const end = start + input.slotMinutes;
    const sameStart = ranges.filter((row) => row.start === start).length;
    if (sameStart >= input.capacity) return false;
    return !ranges.some((row) => row.start !== start && row.start < end && row.end > start);
  });
}

export function isSlotConflictError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const message = String((err as { message?: string } | null)?.message || '');
  return code === 'P2002' || message === 'SLOT_ALREADY_BOOKED' || message.includes('appointments_one_active_slot');
}
