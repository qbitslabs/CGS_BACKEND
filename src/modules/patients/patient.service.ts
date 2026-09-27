/* CGS patients module — business logic.
 * Clinic API layer for patients; talks Prisma or callers, not the AI database. */
import { patientRepository, PatientRepository } from './patient.repository.js';
import { CreatePatientDTO, PatientListQuery, UpdatePatientDTO } from './patient.types.js';
import { AppError } from '../../middleware/errorHandler.js';
import { logAuditEvent } from '../../middleware/audit.js';

export class PatientService {
  constructor(private readonly repo: PatientRepository = patientRepository) {}

  private mapPatientToDTO(p: any) {
    return {
      id: p.id,
      name: p.name,
      phone: p.phone,
      email: p.email || '',
      gender: p.gender === 'MALE' ? 'Male' : p.gender === 'FEMALE' ? 'Female' : p.gender === 'OTHER' ? 'Other' : null,
      age: p.age ?? null,
      dateOfBirth: p.dateOfBirth ? p.dateOfBirth.toISOString().split('T')[0] : undefined,
      bloodGroup: p.bloodGroup || undefined,
      address: p.address || undefined,
      medicalHistoryNotes: p.medicalHistoryNotes || '',
      status: p.status === 'ACTIVE' ? 'Active' : p.status === 'INACTIVE' ? 'Inactive' : 'Pending Followup',
      lastAppointment: p.appointments?.[0]?.startsAt ? p.appointments[0].startsAt.toISOString().split('T')[0] : undefined,
      lastActivity: p.updatedAt ? p.updatedAt.toISOString() : new Date().toISOString(),
      createdDate: p.createdAt ? p.createdAt.toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
      allergies: p.allergies || [],
      activities: (p.activities || []).map((a: any) => ({
        id: a.id,
        type: a.type,
        title: a.title,
        description: a.description,
        timestamp: a.createdAt ? a.createdAt.toISOString() : new Date().toISOString(),
        actor: a.actor,
      })),
      appointments: (p.appointments || []).map((apt: any) => ({
        id: apt.id,
        date: apt.startsAt ? apt.startsAt.toISOString().split('T')[0] : '',
        time: apt.startsAt ? apt.startsAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : '',
        doctorName: apt.doctor?.user ? `${apt.doctor.user.firstName} ${apt.doctor.user.lastName || ''}`.trim() : 'Doctor',
        service: apt.service || 'Consultation',
        status: apt.status ? apt.status.charAt(0) + apt.status.slice(1).toLowerCase().replace(/_/g, ' ') : 'Scheduled',
      })),
      invoices: (p.invoices || []).map((inv: any) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        date: inv.issuedAt ? inv.issuedAt.toISOString().split('T')[0] : inv.createdAt.toISOString().split('T')[0],
        total: Number(inv.total),
        paidAmount: Number(inv.paidAmount),
        status: inv.status,
      })),
      conversations: (p.conversations || []).map((c: any) => ({
        id: c.id,
        state: c.state
          ? c.state.charAt(0) + c.state.slice(1).toLowerCase().replace(/_/g, ' ')
          : 'AI Active',
        lastMessage: c.lastMessageText || '',
        lastMessageTime: c.lastMessageAt
          ? c.lastMessageAt.toISOString()
          : c.lastActivityAt
          ? c.lastActivityAt.toISOString()
          : '',
        participantName: c.participantName,
        participantPhone: c.participantPhone,
      })),
    };
  }

  async listPatients(query: PatientListQuery) {
    const [total, patients] = await Promise.all([
      this.repo.count(query),
      this.repo.findMany(query),
    ]);

    const page = query.page || 1;
    const limit = query.limit || 20;

    return {
      data: patients.map((p) => this.mapPatientToDTO(p)),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getPatientById(id: string, clinicId: string) {
    const patient = await this.repo.findById(id, clinicId);
    if (!patient) {
      throw new AppError('Patient not found.', 404, 'NOT_FOUND');
    }
    return this.mapPatientToDTO(patient);
  }

  async createPatient(
    clinicId: string,
    dto: CreatePatientDTO,
    auditContext: {
      userId?: string;
      email?: string;
      actorName?: string;
      ip?: string;
      userAgent?: string;
      requestId?: string;
    }
  ) {
    const patient = await this.repo.createWithActivity(clinicId, dto, auditContext.actorName || 'Staff');

    await logAuditEvent({
      clinicId,
      userId: auditContext.userId,
      actorId: auditContext.userId || 'SYSTEM',
      actorEmail: auditContext.email || 'system',
      action: 'PATIENT_CREATED',
      resourceType: 'PATIENT',
      resourceId: patient.id,
      metadata: { name: patient.name, phone: patient.phone },
      ipAddress: auditContext.ip,
      userAgent: auditContext.userAgent,
      requestId: auditContext.requestId,
    });

    const fullPatient = await this.repo.findById(patient.id, clinicId);
    return fullPatient ? this.mapPatientToDTO(fullPatient) : patient;
  }

  async updatePatient(id: string, clinicId: string, dto: UpdatePatientDTO) {
    const patient = await this.repo.findById(id, clinicId);
    if (!patient) {
      throw new AppError('Patient not found.', 404, 'NOT_FOUND');
    }
    await this.repo.update(id, dto);
    const updated = await this.repo.findById(id, clinicId);
    return updated ? this.mapPatientToDTO(updated) : null;
  }
}

export const patientService = new PatientService();
