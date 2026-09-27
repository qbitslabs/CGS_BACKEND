/* CGS notifications module — TypeScript types.
 * Clinic API layer for notifications; talks Prisma or callers, not the AI database. */
export interface NotificationListQuery {
  clinicId: string;
  userId: string;
  isRead?: boolean;
}
