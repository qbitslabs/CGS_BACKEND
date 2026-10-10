import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDoctorSlotAvailable, isSlotConflictError } from '../utils/appointmentSlot.js';
import { pickInboundConversation } from './internal/internal.repository.js';

const mocks = vi.hoisted(() => ({
  leadFind: vi.fn(),
  patientFind: vi.fn(),
  appointmentFind: vi.fn(),
  conversationFind: vi.fn(),
  invoiceFind: vi.fn(),
  whatsappFind: vi.fn(),
}));

vi.mock('../config/db.js', () => ({
  prisma: {
    lead: { findFirst: mocks.leadFind },
    patient: { findFirst: mocks.patientFind },
    appointment: { findFirst: mocks.appointmentFind },
    conversation: { findFirst: mocks.conversationFind },
    invoice: { findFirst: mocks.invoiceFind },
    whatsappAccount: { findUnique: mocks.whatsappFind },
  },
}));

vi.mock('../middleware/audit.js', () => ({ logAuditEvent: vi.fn() }));

import { leadRepository } from './leads/lead.repository.js';
import { patientRepository } from './patients/patient.repository.js';
import { appointmentRepository } from './appointments/appointment.repository.js';
import { conversationRepository } from './conversations/conversation.repository.js';
import { billingRepository } from './billing/billing.repository.js';
import { internalRepository } from './internal/internal.repository.js';
import { LeadService } from './leads/lead.service.js';
import { BillingService } from './billing/billing.service.js';

describe('tenant isolation', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    Object.values(mocks).forEach((fn) => fn.mockResolvedValue(null));
  });

  it('scopes clinic-owned reads to the authenticated clinic', async () => {
    await leadRepository.findById('lead-1', 'clinic-a');
    await patientRepository.findById('patient-1', 'clinic-a');
    await appointmentRepository.findById('appt-1', 'clinic-a');
    await conversationRepository.findById('conv-1', 'clinic-a');
    await billingRepository.findInvoiceById('inv-1', 'clinic-a');

    expect(mocks.leadFind).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'lead-1', clinicId: 'clinic-a' } }));
    expect(mocks.patientFind).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'patient-1', clinicId: 'clinic-a' } }));
    expect(mocks.appointmentFind).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'appt-1', clinicId: 'clinic-a' } }));
    expect(mocks.conversationFind).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'conv-1', clinicId: 'clinic-a' } }));
    expect(mocks.invoiceFind).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'inv-1', clinicId: 'clinic-a' } }));

    expect(JSON.stringify(mocks.leadFind.mock.calls)).not.toContain('clinic-b');
  });

  it('resolves WhatsApp traffic from the Meta phone number id, not a caller-supplied clinic', async () => {
    await internalRepository.getWhatsAppAccountByPhoneId('109955');
    expect(mocks.whatsappFind).toHaveBeenCalledWith(expect.objectContaining({ where: { phoneNumberId: '109955' } }));
  });
});

