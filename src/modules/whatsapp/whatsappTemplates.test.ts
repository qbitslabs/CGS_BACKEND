import { describe, expect, it } from 'vitest';
import { AppError } from '../../middleware/errorHandler.js';
import {
  WHATSAPP_TEMPLATES,
  assertAccountBelongsToClinic,
  assertTemplateUsable,
  buildMetaTemplatePayload,
  fillTemplatePreview,
  findTemplate,
  idempotencyKey,
  isCustomerCareWindowClosed,
  shouldSkipAcceptedSend,
} from './whatsappTemplates.js';

describe('global WhatsApp templates', () => {
  it('allows an approved template with the right number of parameters', () => {
    const template = findTemplate('REMINDER');
    expect(() => assertTemplateUsable(template, ['Ana', 'City Clinic', 'Dr. Shah', '06 Oct 2026', '4:00 pm'])).not.toThrow();
  });

  it('rejects pending, rejected, and disabled templates', () => {
    const template = { ...findTemplate('FOLLOWUP'), status: 'PENDING' as const };
    expect(() => assertTemplateUsable(template, ['a', 'b', 'c', 'd'])).toThrow(AppError);
    expect(() => assertTemplateUsable({ ...template, status: 'REJECTED' }, ['a', 'b', 'c', 'd'])).toThrow(/REJECTED/);
    expect(() => assertTemplateUsable({ ...template, status: 'DISABLED' }, ['a', 'b', 'c', 'd'])).toThrow(/DISABLED/);
  });

  it('rejects a missing parameter and the wrong parameter count', () => {
    const template = findTemplate('MISSED_APPOINTMENT');
    expect(() => assertTemplateUsable(template, ['Ana', 'Clinic', 'Dr. Shah', '06 Oct 2026'])).toThrow(/needs 5/);
    expect(() => assertTemplateUsable(template, ['Ana', '', 'Dr. Shah', '06 Oct 2026', '4:00 pm'])).toThrow(/Missing parameter/);
  });

  it('keeps reminder and missed appointment on the session-first path', () => {
    expect(findTemplate('REMINDER').trySessionFirst).toBe(true);
    expect(findTemplate('MISSED_APPOINTMENT').trySessionFirst).toBe(true);
    expect(findTemplate('FOLLOWUP').trySessionFirst).toBe(false);
    expect(findTemplate('OLD_PATIENT_REACTIVATION').trySessionFirst).toBe(false);
    expect(findTemplate('LANDING_ENQUIRY').trySessionFirst).toBe(false);
    expect(findTemplate('LANDING_ENQUIRY').recipientKind).toBe('lead');
    expect(findTemplate('BILL').trySessionFirst).toBe(true);
    expect(findTemplate('BILL').documentHeader).toBe(true);
    expect(findTemplate('BILL').recipientKind).toBe('invoice');
    expect(WHATSAPP_TEMPLATES).toHaveLength(6);
  });

  it('refuses another clinic WhatsApp account', () => {
    expect(() => assertAccountBelongsToClinic('clinic-b', 'clinic-a')).toThrow(/does not belong/);
    expect(() => assertAccountBelongsToClinic('clinic-a', 'clinic-a')).not.toThrow();
  });

  it('builds a Meta template payload and detects a closed chat window', () => {
    const payload = buildMetaTemplatePayload({
      recipientPhone: '+91 98765 43210',
      templateName: 'cgs_appointment_reminder',
      languageCode: 'en',
      bodyParameters: ['Ana', 'City Clinic'],
    });
    expect(payload.type).toBe('template');
    expect(payload.to).toBe('919876543210');
    expect(payload.template.components[0].parameters.map((item) => item.text)).toEqual(['Ana', 'City Clinic']);
    expect(isCustomerCareWindowClosed(131047, '')).toBe(true);
    expect(isCustomerCareWindowClosed(undefined, 'Re-engagement message')).toBe(true);
    expect(isCustomerCareWindowClosed(131026, 'Message undeliverable')).toBe(false);
  });

  it('puts the invoice media id in the document header', () => {
    const payload = buildMetaTemplatePayload({
      recipientPhone: '919876543210',
      templateName: 'cgs_invoice_bill',
      languageCode: 'en',
      bodyParameters: ['Riya Sharma', 'City Clinic', 'INV-2026-0001', 'Rs. 1,200'],
      document: { mediaId: 'media-123', filename: 'Invoice-INV-2026-0001.pdf' },
    });
    expect(payload.template.components[0]).toEqual({
      type: 'header',
      parameters: [
        {
          type: 'document',
          document: { id: 'media-123', filename: 'Invoice-INV-2026-0001.pdf' },
        },
      ],
    });
    expect(payload.template.components[1].parameters.map((item) => item.text)).toEqual([
      'Riya Sharma',
      'City Clinic',
      'INV-2026-0001',
      'Rs. 1,200',
    ]);
  });

  it('gives each recipient a separate idempotency key and skips a send Meta already accepted', () => {
    const first = idempotencyKey({
      clinicId: 'clinic-a',
      templateKey: 'REMINDER',
      phone: '9198',
      recordId: 'apt-1',
      day: '2026-10-06',
    });
    const second = idempotencyKey({
      clinicId: 'clinic-a',
      templateKey: 'REMINDER',
      phone: '9199',
      recordId: 'apt-2',
      day: '2026-10-06',
    });
    expect(first).not.toBe(second);
    expect(shouldSkipAcceptedSend('wamid.1')).toBe(true);
    expect(shouldSkipAcceptedSend(null)).toBe(false);
    expect(fillTemplatePreview(findTemplate('FOLLOWUP').bodyText, ['Ana', 'City Clinic', 'Dr. Shah', '06 Oct 2026'])).toContain('Ana');
  });
});
