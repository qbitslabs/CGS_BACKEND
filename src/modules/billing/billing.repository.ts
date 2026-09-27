/* CGS billing module — Prisma queries.
 * Clinic API layer for billing; talks Prisma or callers, not the AI database. */
import { prisma } from '../../config/db.js';
import { InvoiceListQuery } from './billing.types.js';
import { clinicDayBoundsUtc } from '../../utils/timezone.js';
import { Prisma } from '@prisma/client';

export class BillingRepository {
  async getRevenueSummary(clinicId: string, doctorId?: string) {
    const invoiceScope = doctorId
      ? {
          OR: [
            { treatingDoctorId: doctorId },
            { patient: { appointments: { some: { doctorId } } } },
          ],
        }
      : {};
    const [totalRevenueAgg, pendingInvoicesCount, paidInvoicesCount, pendingDueAgg] =
      await Promise.all([
        prisma.payment.aggregate({
          where: { clinicId, status: 'COMPLETED', ...(doctorId ? { invoice: invoiceScope } : {}) },
          _sum: { amount: true },
        }),
        prisma.invoice.count({
          where: { clinicId, status: { in: ['ISSUED', 'PARTIALLY_PAID'] }, ...invoiceScope },
        }),
        prisma.invoice.count({
          where: { clinicId, status: 'PAID', ...invoiceScope },
        }),
        prisma.invoice.aggregate({
          where: { clinicId, status: { in: ['ISSUED', 'PARTIALLY_PAID'] }, ...invoiceScope },
          _sum: { amountDue: true },
        }),
      ]);

    return {
      totalRevenue: Number(totalRevenueAgg._sum.amount || 0),
      pendingPayments: pendingInvoicesCount,
      paidInvoicesCount: paidInvoicesCount,
      outstandingAmount: Number(pendingDueAgg._sum.amountDue || 0),
    };
  }

  async countInvoices(query: InvoiceListQuery) {
    const where = this.buildInvoiceWhere(query);
    return prisma.invoice.count({ where });
  }

