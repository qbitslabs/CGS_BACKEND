/* CGS auth module — Express routes.
 * Clinic API layer for auth; talks Prisma or callers, not the AI database. */
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { authController } from './auth.controller.js';

const router = Router();

router.post('/login', authController.login);
router.get('/me', requireAuth, authController.getMe);
router.post('/logout', requireAuth, authController.logout);

export default router;
