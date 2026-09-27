/* CGS ai module — Zod request schemas.
 * Clinic API layer for ai; talks Prisma or callers, not the AI database. */
import { z } from 'zod';

export const generateAiSchema = z.object({
  entity_id: z.string().optional(),
  entity_type: z.string().optional(),
  participant_id: z.string().optional(),
  message: z.string().optional(),
  prompt: z.string().optional(),
  channel: z.string().default('WEB'),
  doctor_id: z.string().uuid().optional(),
  conversation_id: z.string().uuid().optional(),
  metadata: z.record(z.any()).optional(),
  model_override: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
}).transform((data) => {
  let resolvedType = (data.entity_type || '').toUpperCase();
  if (!resolvedType) {
    if (data.doctor_id) {
      resolvedType = 'DOCTOR';
    } else if (data.entity_id && (data.entity_id === 'default-clinic' || data.entity_id.includes('clinic'))) {
      resolvedType = 'CLINIC';
    } else {
      resolvedType = 'GENERIC';
    }
  }

  return {
    entity_id: data.entity_id || 'default-assistant',
    entity_type: resolvedType,
    participant_id: data.participant_id || 'guest-user',
    message: data.message || data.prompt || 'Hello',
    channel: data.channel || 'WEB',
    doctor_id: data.doctor_id,
    conversation_id: data.conversation_id,
    metadata: data.metadata,
    model_override: data.model_override,
    temperature: data.temperature,
  };
});

export const createAiEntitySchema = z.object({
  type: z.string().optional(),
  entity_type: z.string().optional(),
  name: z.string().optional(),
  entity_name: z.string().optional(),
  id: z.string().optional(),
  entity_id: z.string().optional(),
  external_id: z.string().optional(),
  system_prompt: z.string().optional(),
  prompt: z.string().optional(),
  instructions: z.string().optional(),
  configuration: z.union([z.record(z.any()), z.string()]).optional(),
  config: z.union([z.record(z.any()), z.string()]).optional(),
  status: z.string().default('ACTIVE'),
}).transform((data) => {
  let parsedConfig: Record<string, any> = {};
  const rawConfig = data.configuration ?? data.config;
  if (typeof rawConfig === 'string') {
    try {
      parsedConfig = JSON.parse(rawConfig);
    } catch {
      parsedConfig = {};
    }
  } else if (rawConfig && typeof rawConfig === 'object') {
    parsedConfig = rawConfig;
  }

  return {
    type: (data.type || data.entity_type || 'GENERIC').toUpperCase(),
    name: data.name || data.entity_name || data.external_id || data.entity_id || 'AI Assistant',
    external_id: data.external_id || data.entity_id || data.id,
    system_prompt: data.system_prompt || data.prompt || data.instructions,
    configuration: parsedConfig,
    status: data.status || 'ACTIVE',
  };
});
