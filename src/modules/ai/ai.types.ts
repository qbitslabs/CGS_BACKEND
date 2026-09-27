/* CGS ai module — TypeScript types.
 * Clinic API layer for ai; talks Prisma or callers, not the AI database. */
export interface GenerateAIRequestDTO {
  entity_id: string;
  entity_type?: string;
  participant_id: string;
  message: string;
  channel?: string;
  doctor_id?: string;
  conversation_id?: string;
  metadata?: Record<string, any>;
  model_override?: string;
  temperature?: number;
}

export interface AIHealthStatusDTO {
  aiService: string;
  aiDetails?: any;
  cgsInternalApi: string;
  database: string;
  error?: string;
}

export interface AIEntityCreateDTO {
  type: string;
  name: string;
  external_id?: string;
  system_prompt?: string;
  configuration?: Record<string, any>;
  status?: string;
}
