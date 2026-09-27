/* Builds a clinic tax-invoice PDF for WhatsApp delivery.
 * Mirrors the printable billing invoice; no tool names or internals. */
import PDFDocument from 'pdfkit';

export type InvoicePdfInput = {
  invoiceNumber: string;
  clinicName?: string;
  clinicAddress?: string;
  clinicPhone?: string;
  clinicEmail?: string;
  clinicGstin?: string;
  patientName: string;
  patientPhone?: string;
  patientEmail?: string;
  service?: string;
  services?: Array<{ name: string; quantity: number; unitPrice: number; total: number }>;
  subtotal: number;
  discount: number;
  tax: number;
  taxPercent?: number;
  total: number;
  paidAmount: number;
  remainingAmount: number;
  paymentStatus: string;
  paymentMethod: string;
  date: string;
  dueDate?: string;
  notes?: string;
  treatingDoctorName?: string;
  treatingDoctorSpecialization?: string;
};

function money(n: number): string {
  return `Rs. ${Number(n || 0).toLocaleString('en-IN')}`;
}

export function invoicePdfFilename(invoiceNumber: string): string {
  const safe = String(invoiceNumber || 'invoice').replace(/[^\w.-]+/g, '-');
  return `Invoice-${safe}.pdf`;
}

function stack(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  width: number,
  lines: Array<{ text?: string; font?: string; size?: number; color?: string; gap?: number }>
) {
  let cy = y;
  for (const line of lines) {
    if (!line.text) continue;
    const font = line.font || 'Helvetica';
    const size = line.size || 9;
    const color = line.color || '#0f172a';
    doc.font(font).fontSize(size).fillColor(color);
    const h = doc.heightOfString(line.text, { width });
    doc.text(line.text, x, cy, { width, lineGap: 1 });
    cy += h + (line.gap ?? 5);
  }
  return cy;
}

