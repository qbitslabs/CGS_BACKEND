/* CGS ai module — outbound HTTP client.
 * Clinic API layer for ai; talks Prisma or callers, not the AI database. */
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/errorHandler.js';

export class AiClient {
  private baseUrl: string;
  private secretKey: string;

  constructor() {
    this.baseUrl = env.AI_SERVICE_URL;
    this.secretKey = env.INTERNAL_SERVICE_SECRET;
  }

  async request<T = any>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      'X-Internal-Service-Key': this.secretKey,
      ...(options.headers || {}),
    };

    try {
      const response = await fetch(url, { ...options, headers });
      if (!response.ok) {
        const errorText = await response.text();
        throw new AppError(
          `AI Service HTTP [${response.status}]: ${errorText}`,
          response.status >= 500 ? 502 : response.status,
          'AI_SERVICE_ERROR'
        );
      }
      return (await response.json()) as T;
    } catch (err: any) {
      if (err instanceof AppError) throw err;
      throw new AppError(`Failed to connect to Python AI Service: ${err.message}`, 503, 'AI_SERVICE_UNAVAILABLE');
    }
  }

  async healthCheck() {
    return this.request('/health');
  }

  async generate(payload: any) {
    // Multi-tool booking loops often take 15–30s; don't abort early.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      return await this.request('/ai/v1/generate', {
        method: 'POST',
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async getEntities() {
    return this.request('/ai/v1/entities');
  }

  async createEntity(payload: any) {
    return this.request('/ai/v1/entities', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async getAiConversations(limit: number = 50) {
    return this.request(`/ai/v1/conversations?limit=${limit}`);
  }

  async getAiConversationById(id: string) {
    return this.request(`/ai/v1/conversations/${id}`);
  }

  /** Fire-and-forget friendly: bust AI clinic TTL caches after admin roster/hours edits. */
  async invalidateClinicCache(clinicId?: string | null) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      try {
        return await this.request('/ai/v1/cache/invalidate', {
          method: 'POST',
          body: JSON.stringify(clinicId ? { clinicId } : {}),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err: any) {
      console.warn('[AiClient] cache invalidate failed:', err?.message || err);
      return null;
    }
  }
}

export const aiClient = new AiClient();
