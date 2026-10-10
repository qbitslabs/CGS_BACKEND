/* Six global WhatsApp templates. Wording is approved in Meta.
 * CGS only fills {{1}}, {{2}}, ... from clinic records. */
import { AppError } from '../../middleware/errorHandler.js';

export const WHATSAPP_TEMPLATE_SEND_JOB = 'WHATSAPP_TEMPLATE_SEND';

export type TemplateStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'DISABLED';
export type TemplateParamSource =
  | 'patientName'
  | 'clinicName'
  | 'doctorName'
  | 'appointmentDate'
  | 'appointmentTime'
  | 'lastVisitDate'
  | 'interestedService'
  | 'preferredDoctor'
  | 'invoiceNumber'
  | 'invoiceAmount';

export interface WhatsAppTemplateDefinition {
  key: 'REMINDER' | 'FOLLOWUP' | 'OLD_PATIENT_REACTIVATION' | 'MISSED_APPOINTMENT' | 'LANDING_ENQUIRY' | 'BILL';
  purpose: string;
  metaName: string;
  languageCode: string;
  status: TemplateStatus;
  trySessionFirst: boolean;
  recipientKind: 'appointment' | 'patient' | 'lead' | 'invoice';
  /** Document header. The PDF is uploaded to Meta at send time and the returned media id is placed in the template. */
  documentHeader?: boolean;
  body: Array<{ source: TemplateParamSource; label: string }>;
  bodyText: string;
}

export const WHATSAPP_TEMPLATES: WhatsAppTemplateDefinition[] = [
  {
    key: 'REMINDER',
    purpose: 'Appointment reminder',
    metaName: 'cgs_appointment_reminder',
    languageCode: 'en',
    status: 'APPROVED',
    trySessionFirst: true,
    recipientKind: 'appointment',
    body: [
      { source: 'patientName', label: 'Patient name' },
      { source: 'clinicName', label: 'Clinic name' },
      { source: 'doctorName', label: 'Doctor name' },
      { source: 'appointmentDate', label: 'Appointment date' },
      { source: 'appointmentTime', label: 'Appointment time' },
    ],
    bodyText:
      'Hello {{1}}, this is a reminder from {{2}}. Your appointment with {{3}} is on {{4}} at {{5}}.',
  },
  {
    key: 'FOLLOWUP',
    purpose: 'Appointment follow-up',
    metaName: 'cgs_appointment_followup',
    languageCode: 'en',
    status: 'APPROVED',
    trySessionFirst: false,
    recipientKind: 'appointment',
    body: [
      { source: 'patientName', label: 'Patient name' },
      { source: 'clinicName', label: 'Clinic name' },
      { source: 'doctorName', label: 'Doctor name' },
      { source: 'appointmentDate', label: 'Appointment date' },
    ],
    bodyText: 'Hello {{1}}, this is {{2}} following up after your visit with {{3}} on {{4}}.',
  },
  {
    key: 'OLD_PATIENT_REACTIVATION',
    purpose: 'Old patient reactivation',
    metaName: 'cgs_patient_reactivation',
    languageCode: 'en',
    status: 'APPROVED',
    trySessionFirst: false,
    recipientKind: 'patient',
    body: [
      { source: 'patientName', label: 'Patient name' },
      { source: 'clinicName', label: 'Clinic name' },
      { source: 'lastVisitDate', label: 'Last visit date' },
    ],
    bodyText: 'Hello {{1}}, this is {{2}}. We would like to welcome you back. Your last visit was on {{3}}.',
  },
  {
    key: 'MISSED_APPOINTMENT',
    purpose: 'Missed appointment follow-up',
    metaName: 'cgs_missed_appointment',
    languageCode: 'en',
    status: 'APPROVED',
    trySessionFirst: true,
    recipientKind: 'appointment',
    body: [
      { source: 'patientName', label: 'Patient name' },
      { source: 'clinicName', label: 'Clinic name' },
      { source: 'doctorName', label: 'Doctor name' },
      { source: 'appointmentDate', label: 'Appointment date' },
      { source: 'appointmentTime', label: 'Appointment time' },
    ],
    bodyText:
      'Hello {{1}}, this is {{2}}. We missed you for your appointment with {{3}} on {{4}} at {{5}}.',
  },
  {
    key: 'LANDING_ENQUIRY',
    purpose: 'Landing page enquiry',
    metaName: 'cgs_landing_enquiry',
    languageCode: 'en',
    status: 'APPROVED',
    trySessionFirst: false,
    recipientKind: 'lead',
    body: [
      { source: 'patientName', label: 'Name' },
      { source: 'clinicName', label: 'Clinic name' },
      { source: 'interestedService', label: 'Service they asked for' },
      { source: 'preferredDoctor', label: 'Preferred doctor' },
    ],
    bodyText:
      'Hello {{1}}, this is {{2}}. We received your request for {{3}} with {{4}}. Reply here and we will help you book a time.',
  },
  {
    key: 'BILL',
    purpose: 'Bill with PDF',
    metaName: 'cgs_invoice_bill',
    languageCode: 'en',
    status: 'APPROVED',
    trySessionFirst: true,
    recipientKind: 'invoice',
    documentHeader: true,
    body: [
      { source: 'patientName', label: 'Patient name' },
      { source: 'clinicName', label: 'Clinic name' },
      { source: 'invoiceNumber', label: 'Invoice number' },
      { source: 'invoiceAmount', label: 'Bill amount' },
    ],
    bodyText: 'Hello {{1}}, this is {{2}}. Your bill {{3}} for {{4}} is attached as a PDF.',
  },
];

