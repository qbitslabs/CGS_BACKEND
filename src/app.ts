/* Express app factory: middleware, routers, and error handling.
 * Mounts clinic, admin, internal-AI, and billing APIs. */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import { requestTracing } from './middleware/audit.js';
import { errorHandler } from './middleware/errorHandler.js';

// Route imports
import authRoutes from './modules/auth/auth.routes.js';
import usersRoutes from './modules/users/users.routes.js';
import clinicsRoutes from './modules/clinics/clinics.routes.js';
import leadsRoutes from './modules/leads/leads.routes.js';
import patientsRoutes from './modules/patients/patients.routes.js';
import appointmentsRoutes from './modules/appointments/appointments.routes.js';
import conversationsRoutes from './modules/conversations/conversations.routes.js';
import billingRoutes from './modules/billing/billing.routes.js';
import metaRoutes from './modules/meta/meta.routes.js';
import notificationsRoutes from './modules/notifications/notifications.routes.js';
import auditRoutes from './modules/audit/audit.routes.js';
import internalRoutes from './modules/internal/internal.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';
import { adminController } from './modules/admin/admin.controller.js';
import aiRoutes from './modules/ai/ai.routes.js';
import dashboardRoutes from './modules/dashboard/dashboard.routes.js';

export const createApp = (): express.Application => {
  const app = express();

  // Standard Security & Headers
  app.use(helmet());
  app.use(
    cors({
      origin: [
        env.CLIENT_FRONTEND_URL,
        env.ADMIN_FRONTEND_URL,
        'http://localhost:3000',
        'http://localhost:5173',
        'http://localhost:5174',
        'http://localhost:5175',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:5173',
        'http://127.0.0.1:5174',
        'http://127.0.0.1:5175',
      ],
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Service-Key', 'Idempotency-Key'],
    })
  );

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));
  app.use(requestTracing);

  // Health Checks
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'cgs-backend', timestamp: new Date().toISOString() });
  });

  app.get('/ready', async (_req, res) => {
    try {
      const { prisma } = await import('./config/db.js');
      const started = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        status: 'ready',
        database: 'connected',
        latencyMs: Date.now() - started,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(503).json({ status: 'unready', database: 'disconnected', error: err.message });
    }
  });

  // Business & Control Plane Routes strictly on /cgs_api/v1
  const prefix = '/cgs_api/v1';
  app.use(`${prefix}/auth`, authRoutes);
  app.use(`${prefix}/users`, usersRoutes);
  app.use(`${prefix}/clinics`, clinicsRoutes);
  app.use(`${prefix}/dashboard`, dashboardRoutes);
  app.use(`${prefix}/leads`, leadsRoutes);
  app.use(`${prefix}/patients`, patientsRoutes);
  app.use(`${prefix}/appointments`, appointmentsRoutes);
  app.use(`${prefix}/conversations`, conversationsRoutes);
  app.use(`${prefix}/billing`, billingRoutes);
  app.use(`${prefix}/meta`, metaRoutes);
  app.use(`${prefix}/notifications`, notificationsRoutes);
  app.use(`${prefix}/audit-logs`, auditRoutes);
  app.use(`${prefix}/ai`, aiRoutes);
  app.use(`${prefix}/admin`, adminRoutes);
  app.use(`${prefix}/internal`, internalRoutes);

  // Public clinic landing — resolve clinic by landingPageId
  app.get(`${prefix}/public/landing/:landingPageId`, adminController.getPublicLanding);
  app.post(`${prefix}/public/landing/:landingPageId/enquiry`, adminController.submitPublicLandingEnquiry);

  // Global Error Handler
  app.use(errorHandler);

  return app;
};
