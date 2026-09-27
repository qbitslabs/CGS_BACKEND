/* CGS admin module — Express routes.
 * Clinic API layer for admin; talks Prisma or callers, not the AI database. */
import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/auth.js';
import { adminController } from './admin.controller.js';

const router = Router();

router.post('/auth/login', adminController.login);
router.get('/auth/me', requireAdminAuth, adminController.getMe);
router.post('/auth/logout', requireAdminAuth, adminController.logout);

router.use(requireAdminAuth);

router.get('/overview', adminController.getOverview);

router.get('/doctors', adminController.getDoctors);
router.get('/doctors/:id', adminController.getDoctorById);
router.get('/doctors/:id/analytics', adminController.getDoctorAnalytics);
router.patch('/doctors/:id/ai-config', adminController.updateDoctorAiConfig);

router.get('/clinics', adminController.getClinics);
router.post('/clinics', adminController.createClinic);
router.get('/clinics/:id', adminController.getClinicById);
router.patch('/clinics/:id', adminController.updateClinic);
router.patch('/clinics/:id/ai-config', adminController.updateClinicAiConfig);
router.post('/clinics/:id/users', adminController.addClinicUser);
router.patch('/clinics/:id/primary-doctor', adminController.setPrimaryDoctor);

router.get('/users', adminController.getUsers);

router.get('/ai/usage/summary', adminController.getAiUsageSummary);
router.get('/ai/usage/daily', adminController.getAiUsageDaily);
router.get('/ai/usage/clinics', adminController.getAiUsageByClinics);
router.get('/ai/usage/doctors', adminController.getAiUsageByDoctors);
router.get('/ai/usage/models', adminController.getAiUsageByModels);
router.get('/ai/usage/entities', adminController.getAiUsageByEntities);
router.get('/ai/conversations', adminController.getAiConversations);
router.get('/ai/conversations/:id', adminController.getAiConversationById);

router.get('/plans', adminController.getPlans);
router.get('/subscriptions', adminController.getSubscriptions);
router.get('/invoices', adminController.getInvoices);

router.get('/whatsapp', adminController.getWhatsappHealth);
router.get('/jobs', adminController.getJobs);
router.post('/jobs/:id/retry', adminController.retryJob);
router.get('/audit-logs', adminController.getAuditLogs);

// Settings
router.get('/settings', adminController.getSettings);
router.patch('/settings', adminController.updateSettings);
router.post('/settings/rotate-secret', adminController.rotateSecret);

// Support Diagnostics
router.get('/support/diagnostics', adminController.getDiagnostics);
router.post('/support/diagnostics', adminController.getDiagnostics);

// Admin AI Direct Proxy & Entity Management
router.post('/ai/generate', adminController.generateAi);
router.get('/ai/entities', adminController.getAiEntities);
router.post('/ai/entities', adminController.createAiEntity);

export default router;
