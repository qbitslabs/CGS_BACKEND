/* CGS auth module — Express routes.
 * Clinic API layer for auth; talks Prisma or callers, not the AI database. */
import { Router } from 'express';
import { optionalStaffAuth, requireAuth } from '../../middleware/auth.js';
import { clientKey, rateLimit } from '../../middleware/rateLimit.js';
import { authController } from './auth.controller.js';

const router = Router();

const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  key: (req) => clientKey(req, `login:${String(req.body?.email || '').toLowerCase()}`),
});

const refreshRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  key: (req) => clientKey(req, 'refresh'),
});

router.post('/login', loginRateLimit, authController.login);
router.post('/refresh', refreshRateLimit, authController.refresh);
router.post('/logout', optionalStaffAuth, authController.logout);
router.post('/change-password', requireAuth, authController.changePassword);
router.get('/me', requireAuth, authController.getMe);

export default router;
