/* CGS billing module — Express routes.
 * Clinic API layer for billing; talks Prisma or callers, not the AI database. */
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireTenant } from '../../middleware/tenant.js';
import { requireDoctor } from '../../middleware/rbac.js';
import { billingController } from './billing.controller.js';

const router = Router();

router.use(requireAuth, requireTenant);

router.get('/summary', billingController.getSummary);
router.get('/invoices', billingController.getInvoices);
router.get('/invoices/:id', billingController.getInvoiceById);
router.post('/invoices', billingController.createInvoice);
router.post('/invoices/:id/send-whatsapp', billingController.sendInvoiceWhatsApp);
router.get('/subscription', requireDoctor, billingController.getSubscription);

export default router;
