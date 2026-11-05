/* CGS admin module — Zod request schemas.
 * Clinic API layer for admin; talks Prisma or callers, not the AI database. */
import { z } from 'zod';

export const recordClinicAddonSchema = z.object({
  type: z.enum([
    'EXTRA_DOCTOR',
    'EXTRA_STAFF',
    'EXTRA_AI_REPLIES',
    'EXTRA_WHATSAPP_NUMBER',
    'PRIORITY_SUPPORT',
    'EXTRA_AUTOMATION',
  ]),
  quantity: z.number().int().min(1).max(20).optional(),
  automationKey: z.string().optional(),
});

export const setPrimaryDoctorSchema = z.object({
  userId: z.string().uuid().optional(),
  doctorId: z.string().uuid().optional(),
}).refine((d) => Boolean(d.userId || d.doctorId), {
  message: 'userId or doctorId is required',
});

export const updateDoctorAiConfigSchema = z.object({
  systemPrompt: z.string().optional(),
  modelOverride: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional(),
  toolsEnabled: z.array(z.string()).optional(),
  autoHandoffRules: z.any().optional(),
  greetingMessage: z.string().optional(),
  outOfHoursMessage: z.string().optional(),
  handoffMessage: z.string().optional(),
  knowledgeBase: z.string().optional(),
  tone: z.string().optional(),
  language: z.string().optional(),
  isActive: z.boolean().optional(),
});

export const adminLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const createClinicAdminSchema = z.object({
  name: z.string().min(1),
  slug: z.string().optional(),
  doctorName: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  gstin: z.string().optional(),
  country: z.string().default('India'),
  postalCode: z.string().optional(),
  website: z.string().optional(),
  description: z.string().optional(),
  logoUrl: z.string().optional(),
  workingDays: z.array(z.string()).optional(),
  openingTime: z.string().optional(),
  closingTime: z.string().optional(),
  tier: z.enum(['STARTER', 'GROWTH', 'ENTERPRISE', 'CUSTOM']).optional(),
  planId: z.string().uuid().optional(),
  earlyBird: z.boolean().optional(),
  addons: z.array(recordClinicAddonSchema).max(12).optional(),
  landingPage: z
    .object({
      title: z.string().optional(),
      shortDescription: z.string().optional(),
      primaryCta: z.string().optional(),
      whatsappNumber: z.string().optional(),
      enquiryFormEnabled: z.boolean().optional(),
    })
    .optional(),
  whatsapp: z
    .object({
      businessAccountId: z.string().optional(),
      phoneNumberId: z.string().optional(),
      displayPhoneNumber: z.string().optional(),
      accessToken: z.string().optional(),
      apiVersion: z.string().optional(),
      webhookUrl: z.string().optional(),
      verifyToken: z.string().optional(),
      webhookStatus: z.string().optional(),
    })
    .optional(),
  ai: z
    .object({
      receptionistName: z.string().optional(),
      tone: z.string().optional(),
      greetingMessage: z.string().optional(),
      conversationInstructions: z.string().optional(),
      clinicInformation: z.string().optional(),
      faqs: z.string().optional(),
      isAiEnabled: z.boolean().optional(),
    })
    .optional(),
});

export const replaceWhatsAppTokenSchema = z.object({
  accessToken: z.string().min(20, 'Paste the WhatsApp access token from Meta'),
});

export const updateClinicAdminSchema = z.object({
  name: z.string().optional(),
  slug: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  gstin: z.string().optional(),
  status: z.enum(['PROVISIONING', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'TRIAL', 'INACTIVE']).optional(),
  reason: z.string().optional(),
  workingHours: z.string().optional(),
  timezone: z.string().optional(),
  currency: z.string().optional(),
});

export const createClinicUserAdminSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  role: z.enum(['DOCTOR', 'EMPLOYEE']),
  designation: z.string().optional(),
  specialization: z.string().optional(),
  registrationNumber: z.string().optional(),
  qualification: z.string().optional(),
  experienceYears: z.number().optional(),
  consultationFee: z.number().optional(),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

export const aiUsageFilterSchema = z.object({
  clinicId: z.string().uuid().optional(),
  doctorId: z.string().uuid().optional(),
  model: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  days: z.coerce.number().int().positive().optional(),
});

/** Public Bits / clinic landing enquiry → lead for clinic resolved by landingPageId */
export const publicLandingEnquirySchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(8),
  email: z.string().email().optional().or(z.literal('')),
  howYouFindUs: z.string().min(1),
  preferredDoctor: z.string().min(1),
  service: z.string().min(1),
});

export const assignClinicPlanSchema = z.object({
  planId: z.string().uuid(),
  status: z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'EXPIRED']),
  earlyBird: z.boolean(),
});
