/* CGS notifications module — Express routes.
 * Clinic API layer for notifications; talks Prisma or callers, not the AI database. */
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireTenant } from '../../middleware/tenant.js';
import { notificationController } from './notification.controller.js';

const router = Router();

router.use(requireAuth, requireTenant);

router.get('/', notificationController.getNotifications);
router.get('/unread-count', notificationController.getUnreadCount);
router.patch('/:id/read', notificationController.markAsRead);
router.post('/read-all', notificationController.markAllAsRead);

export default router;
