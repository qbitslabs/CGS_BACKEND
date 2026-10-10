/* Queue global template sends. One job per recipient. Does not start the AI. */
import { prisma } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/errorHandler.js';
import { decryptToken } from '../../utils/crypto.js';
import { phoneMatchVariants } from '../../utils/phoneMatch.js';
import { buildInvoicePdf, invoicePdfFilename, InvoicePdfInput } from '../billing/invoicePdf.js';
import {
  WHATSAPP_TEMPLATE_SEND_JOB,
  WhatsAppTemplateDefinition,
  assertAccountBelongsToClinic,
  assertRecipientPhone,
  assertTemplateUsable,
  fillTemplatePreview,
  findTemplate,
  formatClinicDate,
  formatClinicTime,
  idempotencyKey,
  isCustomerCareWindowClosed,
  kolkataDay,
  shouldSkipAcceptedSend,
} from './whatsappTemplates.js';

type RecipientInput = {
  appointmentIds?: string[];
  patientIds?: string[];
  leadIds?: string[];
  invoiceIds?: string[];
  fallbackDoctorId?: string;
  /** Replaces the calendar day in the idempotency key so each reminder stage sends once. */
  stage?: string;
};

type ResolvedSend = {
  recordId: string;
  phone: string;
  participantName: string;
  patientId?: string;
  leadId?: string;
  invoiceId?: string;
  doctorId?: string;
  parameters: string[];
  preview: string;
};

function doctorName(doctor?: { user?: { firstName?: string | null; lastName?: string | null } | null } | null): string {
  const name = `${doctor?.user?.firstName || ''} ${doctor?.user?.lastName || ''}`.trim();
  return name ? `Dr. ${name.replace(/^Dr\.?\s*/i, '')}` : 'the doctor';
}

function loadClinicInvoice(clinicId: string, invoiceId: string) {
  return prisma.invoice.findFirst({
    where: { id: invoiceId, clinicId },
    include: {
      patient: true,
      items: true,
      treatingDoctor: { select: { specialization: true, user: { select: { firstName: true, lastName: true } } } },
      clinic: { select: { name: true, address: true, city: true, postalCode: true, phone: true, email: true, gstin: true } },
    },
  });
}

function invoicePdfInput(invoice: NonNullable<Awaited<ReturnType<typeof loadClinicInvoice>>>): InvoicePdfInput {
  const clinic = invoice.clinic;
  const taxableBase = Number(invoice.subtotal) - Number(invoice.discount || 0);
  const taxAmount = Number(invoice.tax);
  const doctor = invoice.treatingDoctor?.user;
  const doctorFull = `${doctor?.firstName || ''} ${doctor?.lastName || ''}`.trim();
  return {
    invoiceNumber: invoice.invoiceNumber,
    clinicName: clinic?.name,
    clinicAddress: [clinic?.address, clinic?.city, clinic?.postalCode].filter(Boolean).join(', '),
    clinicPhone: clinic?.phone || undefined,
    clinicEmail: clinic?.email || undefined,
    clinicGstin: clinic?.gstin || undefined,
    patientName: invoice.patient?.name || 'Patient',
    patientPhone: invoice.patient?.phone || '',
    patientEmail: invoice.patient?.email || undefined,
    service: invoice.service || invoice.items?.[0]?.name || 'Clinical Treatment',
    services: (invoice.items || []).map((item) => ({
      name: item.name,
      quantity: Number(item.quantity),
      unitPrice: Number(item.unitPrice),
      total: Number(item.total),
    })),
    subtotal: Number(invoice.subtotal),
    discount: Number(invoice.discount),
    tax: taxAmount,
    taxPercent: taxableBase > 0 ? Number(((taxAmount / taxableBase) * 100).toFixed(2)) : 0,
    total: Number(invoice.total),
    paidAmount: Number(invoice.amountPaid),
    remainingAmount: Number(invoice.amountDue),
    paymentStatus:
      invoice.status === 'PAID'
        ? 'Paid'
        : invoice.status === 'PARTIALLY_PAID'
          ? 'Partially Paid'
          : invoice.status === 'ISSUED'
            ? 'Pending'
            : invoice.status === 'VOID'
              ? 'Cancelled'
              : 'Draft',
    paymentMethod: invoice.paymentMethod
      ? invoice.paymentMethod.charAt(0) + invoice.paymentMethod.slice(1).toLowerCase().replace('_', ' ')
      : 'UPI',
    date: (invoice.issuedAt || invoice.createdAt).toISOString().split('T')[0],
    dueDate: invoice.dueDate ? invoice.dueDate.toISOString().split('T')[0] : undefined,
    notes: invoice.notes || '',
    treatingDoctorName: doctorFull ? `Dr. ${doctorFull.replace(/^Dr\.?\s*/i, '')}` : undefined,
    treatingDoctorSpecialization: invoice.treatingDoctor?.specialization || undefined,
  };
}

