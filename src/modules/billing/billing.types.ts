/* CGS billing module — TypeScript types.
 * Clinic API layer for billing; talks Prisma or callers, not the AI database. */
import { PaymentMethod } from '@prisma/client';

export interface InvoiceListQuery {
  clinicId: string;
  page?: number;
  limit?: number;
  status?: string;
  search?: string;
  paymentMethod?: string;
  date?: string;
  doctorId?: string;
  createdByUserId?: string;
}

export interface InvoiceItemDTO {
  serviceId?: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

export interface CreateInvoiceDTO {
  patientId: string;
  service?: string;
  items: InvoiceItemDTO[];
  discount?: number;
  taxPercent?: number;
  paidAmount?: number;
  paymentMethod?: string;
  appointmentId?: string;
  treatingDoctorId?: string;
  notes?: string;
}

export interface CollectPaymentDTO {
  amount: number;
  paymentMethod: PaymentMethod;
  referenceNumber?: string;
  remarks?: string;
  staffPasscode?: string;
}
