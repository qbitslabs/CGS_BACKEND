/* CGS clinics module — Express routes.
 * Clinic API layer for clinics; talks Prisma or callers, not the AI database. */
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireTenant } from '../../middleware/tenant.js';
import { requireDoctor } from '../../middleware/rbac.js';
import { clinicController } from './clinic.controller.js';

const router = Router();

router.use(requireAuth, requireTenant);

router.get('/current', clinicController.getCurrentClinic);
router.patch('/current', requireDoctor, clinicController.updateCurrentClinic);

// Service CRUD (both /services and /current/services for frontend compatibility)
router.post('/current/services', requireDoctor, clinicController.createService);
router.patch('/current/services/:id', requireDoctor, clinicController.updateService);
router.delete('/current/services/:id', requireDoctor, clinicController.deleteService);

router.post('/services', requireDoctor, clinicController.createService);
router.patch('/services/:id', requireDoctor, clinicController.updateService);
router.delete('/services/:id', requireDoctor, clinicController.deleteService);

export default router;
