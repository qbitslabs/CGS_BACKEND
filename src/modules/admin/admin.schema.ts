/* CGS admin module — Zod request schemas.
 * Clinic API layer for admin; talks Prisma or callers, not the AI database. */
import { z } from 'zod';

export const createDoctorAdminSchema = z.object({
  clinicId: z.string().uuid(),
  email: z.string().email(),
  password: z.string().min(6),
  firstName: z.string().min(1),
  lastName: z.string().optional(),
  phone: z.string().optional(),
  title: z.string().default('Dr.'),
  specialization: z.string().default('General Physician'),
  registrationNo: z.string().optional(),
  consultationFee: z.number().min(0).default(500),
  bio: z.string().optional(),
  experienceYears: z.number().min(0).default(0),
  qualification: z.string().optional(),
  availabilityDays: z.array(z.string()).default(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']),
  availabilityHours: z.string().default('09:00 AM - 05:00 PM'),
  serviceIds: z.array(z.string().uuid()).optional(),
});

export const updateDoctorAdminSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  phone: z.string().optional(),
  specialization: z.string().optional(),
  registrationNo: z.string().optional(),
  consultationFee: z.number().min(0).optional(),
  bio: z.string().optional(),
  experienceYears: z.number().min(0).optional(),
  qualification: z.string().optional(),
  availabilityDays: z.array(z.string()).optional(),
  availabilityHours: z.string().optional(),
  isActive: z.boolean().optional(),
  serviceIds: z.array(z.string().uuid()).optional(),
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
  landingPage: z
    .object({
      title: z.string().optional(),
      shortDescription: z.string().optional(),
      primaryCta: z.string().optional(),
      whatsappNumber: z.string().optional(),
      enquiryFormEnabled: z.boolean().optional(),
      services: z.array(z.any()).optional(),
      doctors: z.array(z.any()).optional(),
      address: z.string().optional(),
      additionalInfo: z.string().optional(),
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
      messageTemplates: z.record(z.string()).optional(),
    })
    .optional(),
  ai: z
    .object({
      receptionistName: z.string().optional(),
      tone: z.string().optional(),
      greetingMessage: z.string().optional(),
      conversationInstructions: z.string().optional(),
      clinicInformation: z.string().optional(),
      servicesTreatments: z.string().optional(),
      doctorsInfo: z.string().optional(),
      consultationDetails: z.string().optional(),
      timings: z.string().optional(),
      faqs: z.string().optional(),
      isAiEnabled: z.boolean().optional(),
    })
    .optional(),
  workflow: z
    .object({
      qualificationEnabled: z.boolean().optional(),
      appointmentEnabled: z.boolean().optional(),
      reminderEnabled: z.boolean().optional(),
      followUpEnabled: z.boolean().optional(),
      noResponseEnabled: z.boolean().optional(),
      staffHandoffEnabled: z.boolean().optional(),
      followUpHours: z.number().optional(),
      reminderHoursBefore: z.number().optional(),
    })
    .optional(),
      staff: z
    .array(
      z.object({
        name: z.string().min(1),
        email: z.string().email(),
        phone: z.string().optional(),
        password: z.string().min(6, 'Password must be at least 6 characters'),
        roleLabel: z.enum(['CLINIC_ADMIN', 'DOCTOR', 'RECEPTIONIST', 'STAFF']),
        permissions: z.array(z.string()).optional(),
      })
    )
    .optional(),
  services: z
    .array(
      z.object({
        name: z.string().min(1),
        price: z.number().optional(),
        durationMinutes: z.number().optional(),
      })
    )
    .optional(),
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
  password: z.string().min(6).optional(),
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
