/* CGS leads module — TypeScript types.
 * Clinic API layer for leads; talks Prisma or callers, not the AI database. */
import { LeadIntent, LeadSource, LeadStatus } from '@prisma/client';

export interface LeadListQuery {
  clinicId: string;
  page?: number;
  limit?: number;
  status?: string;
  source?: string;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  doctorId?: string;
  assignedToUserId?: string;
  preferredDoctor?: string;
}

export interface CreateLeadDTO {
  name: string;
  phone: string;
  email?: string;
  source?: LeadSource;
  interestedService?: string;
  preferredDoctor?: string;
  howHeardAboutDoctor?: string;
  intent?: LeadIntent;
  notes?: string;
  assignedToUserId?: string;
}

export interface UpdateLeadDTO {
  status?: LeadStatus | string;
  notes?: string;
  score?: number;
  intent?: LeadIntent;
  assignedToUserId?: string;
}
