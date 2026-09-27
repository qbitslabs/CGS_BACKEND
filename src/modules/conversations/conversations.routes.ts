/* CGS conversations module — Express routes.
 * Clinic API layer for conversations; talks Prisma or callers, not the AI database. */
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireTenant } from '../../middleware/tenant.js';
import { conversationController } from './conversation.controller.js';

const router = Router();

// Middleware: Authenticated & Tenant-bound
router.use(requireAuth, requireTenant);

// Routes
router.get('/badge', conversationController.getSidebarBadge);
router.get('/', conversationController.getConversations);
router.get('/:id', conversationController.getConversationById);
router.get('/:id/messages', conversationController.getMessages);
router.post('/:id/messages', conversationController.sendStaffMessage);
router.post('/:id/simulate-inbound', conversationController.simulateInbound);
router.post('/:id/ai-reply', conversationController.generateAiReply);
router.patch('/:id/state', conversationController.updateConversation);
router.patch('/:id/read', conversationController.markRead);
router.patch('/:id', conversationController.updateConversation);

export default router;
