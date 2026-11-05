/* Brochure plan rows. PROMT2.TXT is the source of truth for these numbers. */
import { AppError } from '../../middleware/errorHandler.js';

export const EARLY_BIRD_CLINIC_CAP = 5;
export const AI_REPLY_PACK = 300;

/** Monthly fee for a package. Early Bird uses its price; otherwise the regular tier price. */
export function packageMonthlyAmount(
  plan: { regularMonthlyPrice?: unknown; earlyBirdMonthlyPrice?: unknown; priceMonthly?: unknown } | null | undefined,
  earlyBird = false,
) {
  if (!plan) return 0;
  const regular = Number(plan.regularMonthlyPrice || 0);
  const early = Number(plan.earlyBirdMonthlyPrice || 0);
  if (earlyBird && early > 0) return early;
  if (regular > 0) return regular;
  return Number(plan.priceMonthly || 0);
}

export const AUTOMATION = {
  NEW_ENQUIRY: 'NEW_ENQUIRY',
  INVOICE_WHATSAPP: 'INVOICE_WHATSAPP',
  APPOINTMENT_REMINDER: 'APPOINTMENT_REMINDER',
  MISSED_APPOINTMENT: 'MISSED_APPOINTMENT',
  COMPLETED_VISIT: 'COMPLETED_VISIT',
  PATIENT_REACTIVATION: 'PATIENT_REACTIVATION',
} as const;

export const AUTOMATION_LABELS: Record<string, string> = {
  NEW_ENQUIRY: 'New enquiry',
  INVOICE_WHATSAPP: 'Invoice',
  APPOINTMENT_REMINDER: 'Appointment reminder',
  MISSED_APPOINTMENT: 'Missed appointment',
  COMPLETED_VISIT: 'Completed-visit follow-up',
  PATIENT_REACTIVATION: 'Patient reactivation',
};

const ESSENTIAL_EXTRA_AUTOMATIONS = [
  AUTOMATION.MISSED_APPOINTMENT,
  AUTOMATION.COMPLETED_VISIT,
  AUTOMATION.PATIENT_REACTIVATION,
];
const GROWTH_EXTRA_AUTOMATIONS = [AUTOMATION.PATIENT_REACTIVATION];

export const ADDON_OFFERS = [
  { type: 'EXTRA_DOCTOR', label: 'Extra doctor', price: 1000, billing: 'MONTHLY' as const, tiers: ['STARTER', 'GROWTH', 'ENTERPRISE'] },
  { type: 'EXTRA_STAFF', label: 'Extra staff member', price: 500, billing: 'MONTHLY' as const, tiers: ['STARTER', 'GROWTH', 'ENTERPRISE'] },
  { type: 'EXTRA_AI_REPLIES', label: 'Extra 300 AI replies', price: 500, billing: 'ONE_TIME' as const, tiers: ['STARTER', 'GROWTH', 'ENTERPRISE'] },
  { type: 'EXTRA_WHATSAPP_NUMBER', label: 'Extra WhatsApp number', price: 1500, billing: 'MONTHLY' as const, tiers: ['STARTER', 'GROWTH', 'ENTERPRISE'] },
  { type: 'PRIORITY_SUPPORT', label: 'Priority support', price: 2000, billing: 'MONTHLY' as const, tiers: ['STARTER', 'GROWTH'] },
  { type: 'EXTRA_AUTOMATION', label: 'Extra automation', price: 500, billing: 'MONTHLY' as const, tiers: ['STARTER', 'GROWTH'] },
];

export function addonOffer(tier: string, type: string, automationKey?: string | null) {
  const offer = ADDON_OFFERS.find((item) => item.type === type);
  if (!offer || !offer.tiers.includes(tier)) {
    throw new AppError('This plan cannot add that extra.', 400, 'ADDON_NOT_AVAILABLE');
  }
  if (type === 'EXTRA_AUTOMATION') {
    const allowed = tier === 'GROWTH' ? GROWTH_EXTRA_AUTOMATIONS : ESSENTIAL_EXTRA_AUTOMATIONS;
    if (!allowed.includes(automationKey as typeof allowed[number])) {
      throw new AppError(
        tier === 'GROWTH'
          ? 'Growth can add patient reactivation. The other WhatsApp automations are already included.'
          : 'Choose missed appointment, completed-visit follow-up, or patient reactivation.',
        400,
        'ADDON_NOT_AVAILABLE',
      );
    }
  }
  return offer;
}

const CORE_AUTOMATIONS = [
  AUTOMATION.NEW_ENQUIRY,
  AUTOMATION.INVOICE_WHATSAPP,
  AUTOMATION.APPOINTMENT_REMINDER,
];

