/* CGS patients module — HTTP handlers.
 * Clinic API layer for patients; talks Prisma or callers, not the AI database. */
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../types/index.js';
import { patientService, PatientService } from './patient.service.js';
import { listPatientsSchema, createPatientSchema, updatePatientSchema } from './patient.schema.js';
import { resolveDoctorScope } from '../../utils/doctorScope.js';

export class PatientController {
  constructor(private readonly service: PatientService = patientService) {}

  getPatients = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const query = listPatientsSchema.parse(req.query);
      const scope = await resolveDoctorScope({
        clinicId: req.clinicId!,
        userId: req.user?.userId,
        role: req.user?.role,
        requestedDoctorId: query.doctorId,
      });
      const result = await this.service.listPatients({
        clinicId: req.clinicId!,
        page: query.page,
        limit: query.limit,
        search: query.search,
        status: query.status,
        doctorId: scope.restrictToDoctorId || undefined,
      });

      res.json({
        success: true,
        data: result.data,
        meta: result.meta,
      });
    } catch (error) {
      next(error);
    }
  };

  getPatientById = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const patient = await this.service.getPatientById(id, req.clinicId!);

      res.json({
        success: true,
        data: patient,
      });
    } catch (error) {
      next(error);
    }
  };

  createPatient = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const data = createPatientSchema.parse(req.body);
      const patient = await this.service.createPatient(req.clinicId!, data as any, {
        userId: req.user?.userId,
        email: req.user?.email,
        actorName: req.user?.name || 'Staff',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        requestId: req.correlationId,
      });

      res.status(201).json({
        success: true,
        data: patient,
      });
    } catch (error) {
      next(error);
    }
  };

  updatePatient = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const data = updatePatientSchema.parse(req.body);
      const updated = await this.service.updatePatient(id, req.clinicId!, data as any);

      res.json({
        success: true,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  };
}

export const patientController = new PatientController();
