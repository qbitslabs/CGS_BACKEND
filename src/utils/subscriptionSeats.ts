/* CGS backend helper: subscriptionSeats.
 * Shared timezone, seats, or formatting used by services. */
import { prisma } from '../config/db.js';
import { AppError } from '../middleware/errorHandler.js';

const DEFAULT_MAX_USERS = Number(process.env.DEFAULT_MAX_USERS || 10);

export async function assertClinicSeatAvailable(clinicId: string, additionalSeats = 1): Promise<void> {
  const maxUsers = DEFAULT_MAX_USERS;
  const current = await prisma.user.count({
    where: { clinicId, status: 'ACTIVE' },
  });

  if (current + additionalSeats > maxUsers) {
    throw new AppError(
      `User seat limit reached (${current}/${maxUsers}). Upgrade the clinic subscription to add more staff.`,
      403,
      'SEAT_LIMIT_EXCEEDED'
    );
  }
}
