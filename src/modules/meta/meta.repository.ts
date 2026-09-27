/* CGS meta module — Prisma queries.
 * Clinic API layer for meta; talks Prisma or callers, not the AI database. */
import { prisma } from '../../config/db.js';

export class MetaRepository {
  async getCampaigns(clinicId: string) {
    return prisma.metaCampaign.findMany({
      where: { clinicId },
      include: { metrics: true },
    });
  }

  async getCreatives(clinicId: string) {
    return prisma.metaCreative.findMany({
      where: { clinicId },
      include: { metrics: true },
    });
  }
}

export const metaRepository = new MetaRepository();
