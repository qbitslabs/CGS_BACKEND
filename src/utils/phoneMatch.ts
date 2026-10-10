/** Match landing (10-digit) vs WhatsApp (91…) and other common India formats. */
export function phoneMatchVariants(phone: string): string[] {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return phone ? [phone] : [];

  const variants = new Set<string>([digits]);
  if (digits.length === 10) {
    variants.add(`91${digits}`);
  }
  if (digits.startsWith('91') && digits.length === 12) {
    variants.add(digits.slice(2));
  }
  if (digits.startsWith('0') && digits.length === 11) {
    const withoutZero = digits.slice(1);
    variants.add(withoutZero);
    variants.add(`91${withoutZero}`);
  }
  return [...variants];
}
