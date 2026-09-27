/* CGS users module — Express routes.
 * Clinic API layer for users; talks Prisma or callers, not the AI database. */
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireTenant } from '../../middleware/tenant.js';
import { requireDoctor } from '../../middleware/rbac.js';
import { userController } from './user.controller.js';

const router = Router();

router.use(requireAuth, requireTenant);

router.get('/leaves', userController.getDoctorLeaves);
router.post('/leaves', requireDoctor, userController.createDoctorLeave);
router.delete('/leaves/:id', requireDoctor, userController.deleteDoctorLeave);

router.get('/', userController.getUsers);
router.post('/', requireDoctor, userController.createUser);
router.patch('/:id/status', requireDoctor, userController.updateStatus);
router.patch('/:id', requireDoctor, userController.updateUser);

export default router;

