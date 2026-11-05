/* 18% GST on platform subscription invoices. The plan or entered amount is the taxable value. */
export const GST_RATE = 0.18;

export function roundMoney(value: number) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function gstOn(subtotal: number) {
  const base = roundMoney(subtotal);
  const taxAmount = roundMoney(base * GST_RATE);
  return { subtotal: base, taxAmount, total: roundMoney(base + taxAmount) };
}
