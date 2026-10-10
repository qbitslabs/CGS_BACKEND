/* Authenticated clinic routes for template outbound sends. */
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireTenant } from '../../middleware/tenant.js';
import { listTemplates, previewOutbound, sendOutbound } from './outbound.controller.js';

const router = Router();

router.use(requireAuth, requireTenant);
router.get('/templates', listTemplates);
router.post('/outbound/preview', previewOutbound);
router.post('/outbound', sendOutbound);

export default router;