export function buildInvoicePdf(inv: InvoicePdfInput): Promise<Buffer> {
  const clinic = inv.clinicName || 'Clinic';
  const items = inv.services?.length
    ? inv.services
    : inv.service
      ? [{ name: inv.service, quantity: 1, unitPrice: inv.total, total: inv.total }]
      : [];

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 28 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c as Buffer));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const teal = '#0f766e';
    const ink = '#0f172a';
    const muted = '#64748b';
    const body = '#475569';
    const pageW = doc.page.width;
    const pageH = doc.page.height;

    const cardX = 28;
    const cardY = 28;
    const cardW = pageW - 56;
    const cardH = pageH - 56;
    doc.roundedRect(cardX, cardY, cardW, cardH, 8).lineWidth(1.2).strokeColor('#94a3b8').stroke();
    doc.roundedRect(cardX + 1, cardY + 1, cardW - 2, cardH - 2, 7).lineWidth(0.4).strokeColor('#e2e8f0').stroke();

    const left = cardX + 22;
    const right = cardX + cardW - 22;
    const innerW = right - left;
    const colGap = 16;
    const colW = (innerW - colGap) / 2;
    const rightColX = left + colW + colGap;

    let y = cardY + 22;
    const headerBottom = stack(doc, left, y, colW, [
      { text: clinic, font: 'Helvetica-Bold', size: 16, color: teal, gap: 6 },
      { text: inv.clinicAddress, font: 'Helvetica', size: 9, color: muted, gap: 3 },
      {
        text: [inv.clinicPhone && `Phone: ${inv.clinicPhone}`, inv.clinicEmail && `Email: ${inv.clinicEmail}`]
          .filter(Boolean)
          .join('  |  '),
        font: 'Helvetica',
        size: 8,
        color: muted,
        gap: 3,
      },
      { text: inv.clinicGstin ? `GSTIN: ${inv.clinicGstin}` : undefined, font: 'Helvetica-Bold', size: 8, color: muted },
    ]);

    const metaBottom = stack(doc, rightColX, y, colW, [
      { text: 'TAX INVOICE', font: 'Helvetica-Bold', size: 13, color: ink, gap: 4 },
      { text: inv.invoiceNumber, font: 'Helvetica-Bold', size: 11, color: teal, gap: 4 },
      { text: inv.paymentStatus, font: 'Helvetica', size: 10, color: ink, gap: 3 },
      { text: `Invoice Date: ${inv.date}`, font: 'Helvetica', size: 8, color: muted },
    ]);

    y = Math.max(headerBottom, metaBottom) + 12;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(teal).lineWidth(2).stroke();
    y += 14;

    const infoTop = y;
    const infoPad = 12;
    const infoInnerTop = infoTop + infoPad;
    const leftInfoBottom = stack(doc, left + infoPad, infoInnerTop, colW - infoPad, [
      { text: 'PATIENT DETAILS', font: 'Helvetica-Bold', size: 8, color: muted, gap: 6 },
      { text: inv.patientName, font: 'Helvetica-Bold', size: 11, color: ink, gap: 4 },
      { text: inv.patientPhone ? `Phone: ${inv.patientPhone}` : undefined, font: 'Helvetica', size: 9, color: body, gap: 3 },
      { text: inv.patientEmail ? `Email: ${inv.patientEmail}` : undefined, font: 'Helvetica', size: 8, color: muted },
    ]);
    const rightInfoBottom = stack(doc, rightColX, infoInnerTop, colW - infoPad, [
      { text: 'DOCTOR & PAYMENT', font: 'Helvetica-Bold', size: 8, color: muted, gap: 6 },
      { text: inv.treatingDoctorName, font: 'Helvetica-Bold', size: 11, color: ink, gap: 4 },
      {
        text: inv.treatingDoctorSpecialization,
        font: 'Helvetica',
        size: 8,
        color: muted,
        gap: 4,
      },
      { text: inv.service || 'Clinical treatment', font: 'Helvetica', size: 9, color: body, gap: 3 },
      { text: `Mode: ${inv.paymentMethod}`, font: 'Helvetica', size: 9, color: body, gap: 3 },
      { text: inv.dueDate ? `Due: ${inv.dueDate}` : undefined, font: 'Helvetica', size: 8, color: muted },
    ]);
    const infoBottom = Math.max(leftInfoBottom, rightInfoBottom) + 8;
    doc.save();
    doc.roundedRect(left, infoTop, innerW, infoBottom - infoTop, 6).fillAndStroke('#f8fafc', '#e2e8f0');
    doc.restore();
    stack(doc, left + infoPad, infoInnerTop, colW - infoPad, [
      { text: 'PATIENT DETAILS', font: 'Helvetica-Bold', size: 8, color: muted, gap: 6 },
      { text: inv.patientName, font: 'Helvetica-Bold', size: 11, color: ink, gap: 4 },
      { text: inv.patientPhone ? `Phone: ${inv.patientPhone}` : undefined, font: 'Helvetica', size: 9, color: body, gap: 3 },
      { text: inv.patientEmail ? `Email: ${inv.patientEmail}` : undefined, font: 'Helvetica', size: 8, color: muted },
    ]);
    stack(doc, rightColX, infoInnerTop, colW - infoPad, [
      { text: 'DOCTOR & PAYMENT', font: 'Helvetica-Bold', size: 8, color: muted, gap: 6 },
      { text: inv.treatingDoctorName, font: 'Helvetica-Bold', size: 11, color: ink, gap: 4 },
      { text: inv.treatingDoctorSpecialization, font: 'Helvetica', size: 8, color: muted, gap: 4 },
      { text: inv.service || 'Clinical treatment', font: 'Helvetica', size: 9, color: body, gap: 3 },
      { text: `Mode: ${inv.paymentMethod}`, font: 'Helvetica', size: 9, color: body, gap: 3 },
      { text: inv.dueDate ? `Due: ${inv.dueDate}` : undefined, font: 'Helvetica', size: 8, color: muted },
    ]);

    y = infoBottom + 16;
    const qtyX = left + innerW * 0.58;
    const unitX = left + innerW * 0.70;
    const totalX = left + innerW * 0.84;
    const descW = qtyX - left - 10;
    doc.rect(left, y, innerW, 22).fill(teal);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
    doc.text('PROCEDURE / TREATMENT', left + 8, y + 7, { width: descW });
    doc.text('QTY', qtyX, y + 7, { width: unitX - qtyX, align: 'center' });
    doc.text('UNIT (Rs.)', unitX, y + 7, { width: totalX - unitX, align: 'right' });
    doc.text('TOTAL (Rs.)', totalX, y + 7, { width: right - totalX, align: 'right' });
    y += 28;

    if (!items.length) {
      doc.font('Helvetica').fontSize(9).fillColor(ink).text('No line items', left + 8, y, { width: descW });
      y += 18;
    } else {
      items.forEach((item, idx) => {
        const label = `${idx + 1}. ${item.name}`;
        doc.font('Helvetica').fontSize(9).fillColor(ink);
        const rowH = Math.max(18, doc.heightOfString(label, { width: descW }) + 6);
        if (y + rowH > cardY + cardH - 120) {
          doc.addPage();
          y = cardY + 22;
        }
        doc.text(label, left + 8, y, { width: descW });
        doc.text(String(item.quantity), qtyX, y, { width: unitX - qtyX, align: 'center' });
        doc.text(Number(item.unitPrice).toLocaleString('en-IN'), unitX, y, { width: totalX - unitX, align: 'right' });
        doc.font('Helvetica-Bold').text(Number(item.total).toLocaleString('en-IN'), totalX, y, {
          width: right - totalX,
          align: 'right',
        });
        y += rowH;
        doc.moveTo(left, y - 2).lineTo(right, y - 2).strokeColor('#e2e8f0').lineWidth(0.4).stroke();
      });
    }

    y += 14;
    const totalsW = 210;
    const totalsX = right - totalsW;
    const totalsLines = [
      { label: 'Subtotal', value: money(inv.subtotal) },
      ...(inv.discount > 0 ? [{ label: 'Discount', value: `- ${money(inv.discount)}`, color: '#059669' }] : []),
      ...(inv.tax > 0
        ? [{ label: inv.taxPercent ? `GST ${inv.taxPercent}%` : 'GST', value: money(inv.tax) }]
        : []),
      { label: 'Total payable', value: money(inv.total), bold: true },
      { label: 'Amount paid', value: money(inv.paidAmount), color: '#059669' },
      ...(inv.remainingAmount > 0
        ? [{ label: 'Remaining due', value: money(inv.remainingAmount), color: '#e11d48', bold: true }]
        : []),
    ];
    const totalsH = totalsLines.length * 16 + 16;
    doc.roundedRect(totalsX - 10, y - 8, totalsW + 10, totalsH, 6).fillAndStroke('#f8fafc', '#e2e8f0');
    totalsLines.forEach((line) => {
      doc.font(line.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(line.bold ? 10 : 9).fillColor(line.color || ink);
      doc.text(line.label, totalsX, y, { width: 100 });
      doc.text(line.value, totalsX + 100, y, { width: 100, align: 'right' });
      y += 16;
    });

    if (inv.notes) {
      y += 14;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#92400e').text('Remarks', left, y, { width: innerW });
      y = doc.y + 4;
      doc.font('Helvetica').fontSize(9).fillColor(body).text(inv.notes, left, y, { width: innerW });
      y = doc.y + 8;
    }

    const footerY = cardY + cardH - 36;
    doc.moveTo(left, footerY).lineTo(right, footerY).strokeColor('#e2e8f0').lineWidth(0.6).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(muted).text(
      `This is a computer-generated tax invoice from ${clinic}. Keep this PDF for your records.`,
      left,
      footerY + 10,
      { width: innerW * 0.65 }
    );
    doc.font('Helvetica-Bold').fontSize(8).fillColor(teal).text('DIGITAL RECORD VERIFIED', rightColX, footerY + 12, {
      width: colW,
      align: 'right',
    });

    doc.end();
  });
}
