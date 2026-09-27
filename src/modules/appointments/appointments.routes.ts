/* CGS appointments module — Express routes.
 * Clinic API layer for appointments; talks Prisma or callers, not the AI database. */
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireTenant } from '../../middleware/tenant.js';
import { appointmentController } from './appointment.controller.js';

const router = Router();

router.use(requireAuth, requireTenant);

router.get('/availability', appointmentController.getDoctorAvailability);
router.get('/', appointmentController.getAppointments);
router.post('/', appointmentController.createAppointment);
router.get('/:id', appointmentController.getAppointmentById);
router.patch('/:id/status', appointmentController.updateAppointment);
router.patch('/:id', appointmentController.updateAppointment);

export default router;

