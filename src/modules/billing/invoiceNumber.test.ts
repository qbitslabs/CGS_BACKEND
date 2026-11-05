import { describe, expect, it } from 'vitest';
import { nextInvoiceNumber } from './invoiceNumber.js';

describe('nextInvoiceNumber', () => {
  it('starts at 0001 when the clinic has no invoices this year', () => {
    expect(nextInvoiceNumber(['INV-2025-0004'], 2026)).toBe('INV-2026-0001');
  });

  it('continues after the highest number, including gaps left by a missing invoice', () => {
    expect(
      nextInvoiceNumber(['INV-2026-0001', 'INV-2026-0002', 'INV-2026-0005'], 2026),
    ).toBe('INV-2026-0006');
  });

  it('does not reuse a number just because the invoice count is lower than that sequence', () => {
    expect(nextInvoiceNumber(['INV-2025-0001', 'INV-2026-0005'], 2026)).toBe('INV-2026-0006');
  });
});
