/* CGS billing module — business logic.
 * Clinic API layer for billing; talks Prisma or callers, not the AI database. */
import { billingRepository, BillingRepository } from './billing.repository.js';
import { CollectPaymentDTO, CreateInvoiceDTO, InvoiceListQuery } from './billing.types.js';
import { patientRepository } from '../patients/patient.repository.js';
import { conversationRepository } from '../conversations/conversation.repository.js';
import { AppError } from '../../middleware/errorHandler.js';
import { logAuditEvent } from '../../middleware/audit.js';
import { buildInvoicePdf, invoicePdfFilename } from './invoicePdf.js';

function phoneMatchVariants(phone: string): string[] {
  const digits = phone.replace(/\D/g, '');
  if (!digits) return [];
  const variants = new Set<string>([digits, phone]);
  if (digits.length === 10) variants.add(`91${digits}`);
  if (digits.startsWith('91') && digits.length === 12) variants.add(digits.slice(2));
  if (digits.startsWith('0') && digits.length === 11) {
    variants.add(digits.slice(1));
    variants.add(`91${digits.slice(1)}`);
  }
  return [...variants];
}

function formatInvoiceDoctorName(user?: { firstName?: string | null; lastName?: string | null } | null) {
  if (!user) return undefined;
  const full = `${user.firstName || ''} ${user.lastName || ''}`.trim();
  if (!full) return undefined;
  if (/^dr\.?\s/i.test(full)) return full;
  return `Dr. ${full}`;
}

function whatsappRecipient(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  return digits || phone;
}

function formatInvoiceWhatsAppText(inv: ReturnType<BillingService['mapInvoiceToDTO']>): string {
  const clinic = inv.clinicName || 'the clinic';
  const paidNote =
    inv.paymentStatus === 'Paid'
      ? `Paid in full (₹${Number(inv.total).toLocaleString('en-IN')} via ${inv.paymentMethod})`
      : inv.remainingAmount > 0
        ? `Amount due: ₹${Number(inv.remainingAmount).toLocaleString('en-IN')}`
        : `Total: ₹${Number(inv.total).toLocaleString('en-IN')}`;

  return [
    `Hi ${inv.patientName}, thank you for visiting ${clinic}.`,
    '',
    `Your invoice ${inv.invoiceNumber} is attached as a PDF.`,
    paidNote,
    '',
    'Please keep this for your records. Reply here if you have any questions.',
  ].join('\n');
}

export class BillingService {
  constructor(private readonly repo: BillingRepository = billingRepository) {}

  private mapInvoiceToDTO(inv: any) {
    const clinic = inv.clinic || {};
    const taxableBase = Number(inv.subtotal) - Number(inv.discount || 0);
    const taxAmount = Number(inv.tax);
    const taxPercent = taxableBase > 0 ? Number(((taxAmount / taxableBase) * 100).toFixed(2)) : 0;
    return {
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      patientId: inv.patientId,
      patientName: inv.patient?.name || 'Patient',
      patientPhone: inv.patient?.phone || '',
      patientEmail: inv.patient?.email || undefined,
      clinicName: clinic.name,
      clinicAddress: [clinic.address, clinic.city, clinic.postalCode].filter(Boolean).join(', '),
      clinicPhone: clinic.phone,
      clinicEmail: clinic.email,
      clinicGstin: clinic.gstin,
      service: inv.service || inv.items?.[0]?.name || 'Clinical Treatment',
      services: (inv.items || []).map((it: any) => ({
        name: it.name,
        quantity: Number(it.quantity),
        unitPrice: Number(it.unitPrice),
        total: Number(it.total),
      })),
      subtotal: Number(inv.subtotal),
      discount: Number(inv.discount),
      tax: taxAmount,
      taxPercent,
      total: Number(inv.total),
      paidAmount: Number(inv.amountPaid),
      remainingAmount: Number(inv.amountDue),
      paymentStatus:
        inv.status === 'PAID'
          ? 'Paid'
          : inv.status === 'PARTIALLY_PAID'
          ? 'Partially Paid'
          : inv.status === 'ISSUED'
          ? 'Pending'
          : inv.status === 'VOID'
          ? 'Cancelled'
          : 'Draft',
      paymentMethod: inv.paymentMethod
        ? inv.paymentMethod.charAt(0) + inv.paymentMethod.slice(1).toLowerCase().replace('_', ' ')
        : 'UPI',
      date: inv.issuedAt ? inv.issuedAt.toISOString().split('T')[0] : inv.createdAt.toISOString().split('T')[0],
      dueDate: inv.dueDate ? inv.dueDate.toISOString().split('T')[0] : undefined,
      notes: inv.notes || '',
      createdDate: inv.createdAt.toISOString().split('T')[0],
      appointmentId: inv.appointmentId || undefined,
      treatingDoctorId: inv.treatingDoctorId || undefined,
      treatingDoctorName: formatInvoiceDoctorName(inv.treatingDoctor?.user),
      treatingDoctorSpecialization: inv.treatingDoctor?.specialization || undefined,
    };
  }

