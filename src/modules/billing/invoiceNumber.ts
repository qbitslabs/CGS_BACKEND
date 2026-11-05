/** Next clinic invoice number: INV-YYYY-####, continuing past the highest number already issued that year. */
export function nextInvoiceNumber(existingNumbers: string[], year: number): string {
  const prefix = `INV-${year}-`;
  let max = 0;
  for (const invoiceNumber of existingNumbers) {
    if (!invoiceNumber.startsWith(prefix)) continue;
    const suffix = invoiceNumber.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    const seq = Number(suffix);
    if (seq > max) max = seq;
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}
