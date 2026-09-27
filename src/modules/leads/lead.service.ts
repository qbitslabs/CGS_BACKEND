/* CGS leads module — business logic.
 * Clinic API layer for leads; talks Prisma or callers, not the AI database. */
import { leadRepository, LeadRepository } from './lead.repository.js';
import { patientRepository } from '../patients/patient.repository.js';
import { CreateLeadDTO, LeadListQuery, UpdateLeadDTO } from './lead.types.js';
import { AppError } from '../../middleware/errorHandler.js';
import { logAuditEvent } from '../../middleware/audit.js';
import { prisma } from '../../config/db.js';

export class LeadService {
  constructor(private readonly repo: LeadRepository = leadRepository) {}

  private mapLeadToDTO(l: any) {
    return {
      id: l.id,
      name: l.name,
      phone: l.phone,
      email: l.email || undefined,
      source: l.source ? l.source.charAt(0) + l.source.slice(1).toLowerCase().replace('_', ' ') : 'WhatsApp',
      status:
        l.status === 'CONVERTED'
          ? 'Booked'
          : l.status
          ? l.status.charAt(0) + l.status.slice(1).toLowerCase().replace(/_/g, ' ')
          : 'New',
      score: l.score ?? 50,
      interestedService: l.interestedService || 'General Consultation',
      preferredDoctor: l.preferredDoctor || undefined,
      howHeardAboutDoctor: l.howHeardAboutDoctor || undefined,
      intent: l.intent ? l.intent.charAt(0) + l.intent.slice(1).toLowerCase() : 'Medium',
      notes: l.notes || '',
      createdDate: l.createdAt ? l.createdAt.toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
      lastActivity: l.updatedAt ? l.updatedAt.toISOString() : new Date().toISOString(),
      linkedConversationId: l.conversations?.[0]?.id,
      linkedAppointmentId: l.linkedAppointmentId || l.appointments?.[0]?.id,
      convertedPatientId: l.convertedPatientId || undefined,
      activities: (l.activities || []).map((a: any) => ({
        id: a.id,
        type: a.type,
        title: a.title,
        description: a.description,
        timestamp: a.createdAt ? a.createdAt.toISOString() : new Date().toISOString(),
        actor: a.actor,
      })),
    };
  }

  private async attachLatestAppointments(leads: any[], clinicId: string) {
    const patientIds = leads.map((l) => l.convertedPatientId).filter(Boolean);
    if (patientIds.length === 0) return leads;

    const appointments = await prisma.appointment.findMany({
      where: { clinicId, patientId: { in: patientIds } },
      orderBy: { startsAt: 'desc' },
      select: { id: true, patientId: true },
    });

    const latestByPatient = new Map<string, string>();
    for (const apt of appointments) {
      if (!latestByPatient.has(apt.patientId)) {
        latestByPatient.set(apt.patientId, apt.id);
      }
    }

    return leads.map((l) => ({
      ...l,
      linkedAppointmentId: l.convertedPatientId ? latestByPatient.get(l.convertedPatientId) : undefined,
    }));
  }

  async listLeads(query: LeadListQuery) {
    const [total, leads] = await Promise.all([
      this.repo.count(query),
      this.repo.findMany(query),
    ]);

    const page = query.page || 1;
    const limit = query.limit || 20;
    const withAppointments = await this.attachLatestAppointments(leads, query.clinicId);

    return {
      data: withAppointments.map((l) => this.mapLeadToDTO(l)),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getLeadById(id: string, clinicId: string) {
    const lead = await this.repo.findById(id, clinicId);
    if (!lead) {
      throw new AppError('Lead not found.', 404, 'NOT_FOUND');
    }
    const [withAppointment] = await this.attachLatestAppointments([lead], clinicId);
    return this.mapLeadToDTO(withAppointment);
  }

  async createLead(
    clinicId: string,
    dto: CreateLeadDTO,
    auditContext: {
      userId?: string;
      email?: string;
      actorName?: string;
      ip?: string;
      userAgent?: string;
      requestId?: string;
    }
  ) {
    const lead = await this.repo.createWithActivity(clinicId, dto, auditContext.actorName || 'System');

    await logAuditEvent({
      clinicId,
      userId: auditContext.userId,
      actorId: auditContext.userId || 'SYSTEM',
      actorEmail: auditContext.email || 'system',
      action: 'LEAD_CREATED',
      resourceType: 'LEAD',
      resourceId: lead.id,
      metadata: { name: lead.name, phone: lead.phone },
      ipAddress: auditContext.ip,
      userAgent: auditContext.userAgent,
      requestId: auditContext.requestId,
    });

    return this.mapLeadToDTO(lead);
  }

  async convertLeadToPatient(
    id: string,
    clinicId: string,
    auditContext: {
      userId?: string;
      email?: string;
      actorName?: string;
      ip?: string;
      userAgent?: string;
      requestId?: string;
    }
  ) {
    const lead = await this.repo.findById(id, clinicId);
    if (!lead) {
      throw new AppError('Lead not found in your clinic.', 404, 'NOT_FOUND');
    }

    if (lead.status === 'CONVERTED' && lead.convertedPatientId) {
      const existingPatient = await patientRepository.findById(lead.convertedPatientId, clinicId);
      return {
        lead: this.mapLeadToDTO(lead),
        patient: existingPatient || { id: lead.convertedPatientId, name: lead.name, phone: lead.phone },
        patientId: lead.convertedPatientId,
      };
    }

    const patient = await this.repo.convertToPatientInTx({
      clinicId,
      leadId: lead.id,
      leadName: lead.name,
      leadPhone: lead.phone,
      leadEmail: lead.email,
      leadNotes: lead.notes,
      actorName: auditContext.actorName || 'System',
      hasConversations: (lead.conversations || []).length > 0,
    });

    await logAuditEvent({
      clinicId,
      userId: auditContext.userId,
      actorId: auditContext.userId || 'SYSTEM',
      actorEmail: auditContext.email || 'system',
      action: 'LEAD_CONVERTED',
      resourceType: 'LEAD',
      resourceId: lead.id,
      metadata: { patientId: patient.id },
      ipAddress: auditContext.ip,
      userAgent: auditContext.userAgent,
      requestId: auditContext.requestId,
    });

    const updatedLead = await this.repo.findById(id, clinicId);
    return {
      lead: updatedLead ? this.mapLeadToDTO(updatedLead) : this.mapLeadToDTO(lead),
      patientId: patient.id,
      patient,
    };
  }

  async updateLead(id: string, clinicId: string, dto: UpdateLeadDTO) {
    const lead = await this.repo.findById(id, clinicId);
    if (!lead) {
      throw new AppError('Lead not found.', 404, 'NOT_FOUND');
    }
    const updated = await this.repo.update(id, dto);
    const refreshed = await this.repo.findById(id, clinicId);
    return refreshed ? this.mapLeadToDTO(refreshed) : this.mapLeadToDTO(updated);
  }

  async deleteLead(id: string, clinicId: string) {
    const lead = await this.repo.findById(id, clinicId);
    if (!lead) {
      throw new AppError('Lead not found.', 404, 'NOT_FOUND');
    }
    await this.repo.delete(id, clinicId);
    return { id, deleted: true };
  }
}

export const leadService = new LeadService();
