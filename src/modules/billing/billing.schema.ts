/* CGS billing module — Zod request schemas.
 * Clinic API layer for billing; talks Prisma or callers, not the AI database. */
import { z } from 'zod';

export const listInvoicesSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z.string().optional(),
  paymentMethod: z.string().optional(),
  search: z.string().optional(),
  date: z.string().optional(),
  doctorId: z.string().uuid().optional(),
});

export const createInvoiceSchema = z.object({
  patientId: z.string().uuid(),
  service: z.string().optional(),
  items: z
    .array(
      z.object({
        serviceId: z.string().uuid().optional(),
        name: z.string().min(1),
        quantity: z.coerce.number().min(1).default(1),
        unitPrice: z.coerce.number().min(0),
      })
    )
    .min(1),
  discount: z.coerce.number().default(0),
  taxPercent: z.coerce.number().optional(),
  tax: z.coerce.number().optional(),
  paidAmount: z.coerce.number().optional(),
  paymentMethod: z.string().optional(),
  appointmentId: z.string().uuid().optional(),
  treatingDoctorId: z.string().uuid().optional(),
  notes: z.string().optional(),
}).transform((data) => ({
  ...data,
  taxPercent: data.taxPercent !== undefined ? data.taxPercent : (data.tax || 0),
}));

export const collectPaymentSchema = z.object({
  amount: z.coerce.number().positive(),
  paymentMethod: z.preprocess(
    (val) => typeof val === 'string' ? val.toUpperCase().replace(/\s+/g, '_') : val,
    z.enum(['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'OTHER'])
  ).optional(),
  method: z.preprocess(
    (val) => typeof val === 'string' ? val.toUpperCase().replace(/\s+/g, '_') : val,
    z.enum(['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'OTHER'])
  ).optional(),
  referenceNumber: z.string().optional(),
  remarks: z.string().optional(),
  notes: z.string().optional(),
  collectedBy: z.string().optional(),
  staffPasscode: z.string().optional(),
}).transform((data) => ({
  amount: data.amount,
  paymentMethod: (data.paymentMethod || data.method || 'CASH') as 'CASH' | 'UPI' | 'CARD' | 'BANK_TRANSFER' | 'OTHER',
  referenceNumber: data.referenceNumber,
  remarks: data.remarks || data.notes,
  staffPasscode: data.staffPasscode,
}));
