/* CGS ai module — Express routes.
 * Clinic API layer for ai; talks Prisma or callers, not the AI database. */
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { aiController } from './ai.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/health', aiController.getHealth);
router.post('/generate', aiController.generate);
router.get('/entities', aiController.getEntities);
router.post('/entities', aiController.createEntity);

export default router;
