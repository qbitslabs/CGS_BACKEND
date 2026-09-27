/* CGS leads module — Express routes.
 * Clinic API layer for leads; talks Prisma or callers, not the AI database. */
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireTenant } from '../../middleware/tenant.js';
import { leadController } from './lead.controller.js';

const router = Router();

router.use(requireAuth, requireTenant);

router.get('/', leadController.getLeads);
router.post('/', leadController.createLead);
router.get('/:id', leadController.getLeadById);
router.post('/:id/convert', leadController.convertLead);
router.patch('/:id/status', leadController.updateLead);
router.patch('/:id', leadController.updateLead);
router.delete('/:id', leadController.deleteLead);

export default router;