async function resolveOne(
  clinicId: string,
  template: WhatsAppTemplateDefinition,
  recordId: string,
  fallbackDoctorId?: string
): Promise<ResolvedSend> {
  if (template.recipientKind === 'appointment') {
    const appointment = await prisma.appointment.findFirst({
      where: { id: recordId, clinicId },
      include: {
        patient: true,
        clinic: true,
        doctor: { include: { user: { select: { firstName: true, lastName: true } } } },
      },
    });
    if (!appointment) {
      throw new AppError('Appointment not found in this clinic', 404, 'APPOINTMENT_NOT_FOUND');
    }
    const values: Record<string, string> = {
      patientName: appointment.patient.name,
      clinicName: appointment.clinic.name,
      doctorName: doctorName(appointment.doctor),
      appointmentDate: formatClinicDate(appointment.startsAt),
      appointmentTime: formatClinicTime(appointment.startsAt),
    };
    const parameters = template.body.map((item) => values[item.source] || '');
    assertTemplateUsable(template, parameters);
    return {
      recordId: appointment.id,
      phone: assertRecipientPhone(appointment.patient.phone),
      participantName: appointment.patient.name,
      patientId: appointment.patient.id,
      parameters,
      preview: fillTemplatePreview(template.bodyText, parameters),
    };
  }

  if (template.recipientKind === 'lead') {
    const lead = await prisma.lead.findFirst({
      where: { id: recordId, clinicId, source: 'WEBSITE' },
      include: { clinic: true },
    });
    if (!lead) {
      throw new AppError('Landing page enquiry not found in this clinic', 404, 'LEAD_NOT_FOUND');
    }
    const values: Record<string, string> = {
      patientName: lead.name,
      clinicName: lead.clinic.name,
      interestedService: lead.interestedService?.trim() || 'a consultation',
      preferredDoctor: lead.preferredDoctor?.trim() || 'our team',
    };
    const parameters = template.body.map((item) => values[item.source] || '');
    assertTemplateUsable(template, parameters);
    return {
      recordId: lead.id,
      phone: assertRecipientPhone(lead.phone),
      participantName: lead.name,
      leadId: lead.id,
      parameters,
      preview: fillTemplatePreview(template.bodyText, parameters),
    };
  }

  if (template.recipientKind === 'invoice') {
    const invoice = await loadClinicInvoice(clinicId, recordId);
    if (!invoice) {
      throw new AppError('Invoice not found in this clinic', 404, 'INVOICE_NOT_FOUND');
    }
    const pdfInput = invoicePdfInput(invoice);
    const values: Record<string, string> = {
      patientName: pdfInput.patientName,
      clinicName: pdfInput.clinicName || 'the clinic',
      invoiceNumber: pdfInput.invoiceNumber,
      invoiceAmount: `Rs. ${Number(pdfInput.total || 0).toLocaleString('en-IN')}`,
    };
    const parameters = template.body.map((item) => values[item.source] || '');
    assertTemplateUsable(template, parameters);
    return {
      recordId: invoice.id,
      phone: assertRecipientPhone(pdfInput.patientPhone || ''),
      participantName: pdfInput.patientName,
      patientId: invoice.patientId,
      invoiceId: invoice.id,
      doctorId: invoice.treatingDoctorId || fallbackDoctorId,
      parameters,
      preview: fillTemplatePreview(template.bodyText, parameters),
    };
  }

  const patient = await prisma.patient.findFirst({
    where: { id: recordId, clinicId },
    include: { clinic: true },
  });
  if (!patient) {
    throw new AppError('Patient not found in this clinic', 404, 'PATIENT_NOT_FOUND');
  }
  const lastVisit = await prisma.appointment.findFirst({
    where: {
      clinicId,
      patientId: patient.id,
      startsAt: { lt: new Date() },
      status: { not: 'CANCELLED' },
    },
    orderBy: { startsAt: 'desc' },
  });
  const values: Record<string, string> = {
    patientName: patient.name,
    clinicName: patient.clinic.name,
    lastVisitDate: lastVisit ? formatClinicDate(lastVisit.startsAt) : 'a previous visit',
  };
  const parameters = template.body.map((item) => values[item.source] || '');
  assertTemplateUsable(template, parameters);
  return {
    recordId: patient.id,
    phone: assertRecipientPhone(patient.phone),
    participantName: patient.name,
    patientId: patient.id,
    parameters,
    preview: fillTemplatePreview(template.bodyText, parameters),
  };
}