export function findTemplate(key: string): WhatsAppTemplateDefinition {
  const template = WHATSAPP_TEMPLATES.find((item) => item.key === key);
  if (!template) {
    throw new AppError('Template not found', 404, 'TEMPLATE_NOT_FOUND');
  }
  return template;
}

export function assertTemplateUsable(template: WhatsAppTemplateDefinition, parameters: string[]) {
  if (template.status !== 'APPROVED') {
    throw new AppError(`Template is ${template.status} and cannot be sent`, 409, 'TEMPLATE_NOT_APPROVED');
  }
  if (!template.languageCode || template.languageCode.length < 2) {
    throw new AppError('Template language is invalid', 400, 'INVALID_LANGUAGE');
  }
  if (parameters.length !== template.body.length) {
    throw new AppError(
      `Template ${template.key} needs ${template.body.length} parameters`,
      400,
      'PARAMETER_COUNT'
    );
  }
  parameters.forEach((value, index) => {
    if (!String(value || '').trim()) {
      throw new AppError(`Missing parameter {{${index + 1}}} (${template.body[index].label})`, 400, 'MISSING_PARAMETER');
    }
  });
}

export function fillTemplatePreview(bodyText: string, parameters: string[]): string {
  return parameters.reduce((text, value, index) => text.split(`{{${index + 1}}}`).join(value), bodyText);
}

export function buildMetaTemplatePayload(input: {
  recipientPhone: string;
  templateName: string;
  languageCode: string;
  bodyParameters: string[];
  document?: { mediaId: string; filename: string };
}) {
  const components: Array<{
    type: 'header' | 'body';
    parameters: Array<{ type: string; text?: string; document?: { id: string; filename: string } }>;
  }> = [];
  if (input.document?.mediaId) {
    components.push({
      type: 'header',
      parameters: [
        {
          type: 'document',
          document: {
            id: input.document.mediaId,
            filename: input.document.filename,
          },
        },
      ],
    });
  }
  components.push({
    type: 'body',
    parameters: input.bodyParameters.map((text) => ({ type: 'text', text })),
  });
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: input.recipientPhone.replace(/\D/g, ''),
    type: 'template' as const,
    template: {
      name: input.templateName,
      language: { code: input.languageCode },
      components,
    },
  };
}

export function isCustomerCareWindowClosed(metaCode?: number, message?: string): boolean {
  if (metaCode === 131047 || metaCode === 470) return true;
  const text = (message || '').toLowerCase();
  return text.includes('re-engagement') || text.includes('24 hour') || text.includes('24-hour') || text.includes('customer care window');
}

export function assertAccountBelongsToClinic(accountClinicId: string, requestClinicId: string) {
  if (!accountClinicId || accountClinicId !== requestClinicId) {
    throw new AppError('WhatsApp account does not belong to this clinic', 403, 'TENANT_MISMATCH');
  }
}

export function canonicalPhone(raw: string): string {
  let phone = String(raw || '').replace(/\D/g, '');
  if (phone.length === 10) phone = `91${phone}`;
  return phone;
}

export function assertRecipientPhone(raw: string): string {
  const phone = canonicalPhone(raw);
  if (phone.length < 8) {
    throw new AppError('Recipient phone is invalid', 400, 'INVALID_RECIPIENT');
  }
  return phone;
}

export function idempotencyKey(parts: {
  clinicId: string;
  templateKey: string;
  phone: string;
  recordId: string;
  day: string;
}): string {
  return [parts.clinicId, parts.templateKey, parts.phone, parts.recordId, parts.day].join(':');
}

export function kolkataDay(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function formatClinicDate(value: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(value);
}

export function formatClinicTime(value: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(value);
}

export function shouldSkipAcceptedSend(providerMessageId?: string | null): boolean {
  return Boolean(providerMessageId && !providerMessageId.startsWith('pending:'));
}
