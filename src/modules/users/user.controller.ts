/* CGS users module — HTTP handlers.
 * Clinic API layer for users; talks Prisma or callers, not the AI database. */
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../types/index.js';
import { userService, UserService } from './user.service.js';
import { createUserSchema, updateUserStatusSchema, updateUserSchema, createDoctorLeaveSchema } from './user.schema.js';

export class UserController {
  constructor(private readonly service: UserService = userService) {}

  getUsers = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const users = await this.service.listUsers(req.clinicId!);
      res.json({
        success: true,
        data: users,
      });
    } catch (error) {
      next(error);
    }
  };

  createUser = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = createUserSchema.parse(req.body);
      const user = await this.service.createUser(req.clinicId!, data as any, {
        userId: req.user!.userId,
        email: req.user!.email,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.correlationId,
      });

      res.status(201).json({
        success: true,
        data: user,
      });
    } catch (error) {
      next(error);
    }
  };

  updateStatus = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { status } = updateUserStatusSchema.parse(req.body);
      const result = await this.service.updateUserStatus(id, req.clinicId!, status, {
        userId: req.user!.userId,
        email: req.user!.email,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.correlationId,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  updateUser = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const data = updateUserSchema.parse(req.body);
      const result = await this.service.updateUserProfile(id, req.clinicId!, data, {
        userId: req.user!.userId,
        email: req.user!.email,
        role: req.user!.role,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.correlationId,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  getDoctorLeaves = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const doctorId = req.query.doctorId as string | undefined;
      const result = await this.service.listDoctorLeaves(req.clinicId!, doctorId);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  createDoctorLeave = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = createDoctorLeaveSchema.parse(req.body);
      const result = await this.service.createDoctorLeave(req.clinicId!, data, {
        userId: req.user!.userId,
        email: req.user!.email,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.correlationId,
      });

      res.status(201).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };

  deleteDoctorLeave = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const result = await this.service.deleteDoctorLeave(req.clinicId!, id, {
        userId: req.user!.userId,
        email: req.user!.email,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.correlationId,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };
}

export const userController = new UserController();

