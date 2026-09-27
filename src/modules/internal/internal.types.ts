/* CGS internal module — TypeScript types.
 * Clinic API layer for internal; talks Prisma or callers, not the AI database. */
export interface WhatsAppEventDTO {
  providerEventId: string;
  phoneNumberId: string;
  eventType?: string;
  payload?: any;
}

export interface WhatsAppInboundMessageDTO {
  phoneNumberId: string;
  senderPhone: string;
  senderName?: string;
  content: string;
  providerMessageId: string;
  mediaUrl?: string;
}

export interface AIContextQueryDTO {
  clinicId?: string;
  doctorId?: string;
}

export interface AIPatientQueryDTO {
  clinicId: string;
  phone?: string;
  patientId?: string;
}

export interface AILeadUpsertDTO {
  clinicId: string;
  phone?: string;
  leadId?: string;
  name?: string;
  interestedService?: string;
  intent?: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface AIAvailabilityQueryDTO {
  clinicId: string;
  doctorId?: string;
  date: string;
}

export interface AIBookAppointmentDTO {
  clinicId: string;
  patientPhone: string;
  patientName: string;
  doctorId?: string;
  service?: string;
  date: string;
  time: string;
  notes?: string;
  age?: number;
  gender?: 'MALE' | 'FEMALE' | 'OTHER';
  allergies?: string[];
  medicalHistoryNotes?: string;
}

export interface AIRescheduleAppointmentDTO {
  clinicId: string;
  appointmentId: string;
  date: string;
  time: string;
  doctorId?: string;
  notes?: string;
}

export interface AIHandoffDTO {
  clinicId: string;
  conversationId: string;
  reason: string;
  severity?: 'normal' | 'critical';
}

export interface AIRecordUsageDTO {
  clinicId?: string | null;
  doctorId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  requestId: string;
  entityType?: 'CLINIC' | 'CHATBOT' | 'ECOMMERCE' | 'RESTAURANT' | 'EDUCATION' | 'REAL_ESTATE';
  entityId: string;
  operationType?: 'CONVERSATION_RESPONSE' | 'SUMMARY_ADDON' | 'SUMMARY_MERGE' | 'SUMMARY_REBUILD' | 'TOOL_EXECUTION';
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputCost?: number;
  outputCost?: number;
  totalCost?: number;
  currency?: string;
  durationMs?: number;
  success?: boolean;
  errorCode?: string | null;
  metadata?: any;
}

export interface SyncSummaryDTO {
  conversationId: string;
  clinicId?: string;
  participantPhone?: string;
  version: number;
  summaryText: string;
  topics?: string[];
  entities?: Record<string, any>;
  intent?: string;
  sentiment?: string;
  keyPoints?: string[];
  actionItems?: string[];
  source?: 'ADDON_MERGE' | 'REBUILD' | 'DIRECT';
}
