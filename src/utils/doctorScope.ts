/* Resolves whether a clinic user sees all records or only their own doctor slice.
 * Staff/employees always see every doctor. Only non-primary doctors are scoped. */
import { prisma } from '../config/db.js';

export type DoctorScope = {
  userId: string | null;
  doctorId: string | null;
  doctorName: string | null;
  isPrimary: boolean;
  seesAllClinicData: boolean;
  restrictToDoctorId: string | null;
};

export async function resolveDoctorScope(params: {
  clinicId: string;
  userId?: string;
  role?: string;
  requestedDoctorId?: string;
}): Promise<DoctorScope> {
  const role = String(params.role || '').toUpperCase();
  const requested =
    params.requestedDoctorId && params.requestedDoctorId !== 'All'
      ? params.requestedDoctorId
      : undefined;

  const [me, primary] = await Promise.all([
    params.userId
      ? prisma.doctor.findFirst({
          where: { clinicId: params.clinicId, userId: params.userId },
          include: { user: { select: { firstName: true, lastName: true } } },
        })
      : Promise.resolve(null),
    prisma.doctor.findFirst({
      where: { clinicId: params.clinicId, isPrimary: true },
      select: { id: true },
    }),
  ]);

  const doctorName = me
    ? `${me.user.firstName} ${me.user.lastName || ''}`.trim()
    : null;
  const isPrimary = !!me?.isPrimary;
  const isStaff = role !== 'DOCTOR';
  const seesAllClinicData = isStaff || !primary || isPrimary;
  const restrictToDoctorId = seesAllClinicData ? requested || null : me?.id || null;

  return {
    userId: params.userId || null,
    doctorId: me?.id || null,
    doctorName,
    isPrimary,
    seesAllClinicData,
    restrictToDoctorId,
  };
}

export function doctorOwnedInvoiceWhere(scope: DoctorScope) {
  if (!scope.restrictToDoctorId) return {};
  return {
    OR: [
      { treatingDoctorId: scope.restrictToDoctorId },
      ...(scope.userId ? [{ createdByUserId: scope.userId }] : []),
      { patient: { appointments: { some: { doctorId: scope.restrictToDoctorId } } } },
    ],
  };
}

export function doctorOwnedConversationWhere(scope: DoctorScope) {
  if (!scope.restrictToDoctorId) return {};
  return {
    OR: [
      { doctorId: scope.restrictToDoctorId },
      { patient: { appointments: { some: { doctorId: scope.restrictToDoctorId } } } },
    ],
  };
}

export function doctorOwnedLeadWhere(scope: DoctorScope) {
  if (!scope.restrictToDoctorId) return {};
  const parts: Record<string, unknown>[] = [
    { conversations: { some: { doctorId: scope.restrictToDoctorId } } },
  ];
  if (scope.userId) parts.push({ assignedToUserId: scope.userId });
  if (scope.doctorName) {
    parts.push({ preferredDoctor: { contains: scope.doctorName, mode: 'insensitive' } });
  }
  return { OR: parts };
}

export function doctorOwnedPatientWhere(scope: DoctorScope) {
  if (!scope.restrictToDoctorId) return {};
  return { appointments: { some: { doctorId: scope.restrictToDoctorId } } };
}
