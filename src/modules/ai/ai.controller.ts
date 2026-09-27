/* CGS ai module — HTTP handlers.
 * Clinic API layer for ai; talks Prisma or callers, not the AI database. */
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../types/index.js';
import { aiService, AiService } from './ai.service.js';
import { generateAiSchema, createAiEntitySchema } from './ai.schema.js';

export class AiController {
  constructor(private readonly service: AiService = aiService) {}

  getHealth = async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.getHealth();
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  generate = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const payload = generateAiSchema.parse(req.body);
      const data = await this.service.generateResponse(payload);
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  getEntities = async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = await this.service.getEntities();
      res.json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  createEntity = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const payload = createAiEntitySchema.parse(req.body);
      const data = await this.service.createEntity(payload);
      res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };
}

export const aiController = new AiController();
