import { beforeEach, describe, expect, it, vi } from 'vitest';

const scheduleGenerateReply = vi.fn();

vi.mock('../conversations/conversation.service.js', () => ({
  conversationService: { scheduleGenerateReply },
}));

vi.mock('../../config/db.js', () => ({
  prisma: {
    appointment: { findFirst: vi.fn() },
    patient: { findFirst: vi.fn() },
    whatsappAccount: { findFirst: vi.fn() },
    job: { findFirst: vi.fn(), create: vi.fn() },
    conversation: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    message: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    invoice: { findFirst: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaTx)),
  },
}));

import { prisma } from '../../config/db.js';
import { executeTemplateSendJob, queueTemplateSends } from './outbound.service.js';

const prismaTx = prisma;

const appointment = (id: string, phone: string) => ({
  id,
  startsAt: new Date('2026-10-07T10:30:00.000Z'),
  patient: { id: `patient-${id}`, name: 'Ana', phone },
  clinic: { name: 'City Clinic' },
  doctor: { user: { firstName: 'Shah', lastName: 'Mehta' } },
});

describe('template outbound queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.whatsappAccount.findFirst).mockResolvedValue({
      id: 'wa-1',
      clinicId: 'clinic-a',
      phoneNumberId: 'phone-1',
      accessTokenEncrypted: 'plain-token',
      isActive: true,
    } as any);
    vi.mocked(prisma.job.findFirst).mockResolvedValue(null as any);
    vi.mocked(prisma.conversation.findFirst).mockResolvedValue(null as any);
    vi.mocked(prisma.conversation.create).mockImplementation(async ({ data }: any) => ({ id: `conv-${data.participantPhone}`, ...data }));
    vi.mocked(prisma.conversation.update).mockResolvedValue({} as any);
    vi.mocked(prisma.message.create).mockImplementation(async ({ data }: any) => ({ id: `msg-${data.conversationId}`, ...data }));
    vi.mocked(prisma.job.create).mockImplementation(async ({ data }: any) => ({ id: `job-${data.payload.recipientPhone}`, ...data }));
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => fn(prisma));
  });

  it('creates a separate job for each recipient and does not start the AI', async () => {
    vi.mocked(prisma.appointment.findFirst).mockImplementation(async ({ where }: any) => {
      expect(where.clinicId).toBe('clinic-a');
      return appointment(where.id, where.id === 'apt-1' ? '9876543210' : '9876543211') as any;
    });

    const result = await queueTemplateSends('clinic-a', 'REMINDER', {
      appointmentIds: ['apt-1', 'apt-2'],
    });

    expect(result.queued).toHaveLength(2);
    expect(result.queued[0].jobId).not.toBe(result.queued[1].jobId);
    expect(prisma.job.create).toHaveBeenCalledTimes(2);
    const created = vi.mocked(prisma.conversation.create).mock.calls[0][0].data;
    expect(created.state).toBe('AI_ACTIVE');
    expect(created.unreadCount).toBe(0);
    expect(scheduleGenerateReply).not.toHaveBeenCalled();
  });

  it('skips a recipient whose message was already accepted today', async () => {
    vi.mocked(prisma.appointment.findFirst).mockResolvedValue(appointment('apt-1', '9876543210') as any);
    vi.mocked(prisma.job.findFirst).mockResolvedValue({
      id: 'job-existing',
      status: 'COMPLETED',
      payload: { messageId: 'msg-sent' },
    } as any);
    vi.mocked(prisma.message.findFirst).mockResolvedValue({ id: 'msg-sent', providerMessageId: 'wamid.1' } as any);

    const result = await queueTemplateSends('clinic-a', 'REMINDER', { appointmentIds: ['apt-1'] });

    expect(result.queued).toHaveLength(0);
    expect(result.skipped[0].reason).toBe('DUPLICATE');
    expect(prisma.job.create).not.toHaveBeenCalled();
  });

  it('queues again when the earlier job never reached WhatsApp', async () => {
    vi.mocked(prisma.appointment.findFirst).mockResolvedValue(appointment('apt-1', '9876543210') as any);
    vi.mocked(prisma.job.findFirst).mockResolvedValue({
      id: 'job-existing',
      status: 'COMPLETED',
      payload: { messageId: 'msg-unsent' },
    } as any);
    vi.mocked(prisma.message.findFirst).mockResolvedValue({ id: 'msg-unsent', providerMessageId: null } as any);

    const result = await queueTemplateSends('clinic-a', 'REMINDER', { appointmentIds: ['apt-1'] });

    expect(result.queued).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
  });

  it('does not load an appointment from another clinic', async () => {
    vi.mocked(prisma.appointment.findFirst).mockResolvedValue(null as any);
    await expect(queueTemplateSends('clinic-a', 'REMINDER', { appointmentIds: ['apt-from-clinic-b'] })).rejects.toThrow(
      /not found in this clinic/
    );
  });

  it('does not call Meta again when the message already has a WhatsApp id', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(prisma.message.findFirst).mockResolvedValue({ id: 'msg-1', providerMessageId: 'wamid.1' } as any);

    await executeTemplateSendJob({
      clinicId: 'clinic-a',
      attempts: 2,
      maxAttempts: 3,
      payload: {
        messageId: 'msg-1',
        recipientPhone: '919876543210',
        templateKey: 'REMINDER',
        templateName: 'cgs_appointment_reminder',
        languageCode: 'en',
        parameters: ['Ana', 'City Clinic', 'Dr. Shah', '07 Oct 2026', '4:00 pm'],
        trySessionFirst: true,
        sessionText: 'Hello Ana',
      },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('sends the template after the 24-hour window rejects the normal message', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ success: false, error: 'Re-engagement message', metaCode: 131047, windowClosed: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { messages: [{ id: 'wamid.template' }] } }),
      });
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(prisma.message.findFirst).mockImplementation(async (args: any) => {
      if (args?.where?.direction === 'INBOUND') return { createdAt: new Date() } as any;
      return { id: 'msg-1', providerMessageId: null } as any;
    });
    vi.mocked(prisma.message.updateMany).mockResolvedValue({ count: 1 } as any);

    await executeTemplateSendJob({
      clinicId: 'clinic-a',
      attempts: 1,
      maxAttempts: 3,
      payload: {
        messageId: 'msg-1',
        recipientPhone: '919876543210',
        templateKey: 'REMINDER',
        templateName: 'cgs_appointment_reminder',
        languageCode: 'en',
        parameters: ['Ana', 'City Clinic', 'Dr. Shah', '07 Oct 2026', '4:00 pm'],
        trySessionFirst: true,
        sessionText: 'Hello Ana, this is a reminder from City Clinic.',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.template.name).toBe('cgs_appointment_reminder');
    expect(secondBody.template.bodyParameters).toHaveLength(5);
    expect(prisma.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SENT', providerMessageId: 'wamid.template' }),
      })
    );
    expect(scheduleGenerateReply).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('sends the bill PDF as a normal file first, then the template if the window is closed', async () => {
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue({
      id: 'inv-1',
      clinicId: 'clinic-a',
      patientId: 'patient-1',
      invoiceNumber: 'INV-1',
      status: 'ISSUED',
      subtotal: 500,
      discount: 0,
      tax: 0,
      total: 500,
      amountPaid: 0,
      amountDue: 500,
      paymentMethod: 'UPI',
      service: 'Consultation',
      notes: '',
      issuedAt: new Date('2026-10-06T10:00:00.000Z'),
      dueDate: null,
      createdAt: new Date('2026-10-06T10:00:00.000Z'),
      patient: { name: 'Ana', phone: '9876543210', email: null },
      clinic: { name: 'City Clinic', address: null, city: null, postalCode: null, phone: null, email: null, gstin: null },
      items: [],
      treatingDoctor: null,
    } as any);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ success: false, error: 'Re-engagement message', metaCode: 131047, windowClosed: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { messages: [{ id: 'wamid.bill' }] } }),
      });
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(prisma.message.findFirst).mockImplementation(async (args: any) => {
      if (args?.where?.direction === 'INBOUND') return { createdAt: new Date() } as any;
      return { id: 'msg-1', providerMessageId: null } as any;
    });
    vi.mocked(prisma.message.updateMany).mockResolvedValue({ count: 1 } as any);

    await executeTemplateSendJob({
      clinicId: 'clinic-a',
      attempts: 1,
      maxAttempts: 3,
      payload: {
        messageId: 'msg-1',
        recipientPhone: '919876543210',
        templateKey: 'BILL',
        templateName: 'cgs_invoice_bill',
        languageCode: 'en',
        parameters: ['Ana', 'City Clinic', 'INV-1', 'Rs. 500'],
        trySessionFirst: true,
        sessionText: 'Hello Ana, this is City Clinic. Your bill INV-1 for Rs. 500 is attached as a PDF.',
        invoiceId: 'inv-1',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(firstBody.template).toBeUndefined();
    expect(firstBody.text).toContain('INV-1');
    expect(firstBody.document.mimeType).toBe('application/pdf');
    expect(firstBody.document.base64.length).toBeGreaterThan(20);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondBody.template.name).toBe('cgs_invoice_bill');
    expect(secondBody.template.document.filename).toContain('INV-1');
    expect(secondBody.template.bodyParameters).toEqual(['Ana', 'City Clinic', 'INV-1', 'Rs. 500']);
    expect(prisma.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SENT', providerMessageId: 'wamid.bill', mediaType: 'cgs_invoice_bill' }),
      })
    );
    vi.unstubAllGlobals();
  });

  it('sends the bill template directly when the patient has not written in 24 hours', async () => {
    vi.mocked(prisma.invoice.findFirst).mockResolvedValue({
      id: 'inv-1',
      clinicId: 'clinic-a',
      patientId: 'patient-1',
      invoiceNumber: 'INV-1',
      status: 'ISSUED',
      subtotal: 500,
      discount: 0,
      tax: 0,
      total: 500,
      amountPaid: 0,
      amountDue: 500,
      paymentMethod: 'UPI',
      service: 'Consultation',
      notes: '',
      issuedAt: new Date('2026-10-06T10:00:00.000Z'),
      dueDate: null,
      createdAt: new Date('2026-10-06T10:00:00.000Z'),
      patient: { name: 'Ana', phone: '9876543210', email: null },
      clinic: { name: 'City Clinic', address: null, city: null, postalCode: null, phone: null, email: null, gstin: null },
      items: [],
      treatingDoctor: null,
    } as any);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { messages: [{ id: 'wamid.template' }] } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(prisma.message.findFirst).mockImplementation(async (args: any) => {
      if (args?.where?.direction === 'INBOUND') {
        return { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } as any;
      }
      return { id: 'msg-1', providerMessageId: null } as any;
    });
    vi.mocked(prisma.message.updateMany).mockResolvedValue({ count: 1 } as any);

    await executeTemplateSendJob({
      clinicId: 'clinic-a',
      attempts: 1,
      maxAttempts: 3,
      payload: {
        messageId: 'msg-1',
        recipientPhone: '919876543210',
        templateKey: 'BILL',
        templateName: 'cgs_invoice_bill',
        languageCode: 'en',
        parameters: ['Ana', 'City Clinic', 'INV-1', 'Rs. 500'],
        trySessionFirst: true,
        sessionText: 'Hello Ana, this is City Clinic. Your bill INV-1 for Rs. 500 is attached as a PDF.',
        invoiceId: 'inv-1',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toBeUndefined();
    expect(body.template.name).toBe('cgs_invoice_bill');
    expect(prisma.message.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SENT', providerMessageId: 'wamid.template', mediaType: 'cgs_invoice_bill' }),
      })
    );
    vi.unstubAllGlobals();
  });
});