export const BROCHURE_PLANS = [
  {
    tier: 'STARTER' as const,
    name: 'Essential',
    doctorsIncluded: 1,
    staffIncluded: 2,
    whatsappNumbersIncluded: 1,
    aiRepliesMonthly: 300,
    modelLevel: 'NORMAL' as const,
    conversationMemory: 'NONE' as const,
    reportingLevel: 'BASIC' as const,
    customAiIncluded: false,
    outboundIncluded: false,
    prioritySupportIncluded: false,
    regularMonthlyPrice: 10000,
    earlyBirdMonthlyPrice: 8000,
    regularSetupFee: 30000,
    earlyBirdSetupFee: 20000,
    automationKeys: [...CORE_AUTOMATIONS],
    features: [
      '1 doctor, 2 staff, 1 WhatsApp number',
      '300 AI replies a month, normal model, no conversation memory',
      'New enquiry, invoice, and appointment reminder',
    ],
  },
  {
    tier: 'GROWTH' as const,
    name: 'Growth',
    doctorsIncluded: 2,
    staffIncluded: 4,
    whatsappNumbersIncluded: 1,
    aiRepliesMonthly: 900,
    modelLevel: 'HIGH_END' as const,
    conversationMemory: 'FULL' as const,
    reportingLevel: 'ADVANCED' as const,
    customAiIncluded: false,
    outboundIncluded: false,
    prioritySupportIncluded: false,
    regularMonthlyPrice: 12000,
    earlyBirdMonthlyPrice: 10000,
    regularSetupFee: 30000,
    earlyBirdSetupFee: 20000,
    automationKeys: [...CORE_AUTOMATIONS, AUTOMATION.MISSED_APPOINTMENT, AUTOMATION.COMPLETED_VISIT],
    features: [
      '2 doctors, 4 staff, 1 WhatsApp number',
      '900 AI replies a month, high-end model, full conversation memory',
      'Essential automations, plus missed appointment and completed-visit follow-up',
    ],
  },
  {
    tier: 'ENTERPRISE' as const,
    name: 'Scale',
    doctorsIncluded: 5,
    staffIncluded: 10,
    whatsappNumbersIncluded: 2,
    aiRepliesMonthly: 1500,
    modelLevel: 'HIGH_END' as const,
    conversationMemory: 'FULL' as const,
    reportingLevel: 'ADVANCED' as const,
    customAiIncluded: true,
    outboundIncluded: true,
    prioritySupportIncluded: true,
    regularMonthlyPrice: 18000,
    earlyBirdMonthlyPrice: 15000,
    regularSetupFee: 30000,
    earlyBirdSetupFee: 20000,
    automationKeys: [
      ...CORE_AUTOMATIONS,
      AUTOMATION.MISSED_APPOINTMENT,
      AUTOMATION.COMPLETED_VISIT,
      AUTOMATION.PATIENT_REACTIVATION,
    ],
    features: [
      '5 doctors, 10 staff, 2 WhatsApp numbers',
      '1,500 AI replies a month, high-end model, full conversation memory',
      'All six automations, custom AI configuration, outbound campaigns, priority support',
    ],
  },
];

type PlanRow = { id: string; tier: string };

type PlanStore = {
  subscriptionPlan: {
    findFirst: (args: { where: { tier: string } }) => Promise<PlanRow | null>;
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
};

function entitlementData(plan: (typeof BROCHURE_PLANS)[number]) {
  return {
    name: plan.name,
    features: plan.features,
    doctorsIncluded: plan.doctorsIncluded,
    staffIncluded: plan.staffIncluded,
    whatsappNumbersIncluded: plan.whatsappNumbersIncluded,
    aiRepliesMonthly: plan.aiRepliesMonthly,
    modelLevel: plan.modelLevel,
    conversationMemory: plan.conversationMemory,
    reportingLevel: plan.reportingLevel,
    customAiIncluded: plan.customAiIncluded,
    outboundIncluded: plan.outboundIncluded,
    prioritySupportIncluded: plan.prioritySupportIncluded,
    regularMonthlyPrice: plan.regularMonthlyPrice,
    earlyBirdMonthlyPrice: plan.earlyBirdMonthlyPrice,
    regularSetupFee: plan.regularSetupFee,
    earlyBirdSetupFee: plan.earlyBirdSetupFee,
    automationKeys: plan.automationKeys,
  };
}

/** Writes brochure limits onto STARTER, GROWTH, and ENTERPRISE. Leaves priceMonthly alone when the row already exists. */
export async function seedBrochurePlans(db: PlanStore) {
  for (const plan of BROCHURE_PLANS) {
    const existing = await db.subscriptionPlan.findFirst({ where: { tier: plan.tier } });
    const data = entitlementData(plan);
    if (existing) {
      await db.subscriptionPlan.update({ where: { id: existing.id }, data });
      continue;
    }
    await db.subscriptionPlan.create({
      data: {
        ...data,
        tier: plan.tier,
        priceMonthly: plan.regularMonthlyPrice,
        currency: 'INR',
        billingCycle: 'MONTHLY',
        isActive: true,
      },
    });
  }
}

type EarlyBirdStore = {
  cgsSubscription: {
    findFirst: (args: { where: { clinicId: string; earlyBird: boolean }; select: { id: true } }) => Promise<{ id: string } | null>;
    groupBy: (args: { by: ['clinicId']; where: { earlyBird: boolean; clinicId: { not: string } } }) => Promise<Array<{ clinicId: string }>>;
  };
};

/** Refuses Early Bird when five other clinics already have it. A clinic that already has it can keep it. */
export async function assertEarlyBirdAvailable(db: EarlyBirdStore, clinicId: string) {
  const already = await db.cgsSubscription.findFirst({
    where: { clinicId, earlyBird: true },
    select: { id: true },
  });
  if (already) return;

  const others = await db.cgsSubscription.groupBy({
    by: ['clinicId'],
    where: { earlyBird: true, clinicId: { not: clinicId } },
  });
  if (others.length >= EARLY_BIRD_CLINIC_CAP) {
    throw new AppError('Early Bird is already on for five clinics.', 400, 'EARLY_BIRD_FULL');
  }
}
