/* Serialize bookings for one doctor so two requests cannot take the same slot. */
import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export async function assertDoctorSlotAvailable(
  tx: Tx,
  params: {
    clinicId: string;
    doctorId: string;
    startsAt: Date;
    endsAt: Date;
    excludeAppointmentId?: string;
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
}

export function isSlotConflictError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const message = String((err as { message?: string } | null)?.message || '');
  return code === 'P2002' || message === 'SLOT_ALREADY_BOOKED' || message.includes('appointments_one_active_slot');
}