function recordIds(template: WhatsAppTemplateDefinition, input: RecipientInput): string[] {
  const ids =
    template.recipientKind === 'appointment'
      ? input.appointmentIds
      : template.recipientKind === 'lead'
        ? input.leadIds
        : template.recipientKind === 'invoice'
          ? input.invoiceIds
          : input.patientIds;
  const unique = [...new Set((ids || []).map((id) => id.trim()).filter(Boolean))];
  if (!unique.length) {
    throw new AppError('Select at least one recipient', 400, 'RECIPIENTS_REQUIRED');
  }
  if (unique.length > 100) {
    throw new AppError('Send at most 100 recipients at a time', 400, 'TOO_MANY_RECIPIENTS');
  }
  return unique;
}

export async function previewTemplateSends(clinicId: string, templateKey: string, input: RecipientInput) {
  const template = findTemplate(templateKey);
  const items = [];
  for (const recordId of recordIds(template, input)) {
    items.push(await resolveOne(clinicId, template, recordId));
  }
  return {
    template: publicTemplate(template),
    items,
  };
}

const CUSTOMER_CARE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** True when the patient sent a WhatsApp message in the last 24 hours. */
export async function customerCareWindowOpen(clinicId: string, phone: string, now = new Date()): Promise<boolean> {
  const latest = await prisma.message.findFirst({
    where: {
      clinicId,
      direction: 'INBOUND',
      conversation: { participantPhone: { in: phoneMatchVariants(phone) } },
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (!latest?.createdAt) return false;
  return now.getTime() - latest.createdAt.getTime() < CUSTOMER_CARE_WINDOW_MS;
}

async function sendAlreadyAccepted(
  clinicId: string,
  job: { status: string; payload: unknown }
): Promise<boolean> {
  if (job.status === 'PENDING' || job.status === 'PROCESSING') return true;
  const payload = job.payload && typeof job.payload === 'object' ? (job.payload as { messageId?: string; recipientPhone?: string }) : {};
  if (!payload.messageId) return false;
  const message = await prisma.message.findFirst({
    where: { id: payload.messageId, clinicId },
    select: { providerMessageId: true, mediaType: true },
  });
  if (!message?.providerMessageId || message.providerMessageId.startsWith('pending:')) return false;
  const phone = typeof payload.recipientPhone === 'string' ? payload.recipientPhone : '';
  if (message.mediaType === 'session' && phone && !(await customerCareWindowOpen(clinicId, phone))) return false;
  return true;
}

export async function queueTemplateSends(clinicId: string, templateKey: string, input: RecipientInput) {
  const template = findTemplate(templateKey);
  const account = await prisma.whatsappAccount.findFirst({
    where: { clinicId, isActive: true },
  });
  if (!account) {
    throw new AppError('WhatsApp account is not configured for this clinic', 409, 'WHATSAPP_NOT_CONFIGURED');
  }
  assertAccountBelongsToClinic(account.clinicId, clinicId);

  const queued = [];
  const skipped = [];
  const day = kolkataDay();

  for (const recordId of recordIds(template, input)) {
    const resolved = await resolveOne(clinicId, template, recordId, input.fallbackDoctorId);
    const key = idempotencyKey({
      clinicId,
      templateKey: template.key,
      phone: resolved.phone,
      recordId: resolved.recordId,
      day: input.stage || day,
    });
    const existing = await prisma.job.findFirst({
      where: {
        clinicId,
        type: WHATSAPP_TEMPLATE_SEND_JOB,
        status: { in: ['PENDING', 'PROCESSING', 'COMPLETED'] },
        payload: { path: ['idempotencyKey'], equals: key },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, payload: true },
    });
    if (existing && (await sendAlreadyAccepted(clinicId, existing))) {
      skipped.push({ recordId: resolved.recordId, phone: resolved.phone, reason: 'DUPLICATE', jobId: existing.id });
      continue;
    }

    const created = await prisma.$transaction(async (tx) => {
      let conversation = await tx.conversation.findFirst({
        where: { clinicId, participantPhone: { in: phoneMatchVariants(resolved.phone) } },
        orderBy: { lastActivityAt: 'desc' },
      });
      if (!conversation) {
        conversation = await tx.conversation.create({
          data: {
            clinicId,
            patientId: resolved.patientId,
            leadId: resolved.leadId,
            doctorId: resolved.doctorId,
            whatsappAccountId: account.id,
            participantName: resolved.participantName,
            participantPhone: resolved.phone,
            state: 'AI_ACTIVE',
            unreadCount: 0,
            lastMessageText: resolved.preview,
            lastMessageAt: new Date(),
            lastActivityAt: new Date(),
          },
        });
      } else {
        await tx.conversation.update({
          where: { id: conversation.id },
          data: {
            patientId: conversation.patientId || resolved.patientId,
            leadId: conversation.leadId || resolved.leadId,
            doctorId: conversation.doctorId || resolved.doctorId,
            whatsappAccountId: conversation.whatsappAccountId || account.id,
            lastMessageText: resolved.preview,
            lastMessageAt: new Date(),
            lastActivityAt: new Date(),
          },
        });
      }

      const message = await tx.message.create({
        data: {
          clinicId,
          conversationId: conversation.id,
          whatsappAccountId: account.id,
          direction: 'OUTBOUND',
          senderType: 'SYSTEM',
          senderName: 'Clinic',
          content: resolved.preview,
          mediaUrl: template.documentHeader ? invoicePdfFilename(resolved.parameters[2] || 'invoice') : undefined,
          mediaType: template.metaName,
          status: 'PENDING',
          isAiGenerated: false,
        },
      });

      const job = await tx.job.create({
        data: {
          clinicId,
          queue: 'WHATSAPP',
          type: WHATSAPP_TEMPLATE_SEND_JOB,
          maxAttempts: 3,
          payload: {
            messageId: message.id,
            conversationId: conversation.id,
            idempotencyKey: key,
            recipientPhone: resolved.phone,
            templateKey: template.key,
            templateName: template.metaName,
            languageCode: template.languageCode,
            parameters: resolved.parameters,
            trySessionFirst: template.trySessionFirst,
            sessionText: template.trySessionFirst ? resolved.preview : undefined,
            invoiceId: resolved.invoiceId,
          },
        },
      });
      return { messageId: message.id, conversationId: conversation.id, jobId: job.id };
    });

    queued.push({ ...created, phone: resolved.phone, preview: resolved.preview });
  }

  return { template: publicTemplate(template), queued, skipped };
}

export function publicTemplate(template: WhatsAppTemplateDefinition) {
  return {
    key: template.key,
    purpose: template.purpose,
    metaName: template.metaName,
    languageCode: template.languageCode,
    status: template.status,
    trySessionFirst: template.trySessionFirst,
    documentHeader: Boolean(template.documentHeader),
    recipientKind: template.recipientKind,
    parameters: template.body.map((item, index) => ({
      index: index + 1,
      source: item.source,
      label: item.label,
    })),
  };
}

type GatewayResult =
  | { ok: true; metaMessageId?: string }
  | { ok: false; windowClosed: boolean; error: string; metaCode?: number };

async function postGateway(body: Record<string, unknown>): Promise<GatewayResult> {
  const response = await fetch(`${env.WHATSAPP_SERVICE_URL}/w_api/v1/whatsapp/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Service-Key': env.INTERNAL_SERVICE_SECRET,
    },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
    metaCode?: number;
    windowClosed?: boolean;
    data?: { messages?: Array<{ id?: string }> };
  };
  if (!response.ok || data.success === false) {
    const error = data.error || `WhatsApp gateway error ${response.status}`;
    return {
      ok: false,
      error,
      metaCode: data.metaCode,
      windowClosed: Boolean(data.windowClosed) || isCustomerCareWindowClosed(data.metaCode, error),
    };
  }
  return { ok: true, metaMessageId: data.data?.messages?.[0]?.id };
}

export async function executeTemplateSendJob(job: {
  clinicId: string | null;
  attempts: number;
  maxAttempts: number;
  payload: {
    messageId?: string;
    recipientPhone?: string;
    templateName?: string;
    languageCode?: string;
    parameters?: string[];
    trySessionFirst?: boolean;
    sessionText?: string;
    invoiceId?: string;
  };
}) {
  const clinicId = job.clinicId;
  const payload = job.payload || {};
  if (!clinicId || !payload.messageId || !payload.recipientPhone || !payload.templateName || !payload.languageCode) {
    throw new Error('Invalid WHATSAPP_TEMPLATE_SEND payload');
  }

  const message = await prisma.message.findFirst({
    where: { id: payload.messageId, clinicId },
    select: { id: true, providerMessageId: true },
  });
  if (!message) throw new Error('Outbound message was not found for this clinic');
  if (shouldSkipAcceptedSend(message.providerMessageId)) return;

  const parameters = (payload.parameters || []).map((item) => String(item));
  const template = findTemplate(String((payload as { templateKey?: string }).templateKey || ''));
  assertTemplateUsable(template, parameters);

  const account = await prisma.whatsappAccount.findFirst({
    where: { clinicId, isActive: true },
  });
  if (!account?.phoneNumberId || !account.accessTokenEncrypted) {
    throw new AppError('WhatsApp account is not configured for this clinic', 409, 'WHATSAPP_NOT_CONFIGURED');
  }
  assertAccountBelongsToClinic(account.clinicId, clinicId);
  const accessToken = decryptToken(account.accessTokenEncrypted);
  if (!accessToken) {
    throw new AppError('WhatsApp account is not configured for this clinic', 409, 'WHATSAPP_NOT_CONFIGURED');
  }

  const base = {
    phoneNumberId: account.phoneNumberId,
    recipientPhone: payload.recipientPhone,
    accessToken,
  };

  let document: { filename: string; mimeType: string; base64: string } | undefined;
  if (template.documentHeader) {
    if (!payload.invoiceId) throw new Error('Bill template is missing the invoice');
    const invoice = await loadClinicInvoice(clinicId, payload.invoiceId);
    if (!invoice) throw new AppError('Invoice not found in this clinic', 404, 'INVOICE_NOT_FOUND');
    const pdfInput = invoicePdfInput(invoice);
    const pdf = await buildInvoicePdf(pdfInput);
    document = {
      filename: invoicePdfFilename(pdfInput.invoiceNumber),
      mimeType: 'application/pdf',
      base64: pdf.toString('base64'),
    };
  }

  let sent: GatewayResult | null = null;
  let mode: 'session' | 'template' = 'template';
  const windowOpen = payload.trySessionFirst ? await customerCareWindowOpen(clinicId, payload.recipientPhone) : false;
  if (windowOpen && payload.trySessionFirst && (payload.sessionText || document)) {
    const session = document
      ? await postGateway({ ...base, text: payload.sessionText || '', document })
      : await postGateway({ ...base, text: payload.sessionText });
    if (session.ok) {
      sent = session;
      mode = 'session';
    } else if (!session.windowClosed) {
      throw new Error(session.error);
    }
  }
  if (!sent) {
    const templated = await postGateway({
      ...base,
      template: {
        name: payload.templateName,
        languageCode: payload.languageCode,
        bodyParameters: parameters,
        document,
      },
    });
    if (!templated.ok) throw new Error(templated.error);
    sent = templated;
    mode = 'template';
  }

  await prisma.message.updateMany({
    where: { id: message.id, clinicId },
    data: {
      status: 'SENT',
      providerMessageId: sent.metaMessageId || undefined,
      mediaType: mode === 'session' ? 'session' : template.metaName,
    },
  });
}

export async function markTemplateSendFailed(messageId: string, clinicId: string) {
  await prisma.message.updateMany({
    where: { id: messageId, clinicId, providerMessageId: null },
    data: { status: 'FAILED' },
  });
}