  async getRevenueSummary(clinicId: string, doctorId?: string) {
    return this.repo.getRevenueSummary(clinicId, doctorId);
  }

  async listInvoices(query: InvoiceListQuery) {
    const [total, invoices] = await Promise.all([
      this.repo.countInvoices(query),
      this.repo.findInvoices(query),
    ]);

    const page = query.page || 1;
    const limit = query.limit || 20;

    return {
      data: invoices.map((inv) => this.mapInvoiceToDTO(inv)),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getInvoiceById(id: string, clinicId: string) {
    const invoice = await this.repo.findInvoiceById(id, clinicId);
    if (!invoice) {
      throw new AppError('Invoice not found.', 404, 'NOT_FOUND');
    }
    return this.mapInvoiceToDTO(invoice);
  }

  async createInvoice(
    clinicId: string,
    dto: CreateInvoiceDTO,
    auditContext: {
      userId?: string;
      email?: string;
      actorName?: string;
      ip?: string;
      userAgent?: string;
      requestId?: string;
    }
  ) {
    const patient = await patientRepository.findById(dto.patientId, clinicId);
    if (!patient) {
      throw new AppError('Patient not found.', 404, 'NOT_FOUND');
    }

    const subtotal = dto.items.reduce((acc, item) => acc + item.quantity * item.unitPrice, 0);
    const discount = dto.discount || 0;
    const taxPercent = dto.taxPercent || 0;
    const tax = ((subtotal - discount) * taxPercent) / 100;
    const total = Math.max(0, subtotal - discount + tax);

    const invoice = await this.repo.createInvoiceInTx({
      clinicId,
      patientId: dto.patientId,
      service: dto.service || dto.items[0].name,
      subtotal,
      discount,
      tax,
      total,
      notes: dto.notes,
      createdByUserId: auditContext.userId,
      items: dto.items,
      actorName: auditContext.actorName || 'Staff',
      paidAmount: total,
      paymentMethod: dto.paymentMethod,
      treatingDoctorId: dto.treatingDoctorId,
    });

    await logAuditEvent({
      clinicId,
      userId: auditContext.userId,
      actorId: auditContext.userId || 'SYSTEM',
      actorEmail: auditContext.email || 'system',
      action: 'INVOICE_CREATED',
      resourceType: 'INVOICE',
      resourceId: invoice.id,
      metadata: { invoiceNumber: invoice.invoiceNumber, total, patientId: patient.id },
      ipAddress: auditContext.ip,
      userAgent: auditContext.userAgent,
      requestId: auditContext.requestId,
    });

    const full = await this.repo.findInvoiceById(invoice.id, clinicId);
    return full ? this.mapInvoiceToDTO(full) : invoice;
  }

  async collectPayment(
    invoiceId: string,
    clinicId: string,
    dto: CollectPaymentDTO,
    auditContext: {
      userId?: string;
      email?: string;
      actorName?: string;
      ip?: string;
      userAgent?: string;
      requestId?: string;
    }
  ) {
    const invoice = await this.repo.findInvoiceById(invoiceId, clinicId);
    if (!invoice) {
      throw new AppError('Invoice not found.', 404, 'NOT_FOUND');
    }

    const currentDue = Number(invoice.amountDue);
    if (currentDue <= 0) {
      throw new AppError('This invoice is already fully paid.', 400, 'ALREADY_PAID');
    }

    if (dto.amount > currentDue) {
      throw new AppError(
        `Payment amount ₹${dto.amount} exceeds outstanding balance of ₹${currentDue}.`,
        400,
        'AMOUNT_EXCEEDS_DUE'
      );
    }

    const newPaid = Number(invoice.amountPaid) + dto.amount;
    const newDue = Number(invoice.total) - newPaid;
    const newStatus = newDue <= 0 ? 'PAID' : 'PARTIALLY_PAID';

    const updatedInvoice = await this.repo.collectPaymentInTx({
      clinicId,
      invoiceId,
      patientId: invoice.patientId,
      amount: dto.amount,
      method: dto.paymentMethod,
      referenceNumber: dto.referenceNumber,
      remarks: dto.remarks,
      staffPasscode: dto.staffPasscode,
      collectedByUserId: auditContext.userId,
      actorName: auditContext.actorName || 'Staff',
      invoiceNumber: invoice.invoiceNumber,
      newPaid,
      newDue,
      newStatus,
    });

    await logAuditEvent({
      clinicId,
      userId: auditContext.userId,
      actorId: auditContext.userId || 'SYSTEM',
      actorEmail: auditContext.email || 'system',
      action: 'PAYMENT_COLLECTED',
      resourceType: 'PAYMENT',
      resourceId: invoiceId,
      metadata: { amount: dto.amount, method: dto.paymentMethod, invoiceNumber: invoice.invoiceNumber },
      ipAddress: auditContext.ip,
      userAgent: auditContext.userAgent,
      requestId: auditContext.requestId,
    });

    const full = await this.repo.findInvoiceById(invoiceId, clinicId);
    return full ? this.mapInvoiceToDTO(full) : updatedInvoice;
  }

  async sendInvoiceWhatsApp(
    invoiceId: string,
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
    const invoice = await this.repo.findInvoiceById(invoiceId, clinicId);
    if (!invoice) {
      throw new AppError('Invoice not found.', 404, 'NOT_FOUND');
    }

    const dto = this.mapInvoiceToDTO(invoice);
    const rawPhone = dto.patientPhone || invoice.patient?.phone || '';
    const phones = phoneMatchVariants(rawPhone);
    if (!phones.length) {
      throw new AppError(
        'This patient has no WhatsApp number on file.',
        400,
        'PATIENT_PHONE_MISSING'
      );
    }

    const recipientPhone = whatsappRecipient(rawPhone);
    const content = formatInvoiceWhatsAppText(dto);
    const filename = invoicePdfFilename(dto.invoiceNumber);
    const pdf = await buildInvoicePdf(dto);
    let conversation = await this.repo.findConversationForPatient(clinicId, dto.patientId, phones);

    if (!conversation) {
      const waAccount = await this.repo.findActiveWhatsappAccount(clinicId);
      conversation = await this.repo.createConversationForPatient({
        clinicId,
        patientId: dto.patientId,
        participantName: dto.patientName,
        participantPhone: recipientPhone,
        whatsappAccountId: waAccount?.id,
        lastMessageText: content,
      });
    }

    await conversationRepository.sendStaffMessageInTx({
      clinicId,
      conversationId: conversation.id,
      senderName: auditContext.actorName || 'Clinic',
      content,
      mediaUrl: filename,
      recipientPhone: conversation.participantPhone || recipientPhone,
      document: {
        filename,
        mimeType: 'application/pdf',
        base64: pdf.toString('base64'),
      },
    });

    await logAuditEvent({
      clinicId,
      userId: auditContext.userId,
      actorId: auditContext.userId || 'SYSTEM',
      actorEmail: auditContext.email || 'system',
      action: 'INVOICE_WHATSAPP_SENT',
      resourceType: 'INVOICE',
      resourceId: invoiceId,
      metadata: { invoiceNumber: dto.invoiceNumber, conversationId: conversation.id },
      ipAddress: auditContext.ip,
      userAgent: auditContext.userAgent,
      requestId: auditContext.requestId,
    });

    return { sent: true, invoiceNumber: dto.invoiceNumber, conversationId: conversation.id };
  }

  async getSubscription(clinicId: string) {
    const {
      subscription,
      whatsappUsageAgg,
      aiUsageAgg,
      outboundMessagesCount,
      inboundMessagesCount,
      aiConversationsCount,
      paymentMethod,
    } = await this.repo.getSubscriptionDetails(clinicId);

    const totalConversationsUsed = whatsappUsageAgg._sum.quantity || (outboundMessagesCount > 0 ? outboundMessagesCount : 0);
    const includedLimit = subscription?.plan?.whatsappIncluded || 1000;
    const extraConversations = Math.max(0, totalConversationsUsed - includedLimit);
    const overageRateWhatsApp = Number(subscription?.plan?.overageRateWhatsApp || 0.4);
    const overageCost = extraConversations * overageRateWhatsApp;

    const totalAiTokensUsed = aiUsageAgg._sum.totalTokens || 0;
    const includedAiTokens = subscription?.plan?.aiTokensIncluded || 1000000;
    const extraAiTokens = Math.max(0, totalAiTokensUsed - includedAiTokens);
    const overageRateAi1k = Number(subscription?.plan?.overageRateAi1k || 0.15);
    const aiOverageCost = (extraAiTokens / 1000) * overageRateAi1k;

    const periodEnd = subscription?.currentPeriodEnd
      ? new Date(subscription.currentPeriodEnd)
      : null;
    const nextBillingDate = periodEnd
      ? periodEnd.toISOString().slice(0, 10)
      : new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString().slice(0, 10);

    return {
      subscriptionPlan: subscription?.plan?.name || 'Clinic Growth Enterprise Plan (Full Growth Engine)',
      planBillingCycle: 'Monthly (Auto-renews on 1st)',
      subscriptionCost: Number(subscription?.plan?.priceMonthly || 25000),
      nextBillingDate,
      paymentStatus: subscription?.status || 'Active',
      whatsappApiUsage: {
        conversationsUsed: totalConversationsUsed,
        freeTierLimit: includedLimit,
        costPerExtraConv: overageRateWhatsApp,
        totalCost: overageCost,
        messagesSent: outboundMessagesCount,
        messagesReceived: inboundMessagesCount,
      },
      aiTokenUsage: {
        tokensConsumed: totalAiTokensUsed,
        includedTokens: includedAiTokens,
        costPer1kTokens: overageRateAi1k,
        totalCost: aiOverageCost,
        conversationsHandled: aiConversationsCount,
      },
      paymentMethodOnFile: paymentMethod
        ? {
            type: 'Credit Card',
            last4: paymentMethod.last4,
            expiry: paymentMethod.expiry,
            brand: paymentMethod.brand,
          }
        : {
            type: 'None',
            last4: '',
            expiry: '',
            brand: 'Not on file',
          },
      cloudInvoices: (subscription?.invoices || []).map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        billingPeriod: `${inv.periodStart.toISOString().split('T')[0]} to ${inv.periodEnd.toISOString().split('T')[0]}`,
        planAmount: Number(inv.subtotal),
        whatsappUsageAmount: Number(inv.usageCharges),
        aiUsageAmount: 0,
        totalAmount: Number(inv.total),
        status: inv.status === 'PAID' ? 'Paid' : 'Pending',
        date: inv.issuedAt ? inv.issuedAt.toISOString().split('T')[0] : inv.createdAt.toISOString().split('T')[0],
      })),
    };
  }
}

export const billingService = new BillingService();