  async findInvoices(query: InvoiceListQuery) {
    const where = this.buildInvoiceWhere(query);
    const page = query.page || 1;
    const limit = query.limit || 20;

    return prisma.invoice.findMany({
      where,
      include: {
        patient: true,
        items: true,
        payments: true,
        treatingDoctor: { select: { specialization: true, user: { select: { firstName: true, lastName: true } } } },
        clinic: { select: { name: true, address: true, city: true, postalCode: true, phone: true, email: true, gstin: true } },
      },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findInvoiceById(id: string, clinicId: string) {
    return prisma.invoice.findFirst({
      where: { id, clinicId },
      include: {
        patient: true,
        items: true,
        payments: { include: { collectedBy: true } },
        treatingDoctor: { select: { specialization: true, user: { select: { firstName: true, lastName: true } } } },
        clinic: { select: { name: true, address: true, city: true, postalCode: true, phone: true, email: true, gstin: true } },
      },
    });
  }

  async createInvoiceInTx(params: {
    clinicId: string;
    patientId: string;
    service: string;
    subtotal: number;
    discount: number;
    tax: number;
    total: number;
    notes?: string;
    createdByUserId?: string;
    items: any[];
    actorName: string;
    paidAmount?: number;
    paymentMethod?: string;
    treatingDoctorId?: string;
  }) {
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM clinics WHERE id = ${params.clinicId}::uuid FOR UPDATE`);

      const count = await tx.invoice.count({ where: { clinicId: params.clinicId } });
      const year = new Date().getFullYear();
      const invoiceNumber = `INV-${year}-${String(count + 1).padStart(4, '0')}`;

      const paidAmount = Math.max(0, params.total);
      const amountDue = 0;
      const status = 'PAID';
      const normalizedMethod = params.paymentMethod
        ? params.paymentMethod.toUpperCase().replace(/\s+/g, '_')
        : undefined;

      const created = await tx.invoice.create({
        data: {
          clinicId: params.clinicId,
          patientId: params.patientId,
          invoiceNumber,
          service: params.service,
          status,
          subtotal: params.subtotal,
          discount: params.discount,
          tax: params.tax,
          total: params.total,
          amountPaid: paidAmount,
          amountDue,
          paymentMethod: normalizedMethod as any,
          notes: params.notes,
          issuedAt: new Date(),
          createdByUserId: params.createdByUserId,
          treatingDoctorId: params.treatingDoctorId,
        },
      });

      await tx.invoiceItem.createMany({
        data: params.items.map((it) => ({
          invoiceId: created.id,
          serviceId: it.serviceId,
          name: it.name,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          total: it.quantity * it.unitPrice,
        })),
      });

      if (paidAmount > 0) {
        await tx.payment.create({
          data: {
            clinicId: params.clinicId,
            invoiceId: created.id,
            patientId: params.patientId,
            amount: paidAmount,
            method: (normalizedMethod || 'CASH') as any,
            status: 'COMPLETED',
            remarks: 'Payment received at invoice creation',
            collectedByUserId: params.createdByUserId,
          },
        });
      }

      await tx.patientActivity.create({
        data: {
          patientId: params.patientId,
          type: 'note',
          title: 'Invoice Generated',
          description: `Invoice ${invoiceNumber} created and payment received for ₹${params.total.toLocaleString('en-IN')}`,
          actor: params.actorName,
        },
      });

      return created;
    });
  }

  async collectPaymentInTx(params: {
    clinicId: string;
    invoiceId: string;
    patientId: string;
    amount: number;
    method: any;
    referenceNumber?: string;
    remarks?: string;
    staffPasscode?: string;
    collectedByUserId?: string;
    actorName: string;
    invoiceNumber: string;
    newPaid: number;
    newDue: number;
    newStatus: any;
  }) {
    return prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          clinicId: params.clinicId,
          invoiceId: params.invoiceId,
          patientId: params.patientId,
          amount: params.amount,
          method: params.method,
          status: 'COMPLETED',
          referenceNumber: params.referenceNumber,
          remarks: params.remarks,
          collectedByUserId: params.collectedByUserId,
        },
      });

      if (params.staffPasscode) {
        await tx.paymentAuthorization.create({
          data: {
            clinicId: params.clinicId,
            paymentId: payment.id,
            authorizedByUserId: params.collectedByUserId || params.patientId,
            passcodeVerified: true,
            reason: `Front-desk collected by ${params.actorName}`,
          },
        });
      }

      const updated = await tx.invoice.update({
        where: { id: params.invoiceId },
        data: {
          amountPaid: params.newPaid,
          amountDue: params.newDue,
          status: params.newStatus,
          paymentMethod: params.method,
        },
      });

      await tx.patientActivity.create({
        data: {
          patientId: params.patientId,
          type: 'note',
          title: 'Payment Received',
          description: `Collected ₹${params.amount.toLocaleString('en-IN')} via ${params.method} for ${params.invoiceNumber}`,
          actor: params.actorName,
        },
      });

      return updated;
    });
  }

  async getSubscriptionDetails(clinicId: string) {
    const [
      subscription,
      whatsappUsageAgg,
      aiUsageAgg,
      outboundMessagesCount,
      inboundMessagesCount,
      aiConversationsCount,
      paymentMethod,
    ] = await Promise.all([
      prisma.cgsSubscription.findFirst({
        where: { clinicId },
        include: {
          plan: true,
          invoices: { orderBy: { periodStart: 'desc' }, take: 5 },
        },
      }),
      prisma.whatsAppUsage.aggregate({
        where: { clinicId },
        _sum: { quantity: true, totalCost: true },
        _count: true,
      }),
      prisma.aiUsage.aggregate({
        where: { clinicId },
        _sum: { totalTokens: true, totalCost: true },
        _count: true,
      }),
      prisma.message.count({
        where: { clinicId, direction: 'OUTBOUND' },
      }),
      prisma.message.count({
        where: { clinicId, direction: 'INBOUND' },
      }),
      prisma.conversation.count({
        where: { clinicId },
      }),
      prisma.paymentMethodRecord.findFirst({
        where: { clinicId, isDefault: true },
      }),
    ]);

    return {
      subscription,
      whatsappUsageAgg,
      aiUsageAgg,
      outboundMessagesCount,
      inboundMessagesCount,
      aiConversationsCount,
      paymentMethod,
    };
  }

  private buildInvoiceWhere(query: InvoiceListQuery) {
    const where: any = { clinicId: query.clinicId };
    if (query.status && query.status !== 'All') {
      const raw = query.status.toUpperCase().replace(/[\s-]+/g, '_');
      const statusMap: Record<string, string> = {
        PENDING: 'ISSUED',
        ISSUED: 'ISSUED',
        PAID: 'PAID',
        PARTIALLY_PAID: 'PARTIALLY_PAID',
        DRAFT: 'DRAFT',
        CANCELLED: 'VOID',
        CANCELED: 'VOID',
        VOID: 'VOID',
        REFUNDED: 'VOID',
      };
      where.status = statusMap[raw] || raw;
    }
    if (query.paymentMethod && query.paymentMethod !== 'All') {
      where.paymentMethod = query.paymentMethod.toUpperCase().replace(/[\s-]+/g, '_');
    }
    if (query.search) {
      where.OR = [
        { invoiceNumber: { contains: query.search, mode: 'insensitive' } },
        { patient: { name: { contains: query.search, mode: 'insensitive' } } },
        { patient: { phone: { contains: query.search } } },
      ];
    }
    if (query.doctorId) {
      const doctorClause = {
        OR: [
          { treatingDoctorId: query.doctorId },
          ...(query.createdByUserId ? [{ createdByUserId: query.createdByUserId }] : []),
          { patient: { appointments: { some: { doctorId: query.doctorId } } } },
        ],
      };
      where.AND = [...(where.AND || []), doctorClause];
    }
    if (query.date) {
      const { start, end } = clinicDayBoundsUtc(query.date);
      const dateClause = {
        OR: [
          { issuedAt: { gte: start, lte: end } },
          { AND: [{ issuedAt: null }, { createdAt: { gte: start, lte: end } }] },
        ],
      };
      where.AND = [...(where.AND || []), dateClause];
    }
    return where;
  }

  async findConversationForPatient(clinicId: string, patientId: string, phones: string[]) {
    return prisma.conversation.findFirst({
      where: {
        clinicId,
        OR: [
          { patientId },
          ...(phones.length ? [{ participantPhone: { in: phones } }] : []),
        ],
      },
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async createConversationForPatient(params: {
    clinicId: string;
    patientId: string;
    participantName: string;
    participantPhone: string;
    whatsappAccountId?: string;
    lastMessageText: string;
  }) {
    return prisma.conversation.create({
      data: {
        clinicId: params.clinicId,
        patientId: params.patientId,
        whatsappAccountId: params.whatsappAccountId,
        participantName: params.participantName,
        participantPhone: params.participantPhone,
        state: 'HUMAN_ACTIVE',
        unreadCount: 0,
        lastMessageText: params.lastMessageText,
        lastMessageAt: new Date(),
        lastActivityAt: new Date(),
      },
    });
  }

  async findActiveWhatsappAccount(clinicId: string) {
    return prisma.whatsappAccount.findFirst({
      where: { clinicId, isActive: true },
    });
  }
}

export const billingRepository = new BillingRepository();
