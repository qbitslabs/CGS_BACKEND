/* CGS auth module — Prisma queries.
 * Clinic API layer for auth; talks Prisma or callers, not the AI database. */
import { prisma } from '../../config/db.js';

export class AuthRepository {
  async findByEmail(email: string) {
    return prisma.user.findFirst({
      where: { email: email.toLowerCase() },
      include: {
        clinic: true,
        doctor: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findAllByEmail(email: string) {
    return prisma.user.findMany({
      where: { email: email.toLowerCase() },
      include: {
        clinic: true,
        doctor: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      include: {
        clinic: true,
        doctor: true,
      },
    });
  }

  async updateLastLogin(id: string) {
    return prisma.user.update({
      where: { id },
      data: { lastLoginAt: new Date() },
    });
  }
}

export const authRepository = new AuthRepository();
