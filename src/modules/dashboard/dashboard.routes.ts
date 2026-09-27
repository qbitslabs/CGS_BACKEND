/* CGS dashboard module — Express routes.
 * Clinic API layer for dashboard; talks Prisma or callers, not the AI database. */
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireTenant } from '../../middleware/tenant.js';
import { dashboardController } from './dashboard.controller.js';

const router = Router();

router.use(requireAuth, requireTenant);
router.get('/summary', dashboardController.getSummary);

export default router;
