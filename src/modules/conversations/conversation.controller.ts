/* CGS conversations module — HTTP handlers.
 * Clinic API layer for conversations; talks Prisma or callers, not the AI database. */
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../types/index.js';
import { conversationService, ConversationService } from './conversation.service.js';
import {
  listConversationsSchema,
  getMessagesSchema,
  sendStaffMessageSchema,
  simulateInboundSchema,
  updateConversationSchema,
} from './conversation.schema.js';
import { resolveDoctorScope } from '../../utils/doctorScope.js';

export class ConversationController {
  constructor(private readonly service: ConversationService = conversationService) {}

  getSidebarBadge = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const scope = await resolveDoctorScope({
        clinicId: req.clinicId!,
        userId: req.user?.userId,
        role: req.user?.role,
      });
      const badge = await this.service.getSidebarBadge(req.clinicId!, scope.restrictToDoctorId || undefined);
      res.json({ success: true, data: badge });
    } catch (error) {
      next(error);
    }
  };

  getConversations = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const query = listConversationsSchema.parse(req.query);
      const scope = await resolveDoctorScope({
        clinicId: req.clinicId!,
        userId: req.user?.userId,
        role: req.user?.role,
        requestedDoctorId: query.doctorId,
      });
      const conversations = await this.service.listConversations({
        clinicId: req.clinicId!,
        state: query.state,
        search: query.search,
        doctorId: scope.restrictToDoctorId || undefined,
      });

      res.json({
        success: true,
        data: conversations,
      });
    } catch (error) {
      next(error);
    }
  };

  getConversationById = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const conversation = await this.service.getConversationById(id, req.clinicId!);

      res.json({
        success: true,
        data: conversation,
      });
    } catch (error) {
      next(error);
    }
  };

  getMessages = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { page, limit } = getMessagesSchema.parse(req.query);
      const messages = await this.service.getMessages(id, req.clinicId!, page, limit);

      res.json({
        success: true,
        data: messages,
      });
    } catch (error) {
      next(error);
    }
  };

  sendStaffMessage = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const body = sendStaffMessageSchema.parse(req.body);

      const message = await this.service.sendStaffMessage({
        clinicId: req.clinicId!,
        conversationId: id,
        content: body.content,
        mediaUrl: body.mediaUrl,
        senderName: req.user?.name || 'Staff',
      });

      res.status(201).json({
        success: true,
        data: message,
      });
    } catch (error) {
      next(error);
    }
  };

  simulateInbound = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const body = simulateInboundSchema.parse(req.body);
      const data = await this.service.simulatePatientMessage(req.clinicId!, id, body.content);
      res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  generateAiReply = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const lastMessages = await this.service.getMessages(id, req.clinicId!, 1, 50);
      const lastPatient = [...lastMessages].reverse().find((m) => m.sender === 'patient');
      if (!lastPatient?.text) {
        res.status(400).json({ success: false, error: { message: 'No patient message to reply to.' } });
        return;
      }
      const data = await this.service.generateAndPersistReply(req.clinicId!, id, lastPatient.text);
      res.status(201).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  };

  markRead = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      await this.service.markAsRead(req.params.id, req.clinicId!);
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  };

  updateConversation = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const data = updateConversationSchema.parse(req.body);

      const updated = await this.service.updateConversation(
        id,
        req.clinicId!,
        data as any,
        {
          userId: req.user?.userId,
          email: req.user?.email,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          requestId: req.correlationId,
        }
      );

      res.json({
        success: true,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  };
}

export const conversationController = new ConversationController();
