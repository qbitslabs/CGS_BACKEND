/* CGS appointments module — HTTP handlers.
 * Clinic API layer for appointments; talks Prisma or callers, not the AI database. */
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../types/index.js';
import { appointmentService, AppointmentService } from './appointment.service.js';
import { listAppointmentsSchema, createAppointmentSchema, updateAppointmentSchema } from './appointment.schema.js';
import { resolveDoctorScope } from '../../utils/doctorScope.js';

export class AppointmentController {
  constructor(private readonly service: AppointmentService = appointmentService) {}

  getAppointments = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const query = listAppointmentsSchema.parse(req.query);
      const scope = await resolveDoctorScope({
        clinicId: req.clinicId!,
        userId: req.user?.userId,
        role: req.user?.role,
        requestedDoctorId: query.doctorId,
      });
      const appointments = await this.service.listAppointments({
        clinicId: req.clinicId!,
        date: query.date,
        doctorId: scope.restrictToDoctorId || undefined,
        patientId: query.patientId,
        status: query.status,
      });

      res.json({
        success: true,
        data: appointments,
      });
    } catch (error) {
      next(error);
    }
  };

  getAppointmentById = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const appointment = await this.service.getAppointmentById(id, req.clinicId!);
      const scope = await resolveDoctorScope({
        clinicId: req.clinicId!,
        userId: req.user?.userId,
        role: req.user?.role,
      });
      if (scope.restrictToDoctorId && appointment.doctorId !== scope.restrictToDoctorId) {
        res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Appointment not found.' } });
        return;
      }
      res.json({
        success: true,
        data: appointment,
      });
    } catch (error) {
      next(error);
    }
  };

  createAppointment = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = createAppointmentSchema.parse(req.body);
      const scope = await resolveDoctorScope({
        clinicId: req.clinicId!,
        userId: req.user?.userId,
        role: req.user?.role,
      });
      if (scope.restrictToDoctorId) {
        (data as any).doctorId = scope.restrictToDoctorId;
      }
      const appointment = await this.service.createAppointment(req.clinicId!, data as any, {
        userId: req.user?.userId,
        email: req.user?.email,
        actorName: req.user?.name || 'Staff',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.correlationId,
      });

      res.status(201).json({
        success: true,
        data: appointment,
      });
    } catch (error) {
      next(error);
    }
  };

  updateAppointment = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const data = updateAppointmentSchema.parse(req.body);
      const updated = await this.service.updateAppointment(id, req.clinicId!, data as any, {
        userId: req.user?.userId,
        email: req.user?.email,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.correlationId,
      });

      res.json({
        success: true,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  };

  getDoctorAvailability = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const doctorId = req.query.doctorId as string | undefined;
      const date = req.query.date as string | undefined;
      const result = await this.service.getDoctorAvailability(req.clinicId!, doctorId, date);
      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  };
}

export const appointmentController = new AppointmentController();

