/* CGS meta module — Express routes.
 * Clinic API layer for meta; talks Prisma or callers, not the AI database. */
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireTenant } from '../../middleware/tenant.js';
import { requireClinicStaff } from '../../middleware/rbac.js';
import { metaController } from './meta.controller.js';

const router = Router();

router.use(requireAuth, requireTenant, requireClinicStaff);

router.get('/overview', metaController.getOverview);
router.get('/summary', metaController.getOverview);
router.get('/campaigns', metaController.getCampaigns);
router.get('/creatives', metaController.getCreatives);

export default router;
