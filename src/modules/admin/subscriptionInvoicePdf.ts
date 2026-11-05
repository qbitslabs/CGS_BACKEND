/* Subscription invoice PDF for the admin billing screen. */
import PDFDocument from 'pdfkit';

export function subscriptionInvoiceFilename(invoiceNumber: string) {
  const safe = String(invoiceNumber || 'invoice').replace(/[^\w.-]+/g, '-');
  return `Invoice-${safe}.pdf`;
}

function money(amount: number) {
  return `Rs. ${Number(amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function day(value: Date | string | null | undefined) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

export function buildSubscriptionInvoicePdf(invoice: {
  invoiceNumber: string;
  status: string;
  description: string;
  subtotal: number;
  taxAmount: number;
  total: number;
  periodStart: Date | string;
  periodEnd: Date | string;
  dueAt?: Date | string | null;
  clinicName: string;
  clinicEmail?: string | null;
  clinicPhone?: string | null;
  clinicAddress?: string | null;
  planName: string;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk as Buffer));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const navy = '#0c4a6e';
    const ink = '#0f172a';
    const muted = '#64748b';
    const line = '#e2e8f0';

    doc.rect(0, 0, 595, 118).fill(navy);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text('Clinic Growth System', 40, 32);
    doc.font('Helvetica').fontSize(11).fillColor('#bae6fd').text('Platform invoice', 40, 60);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text(invoice.invoiceNumber, 340, 36, { width: 215, align: 'right' });
    doc.font('Helvetica').fontSize(10).text(invoice.status, 340, 58, { width: 215, align: 'right' });
    doc.text(`Due ${day(invoice.dueAt || invoice.periodEnd)}`, 340, 76, { width: 215, align: 'right' });

    doc.fillColor(muted).font('Helvetica-Bold').fontSize(9).text('BILLED TO', 40, 146);
    doc.fillColor(ink).font('Helvetica-Bold').fontSize(13).text(invoice.clinicName, 40, 162, { width: 250 });
    doc.font('Helvetica').fontSize(10).fillColor(muted);
    let y = doc.y + 4;
    for (const lineText of [invoice.clinicAddress, invoice.clinicPhone, invoice.clinicEmail]) {
      if (!lineText) continue;
      doc.text(lineText, 40, y, { width: 250 });
      y = doc.y + 2;
    }

    doc.fillColor(muted).font('Helvetica-Bold').fontSize(9).text('INVOICE DETAILS', 330, 146);
    doc.fillColor(ink).font('Helvetica').fontSize(10);
    doc.text(`Plan: ${invoice.planName}`, 330, 164, { width: 225 });
    doc.text(`Period: ${day(invoice.periodStart)} – ${day(invoice.periodEnd)}`, 330, 182, { width: 225 });

    const tableTop = 250;
    doc.roundedRect(40, tableTop, 515, 36, 6).fill('#f0f9ff');
    doc.fillColor(navy).font('Helvetica-Bold').fontSize(10);
    doc.text('Description', 56, tableTop + 13);
    doc.text('Amount', 400, tableTop + 13, { width: 135, align: 'right' });

    doc.fillColor(ink).font('Helvetica').fontSize(11);
    doc.text(invoice.description, 56, tableTop + 52, { width: 320 });
    doc.font('Helvetica-Bold').text(money(invoice.subtotal), 400, tableTop + 52, { width: 135, align: 'right' });

    const totalsTop = tableTop + 110;
    doc.roundedRect(300, totalsTop, 255, 108, 8).lineWidth(1).strokeColor(line).stroke();
    const row = (label: string, value: string, top: number, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor(bold ? navy : muted);
      doc.text(label, 316, top, { width: 110 });
      doc.fillColor(ink).text(value, 420, top, { width: 115, align: 'right' });
    };
    row('Taxable value', money(invoice.subtotal), totalsTop + 16);
    row('GST 18%', money(invoice.taxAmount), totalsTop + 40);
    doc.moveTo(316, totalsTop + 66).lineTo(539, totalsTop + 66).strokeColor(line).stroke();
    row('Total payable', money(invoice.total), totalsTop + 78, true);

    doc.font('Helvetica').fontSize(9).fillColor(muted).text(
      'This is a computer-generated invoice from Clinic Growth System. GST is charged at 18% on the taxable value.',
      40,
      760,
      { width: 515 }
    );
    doc.end();
  });
}