describe('lead conversion', () => {
  it('returns the existing patient when the lead is already converted', async () => {
    const repo = {
      findById: vi.fn(async (_id: string, clinicId: string) =>
        clinicId === 'clinic-a'
          ? {
              id: 'lead-1',
              name: 'Asha',
              phone: '919800000000',
              status: 'CONVERTED',
              convertedPatientId: 'patient-1',
              createdAt: new Date(),
              updatedAt: new Date(),
            }
          : null
      ),
      convertToPatientInTx: vi.fn(),
    };
    const service = new LeadService(repo as any);

    mocks.patientFind.mockResolvedValue({ id: 'patient-1', name: 'Asha', phone: '919800000000' });
    const result = await service.convertLeadToPatient('lead-1', 'clinic-a', { actorName: 'Staff' });
    expect(result.patientId).toBe('patient-1');
    expect(repo.convertToPatientInTx).not.toHaveBeenCalled();
    await expect(service.convertLeadToPatient('lead-1', 'clinic-b', {})).rejects.toMatchObject({ statusCode: 404 });
  });

  it('creates a patient for a new lead in the same clinic', async () => {
    const repo = {
      findById: vi
        .fn()
        .mockResolvedValueOnce({
          id: 'lead-2',
          name: 'Ravi',
          phone: '919800000001',
          email: null,
          notes: null,
          status: 'NEW',
          conversations: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .mockResolvedValueOnce({
          id: 'lead-2',
          name: 'Ravi',
          phone: '919800000001',
          status: 'CONVERTED',
          convertedPatientId: 'patient-2',
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      convertToPatientInTx: vi.fn(async () => ({ id: 'patient-2', name: 'Ravi' })),
    };
    const service = new LeadService(repo as any);
    const result = await service.convertLeadToPatient('lead-2', 'clinic-a', { actorName: 'Staff' });
    expect(repo.convertToPatientInTx).toHaveBeenCalledWith(expect.objectContaining({ clinicId: 'clinic-a', leadId: 'lead-2' }));
    expect(result.patientId).toBe('patient-2');
  });
});

describe('appointment slots', () => {
  it('rejects a booking once the slot is full', async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: 'doctor-1' }]),
      doctor: { findFirst: vi.fn(async () => ({ maxBookingsPerSlot: 1 })) },
      appointment: { count: vi.fn(async () => 1) },
    };
    await expect(
      assertDoctorSlotAvailable(tx as any, {
        clinicId: 'clinic-a',
        doctorId: 'doctor-1',
        startsAt: new Date('2026-10-06T09:00:00+05:30'),
        endsAt: new Date('2026-10-06T09:30:00+05:30'),
      })
    ).rejects.toThrow('SLOT_ALREADY_BOOKED');
    const sql = (tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join(' ');
    expect(sql).toContain('FOR UPDATE');
    expect(sql).toContain('clinic_id');
  });

  it('allows another appointment while the slot is under the doctor cap', async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: 'doctor-1' }]),
      doctor: { findFirst: vi.fn(async () => ({ maxBookingsPerSlot: 5 })) },
      appointment: { count: vi.fn(async () => 4) },
    };
    await expect(
      assertDoctorSlotAvailable(tx as any, {
        clinicId: 'clinic-a',
        doctorId: 'doctor-1',
        startsAt: new Date('2026-10-06T09:00:00+05:30'),
        endsAt: new Date('2026-10-06T09:30:00+05:30'),
      })
    ).resolves.toBeUndefined();
  });

  it('rejects a doctor that is not in the clinic', async () => {
    const tx = {
      $queryRaw: vi.fn(async () => []),
      doctor: { findFirst: vi.fn() },
      appointment: { count: vi.fn() },
    };
    await expect(
      assertDoctorSlotAvailable(tx as any, {
        clinicId: 'clinic-a',
        doctorId: 'doctor-from-clinic-b',
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 30 * 60 * 1000),
      })
    ).rejects.toThrow('DOCTOR_NOT_IN_CLINIC');
    expect(tx.appointment.count).not.toHaveBeenCalled();
  });

  it('treats a unique slot index violation as a failed booking', () => {
    expect(isSlotConflictError({ code: 'P2002', message: 'appointments_one_active_slot' })).toBe(true);
    expect(isSlotConflictError(new Error('SLOT_ALREADY_BOOKED'))).toBe(true);
    expect(isSlotConflictError(new Error('database down'))).toBe(false);
  });
});

describe('inbound conversation thread', () => {
  it('attaches a reply to the latest thread for that phone, not an older lead thread', () => {
    const olderLead = {
      id: 'lead-thread',
      lastActivityAt: new Date('2026-10-01T10:00:00Z'),
      lead: { source: 'WEBSITE' },
    };
    const billThread = {
      id: 'bill-thread',
      lastActivityAt: new Date('2026-10-06T10:00:00Z'),
      lead: null,
    };
    expect(pickInboundConversation([olderLead, billThread])?.id).toBe('bill-thread');
    expect(pickInboundConversation([billThread, olderLead])?.id).toBe('bill-thread');
  });
});

describe('invoice creation', () => {
  it('rejects another clinic patient and computes the total', async () => {
    const createInvoiceInTx = vi.fn(async (input) => ({ id: 'inv-1', invoiceNumber: 'INV-1', ...input }));
    const service = new BillingService({
      findDoctorInClinic: vi.fn(async () => null),
      createInvoiceInTx,
      findInvoiceById: vi.fn(async () => null),
    } as any);

    mocks.patientFind.mockResolvedValue(null);
    await expect(
      service.createInvoice('clinic-a', { patientId: 'patient-b', items: [{ name: 'Consult', quantity: 1, unitPrice: 500 }] } as any, {})
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    mocks.patientFind.mockResolvedValue({ id: 'patient-a', name: 'Asha' });
    await expect(
      service.createInvoice(
        'clinic-a',
        {
          patientId: 'patient-a',
          treatingDoctorId: 'doctor-b',
          items: [{ name: 'Consult', quantity: 2, unitPrice: 500 }],
        } as any,
        {}
      )
    ).rejects.toMatchObject({ code: 'DOCTOR_NOT_FOUND' });

    const billing = new BillingService({
      findDoctorInClinic: vi.fn(async () => ({ id: 'doctor-a' })),
      createInvoiceInTx,
      findInvoiceById: vi.fn(async () => null),
    } as any);
    await billing.createInvoice(
      'clinic-a',
      {
        patientId: 'patient-a',
        treatingDoctorId: 'doctor-a',
        items: [
          { name: 'Consult', quantity: 2, unitPrice: 500 },
          { name: 'Dressing', quantity: 1, unitPrice: 100 },
        ],
        discount: 100,
        taxPercent: 18,
      } as any,
      { userId: 'user-1' }
    );
    expect(createInvoiceInTx).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicId: 'clinic-a',
        subtotal: 1100,
        discount: 100,
        tax: 180,
        total: 1180,
      })
    );
  });
});
