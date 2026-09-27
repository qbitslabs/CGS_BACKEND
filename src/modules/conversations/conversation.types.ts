/* CGS conversations module — TypeScript types.
 * Clinic API layer for conversations; talks Prisma or callers, not the AI database. */
import { ConversationState } from '@prisma/client';

export interface ConversationListQuery {
  clinicId: string;
  state?: string;
  search?: string;
  doctorId?: string;
}

export interface SendStaffMessageDTO {
  clinicId: string;
  conversationId: string;
  content: string;
  mediaUrl?: string;
  senderName: string;
}

export interface UpdateConversationDTO {
  state?: ConversationState;
  handoffReason?: string | null;
  internalNotes?: string;
  assignedToUserId?: string | null;
  doctorId?: string | null;
}

export interface ConversationResponseDTO {
  id: string;
  patientId: string | null;
  leadId: string | null;
  doctorId?: string;
  doctorName?: string;
  participantName: string;
  participantPhone: string;
  state: string;
  lastMessage: string;
  lastMessageTime: string;
  unreadCount: number;
  assignedTo?: string;
  serviceInterested?: string;
  handoffReason?: string;
  isCritical?: boolean;
  needsHumanHandoff?: boolean;
  internalNotes?: string;
}

export interface MessageResponseDTO {
  id: string;
  conversationId: string;
  sender: 'patient' | 'ai' | 'human';
  senderName: string;
  text: string;
  timestamp: string;
  status: string;
  isAiGenerated: boolean;
}
