/* CGS patients module — Express routes.
 * Clinic API layer for patients; talks Prisma or callers, not the AI database. */
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireTenant } from '../../middleware/tenant.js';
import { patientController } from './patient.controller.js';

const router = Router();

router.use(requireAuth, requireTenant);

router.get('/', patientController.getPatients);
router.get('/:id', patientController.getPatientById);
router.post('/', patientController.createPatient);
router.patch('/:id', patientController.updatePatient);

export default router;
