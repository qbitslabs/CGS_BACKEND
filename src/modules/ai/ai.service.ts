/* CGS ai module — business logic.
 * Clinic API layer for ai; talks Prisma or callers, not the AI database. */
import { aiClient, AiClient } from './ai.client.js';
import { GenerateAIRequestDTO, AIEntityCreateDTO } from './ai.types.js';

export class AiService {
  constructor(private readonly client: AiClient = aiClient) {}

  async getHealth() {
    try {
      const details = await this.client.healthCheck();
      return {
        aiService: 'ONLINE',
        aiDetails: details,
        cgsInternalApi: 'CONNECTED',
        database: 'CONNECTED',
      };
    } catch (err: any) {
      return {
        aiService: 'OFFLINE_OR_INITIALIZING',
        error: err.message,
        cgsInternalApi: 'CONNECTED',
        database: 'CONNECTED',
      };
    }
  }

  async generateResponse(dto: GenerateAIRequestDTO) {
    return this.client.generate(dto);
  }

  async getEntities() {
    return this.client.getEntities();
  }

  async createEntity(dto: AIEntityCreateDTO) {
    return this.client.createEntity(dto);
  }

  async getConversations(limit: number = 50) {
    return this.client.getAiConversations(limit);
  }

  async getConversationById(id: string) {
    return this.client.getAiConversationById(id);
  }
}

export const aiService = new AiService();
