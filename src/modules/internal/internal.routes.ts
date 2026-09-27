/* CGS internal module — Express routes.
 * Clinic API layer for internal; talks Prisma or callers, not the AI database. */
import { Router } from 'express';
import { requireInternalServiceAuth } from '../../middleware/auth.js';
import { internalController } from './internal.controller.js';

const router = Router();

// Internal service-to-service key authentication
router.use(requireInternalServiceAuth);

// WhatsApp Gateway Internal Endpoints
router.post('/whatsapp/event', internalController.handleWhatsAppEvent);
router.post('/whatsapp/inbound-message', internalController.handleWhatsAppInbound);

// Doctor-Centric AI Service Internal Endpoints
router.post('/ai/context', internalController.getAiContext);
router.post('/ai/patient', internalController.getAiPatient);
router.post('/ai/lead', internalController.getOrUpsertLead);
router.get('/ai/doctors', internalController.getAiDoctors);
router.get('/ai/services', internalController.getAiServices);
router.post('/ai/availability', internalController.getAvailability);
router.post('/ai/appointments', internalController.bookAppointment);
router.post('/ai/appointments/:id/reschedule', internalController.rescheduleAppointment);
router.get('/ai/appointments/:id', internalController.getAiAppointment);
router.post('/ai/handoff', internalController.requestHumanHandoff);
router.post('/ai/usage', internalController.recordAiUsage);

// Dual Conversation Summary Storage Sync
router.post('/summary/sync', internalController.syncSummary);

export default router;
