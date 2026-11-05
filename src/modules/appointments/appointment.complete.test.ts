import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  patientFindFirst: vi.fn(),
  patientFindMany: vi.fn(),
  patientCreate: vi.fn(),
  leadFindFirst: vi.fn(),
  leadFindMany: vi.fn(),
  appointmentUpdateMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../../config/db.js', () => ({
  prisma: {
    patient: {
      findFirst: mocks.patientFindFirst,
      findMany: mocks.patientFindMany,
      create: mocks.patientCreate,
      update: vi.fn(),
    },
    lead: { findFirst: mocks.leadFindFirst, findMany: mocks.leadFindMany, update: vi.fn() },
    appointment: { updateMany: mocks.appointmentUpdateMany },
    leadActivity: { create: vi.fn() },
    patientActivity: { create: vi.fn() },
    conversation: { updateMany: vi.fn() },
    $transaction: mocks.transaction,
  },
}));

vi.mock('../../middleware/audit.js', () => ({ logAuditEvent: vi.fn() }));

import { AppointmentService } from './appointment.service.js';

const service = new AppointmentService({} as any);

function complete(patientId: string) {
  return (service as any).autoConvertLeadOnAppointmentDone(
    'clinic-a',
    patientId,
    'Consultation',
    'Staff',
    'apt-1'
  );
}

describe('appointment completion patient link', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((fn) => fn.mockReset());
    mocks.leadFindMany.mockResolvedValue([]);
    mocks.appointmentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.mockResolvedValue([]);
  });

  it('keeps the patient already on the appointment', async () => {
    mocks.patientFindFirst.mockResolvedValue({ id: 'patient-1', clinicId: 'clinic-a', phone: '919800000001', leadId: null });
    await expect(complete('patient-1')).resolves.toBe('patient-1');
    expect(mocks.patientFindFirst).toHaveBeenCalledWith({ where: { id: 'patient-1', clinicId: 'clinic-a' } });
    expect(mocks.patientCreate).not.toHaveBeenCalled();
  });

  it('reuses one patient with the same phone', async () => {
    mocks.patientFindFirst.mockResolvedValue(null);
    mocks.leadFindFirst.mockResolvedValue({ id: 'lead-1', clinicId: 'clinic-a', name: 'Ana', phone: '9800000001' });
    mocks.patientFindMany.mockResolvedValue([{ id: 'patient-1', clinicId: 'clinic-a', phone: '919800000001', leadId: null }]);
    await expect(complete('lead-1')).resolves.toBe('patient-1');
    expect(mocks.patientCreate).not.toHaveBeenCalled();
    expect(mocks.appointmentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ clinicId: 'clinic-a' }),
        data: { patientId: 'patient-1' },
      })
    );
  });

  it('creates one patient when the phone is new, and a second completion does not create another', async () => {
    mocks.patientFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'patient-new',
      clinicId: 'clinic-a',
      phone: '919800000002',
      leadId: 'lead-1',
    });
    mocks.leadFindFirst.mockResolvedValue({ id: 'lead-1', name: 'Ravi', phone: '9800000002', email: null, notes: null });
    mocks.patientFindMany.mockResolvedValue([]);
    mocks.patientCreate.mockResolvedValue({ id: 'patient-new', clinicId: 'clinic-a', phone: '919800000002', leadId: 'lead-1' });

    await expect(complete('lead-1')).resolves.toBe('patient-new');
    await expect(complete('patient-new')).resolves.toBe('patient-new');
    expect(mocks.patientCreate).toHaveBeenCalledTimes(1);
  });

  it('does not pick a patient when two records share the phone', async () => {
    mocks.patientFindFirst.mockResolvedValue(null);
    mocks.leadFindFirst.mockResolvedValue({ id: 'lead-1', name: 'Ana', phone: '9800000001' });
    mocks.patientFindMany.mockResolvedValue([
      { id: 'patient-1', phone: '919800000001' },
      { id: 'patient-2', phone: '9800000001' },
    ]);
    await expect(complete('lead-1')).rejects.toMatchObject({ code: 'PATIENT_AMBIGUOUS' });
    expect(mocks.patientCreate).not.toHaveBeenCalled();
    expect(mocks.appointmentUpdateMany).not.toHaveBeenCalled();
  });

  it('does not use a patient from another clinic', async () => {
    mocks.patientFindFirst.mockResolvedValue(null);
    mocks.leadFindFirst.mockResolvedValue(null);
    await expect(complete('patient-from-clinic-b')).rejects.toMatchObject({ code: 'PATIENT_LINK_REQUIRED' });
    expect(mocks.patientFindFirst).toHaveBeenCalledWith({
      where: { id: 'patient-from-clinic-b', clinicId: 'clinic-a' },
    });
    expect(mocks.patientCreate).not.toHaveBeenCalled();
  });

  it('does not mark the appointment completed when the patient link fails', async () => {
    const repo = {
      findById: vi.fn().mockResolvedValue({
        id: 'apt-1',
        clinicId: 'clinic-a',
        patientId: 'lead-1',
        service: 'Consultation',
        status: 'CONFIRMED',
        startsAt: new Date('2026-10-27T10:00:00.000Z'),
        durationMinutes: 30,
      }),
      update: vi.fn(),
    };
    const linked = new AppointmentService(repo as any);
    mocks.patientFindFirst.mockResolvedValue(null);
    mocks.leadFindFirst.mockResolvedValue({ id: 'lead-1', name: 'Ana', phone: '9800000001' });
    mocks.patientFindMany.mockResolvedValue([
      { id: 'patient-1', phone: '919800000001' },
      { id: 'patient-2', phone: '9800000001' },
    ]);

    await expect(
      linked.updateAppointment('apt-1', 'clinic-a', { status: 'COMPLETED' }, {})
    ).rejects.toMatchObject({ code: 'PATIENT_AMBIGUOUS' });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('leaves the appointment unchanged when saving the new patient fails', async () => {
    mocks.patientFindFirst.mockResolvedValue(null);
    mocks.leadFindFirst.mockResolvedValue({ id: 'lead-1', name: 'Ravi', phone: '9800000002', email: null, notes: null });
    mocks.patientFindMany.mockResolvedValue([]);
    mocks.patientCreate.mockRejectedValue(new Error('db down'));
    await expect(complete('lead-1')).rejects.toThrow('db down');
    expect(mocks.appointmentUpdateMany).not.toHaveBeenCalled();
  });
});
