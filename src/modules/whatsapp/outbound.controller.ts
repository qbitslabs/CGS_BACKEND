/* Staff API for the global WhatsApp templates. */
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthenticatedRequest } from '../../types/index.js';
import { AppError } from '../../middleware/errorHandler.js';
import { WHATSAPP_TEMPLATES } from './whatsappTemplates.js';
import { previewTemplateSends, publicTemplate, queueTemplateSends } from './outbound.service.js';

const recipientsSchema = z.object({
  templateKey: z.string().min(1),
  appointmentIds: z.array(z.string().uuid()).max(100).optional(),
  patientIds: z.array(z.string().uuid()).max(100).optional(),
  leadIds: z.array(z.string().uuid()).max(100).optional(),
  invoiceIds: z.array(z.string().uuid()).max(100).optional(),
  clinicId: z.string().uuid().optional(),
});

function assertOwnClinic(req: AuthenticatedRequest, clinicId?: string) {
  if (clinicId && clinicId !== req.clinicId) {
    throw new AppError('Cannot send for another clinic', 403, 'TENANT_MISMATCH');
  }
  return req.clinicId!;
}

const STAFF_TEMPLATE_KEYS = new Set(['BILL', 'OLD_PATIENT_REACTIVATION']);

export const listTemplates = async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json({
      success: true,
      data: WHATSAPP_TEMPLATES.filter((item) => STAFF_TEMPLATE_KEYS.has(item.key)).map(publicTemplate),
    });
  } catch (error) {
    next(error);
  }
};

export const previewOutbound = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const body = recipientsSchema.parse(req.body);
    if (!STAFF_TEMPLATE_KEYS.has(body.templateKey)) {
      throw new AppError(
        'Reminders, follow-ups, missed visits, and landing enquiries are sent automatically',
        403,
        'STAFF_SEND_NOT_ALLOWED'
      );
    }
    const clinicId = assertOwnClinic(req, body.clinicId);
    const data = await previewTemplateSends(clinicId, body.templateKey, body);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const sendOutbound = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const body = recipientsSchema.parse(req.body);
    if (!STAFF_TEMPLATE_KEYS.has(body.templateKey)) {
      throw new AppError(
        'Reminders, follow-ups, missed visits, and landing enquiries are sent automatically',
        403,
        'STAFF_SEND_NOT_ALLOWED'
      );
    }
    const clinicId = assertOwnClinic(req, body.clinicId);
    const data = await queueTemplateSends(clinicId, body.templateKey, body);
    res.status(202).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};
