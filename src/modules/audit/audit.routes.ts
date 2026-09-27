/* CGS audit module — Express routes.
 * Clinic API layer for audit; talks Prisma or callers, not the AI database. */
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireTenant } from '../../middleware/tenant.js';
import { requireDoctor } from '../../middleware/rbac.js';
import { auditController } from './audit.controller.js';

const router = Router();

router.use(requireAuth, requireTenant, requireDoctor);

router.get('/', auditController.getLogs);

export default router;
