/* CGS patients module — Prisma queries.
 * Clinic API layer for patients; talks Prisma or callers, not the AI database. */
import { prisma } from '../../config/db.js';
import { CreatePatientDTO, PatientListQuery, UpdatePatientDTO } from './patient.types.js';

export class PatientRepository {
  async count(query: PatientListQuery) {
    const where = this.buildWhere(query);
    return prisma.patient.count({ where });
  }

  async findMany(query: PatientListQuery) {
    const where = this.buildWhere(query);
    const page = query.page || 1;
    const limit = query.limit || 20;

    return prisma.patient.findMany({
      where,
      include: {
        appointments: { orderBy: { startsAt: 'desc' }, take: 1 },
        activities: { orderBy: { createdAt: 'desc' }, take: 5 },
      },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string, clinicId: string) {
    return prisma.patient.findFirst({
      where: { id, clinicId },
      include: {
        appointments: { include: { doctor: { include: { user: true } } }, orderBy: { startsAt: 'desc' } },
        conversations: { orderBy: { createdAt: 'desc' } },
        invoices: { include: { items: true, payments: true }, orderBy: { createdAt: 'desc' } },
        activities: { orderBy: { createdAt: 'desc' } },
      },
    });
  }

  async createWithActivity(clinicId: string, data: CreatePatientDTO, actorName: string) {
    return prisma.$transaction(async (tx) => {
      const created = await tx.patient.create({
        data: {
          clinicId,
          name: data.name,
          phone: data.phone,
          email: data.email || null,
          gender: data.gender,
          age: data.age,
          dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
          bloodGroup: data.bloodGroup,
          address: data.address,
          allergies: data.allergies || [],
          medicalHistoryNotes: data.medicalHistoryNotes,
          status: data.status,
        },
      });

      await tx.patientActivity.create({
        data: {
          patientId: created.id,
          type: 'profile_update',
          title: 'Patient Profile Created',
          description: 'Registered directly by clinic staff',
          actor: actorName,
        },
      });

      return created;
    });
  }

  async update(id: string, data: UpdatePatientDTO) {
    return prisma.patient.update({
      where: { id },
      data: {
        ...data,
        email: data.email === '' ? null : data.email,
      },
    });
  }

  private buildWhere(query: PatientListQuery) {
    const where: any = { clinicId: query.clinicId };
    if (query.status && query.status !== 'All') {
      where.status = query.status.toUpperCase().replace(/\s+/g, '_');
    }
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search } },
        { email: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.doctorId) {
      where.appointments = { some: { doctorId: query.doctorId } };
    }
    return where;
  }
}

export const patientRepository = new PatientRepository();
