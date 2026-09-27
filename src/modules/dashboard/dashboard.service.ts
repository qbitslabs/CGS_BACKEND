/* CGS dashboard module — business logic.
 * Clinic API layer for dashboard; talks Prisma or callers, not the AI database. */
import { prisma } from '../../config/db.js';
import {
  clinicDateString,
  clinicDayBoundsUtc,
  clinicTimeString,
  resolveClinicTimezone,
} from '../../utils/timezone.js';

function titleCaseStatus(status?: string | null) {
  if (!status) return 'Scheduled';
  return status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' ');
}

function mapConversationState(state?: string | null) {
  if (state === 'AI_ACTIVE') return 'AI Active';
  if (state === 'HUMAN_ACTIVE') return 'Human Active';
  if (state === 'HANDOFF_PENDING') return 'Handoff Pending';
  return 'Closed';
}

function relativeTime(iso?: string | Date | null) {
  if (!iso) return 'just now';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins || 1} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString();
}

export class DashboardService {
  async getSummary(clinicId: string, doctorId?: string) {
    const clinic = await prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { timezone: true },
    });
    const timeZone = resolveClinicTimezone(clinic?.timezone);
    const todayStr = clinicDateString(new Date(), timeZone);
    const { start, end } = clinicDayBoundsUtc(todayStr, timeZone);

    const [
      leadGroups,
      todayAppointmentsRaw,
      activeConversationsCount,
      attentionConversationsCount,
      recentConversationsRaw,
      recentLeadsRaw,
    ] = await Promise.all([
      doctorId
        ? prisma.lead.findMany({
            where: { clinicId, conversations: { some: { doctorId } } },
            select: { status: true },
          })
        : prisma.lead.groupBy({
            by: ['status'],
            where: { clinicId },
            _count: { _all: true },
          }),
      prisma.appointment.findMany({
        where: { clinicId, startsAt: { gte: start, lte: end }, ...(doctorId ? { doctorId } : {}) },
        select: {
          id: true,
          service: true,
          status: true,
          startsAt: true,
          durationMinutes: true,
          createdAt: true,
          patient: { select: { name: true } },
          doctor: { select: { user: { select: { firstName: true, lastName: true } } } },
        },
        orderBy: { startsAt: 'asc' },
        take: 20,
      }),
      prisma.conversation.count({
        where: {
          clinicId,
          ...(doctorId
            ? { OR: [{ doctorId }, { patient: { appointments: { some: { doctorId } } } }] }
            : {}),
        },
      }),
      prisma.conversation.count({
        where: {
          clinicId,
          OR: [{ unreadCount: { gt: 0 } }, { state: { in: ['AI_ACTIVE', 'HANDOFF_PENDING'] } }],
          ...(doctorId
            ? { AND: [{ OR: [{ doctorId }, { patient: { appointments: { some: { doctorId } } } }] }] }
            : {}),
        },
      }),
      prisma.conversation.findMany({
        where: {
          clinicId,
          ...(doctorId
            ? { OR: [{ doctorId }, { patient: { appointments: { some: { doctorId } } } }] }
            : {}),
        },
        select: {
          id: true,
          participantName: true,
          state: true,
          unreadCount: true,
          lastMessageText: true,
          lastMessageAt: true,
        },
        orderBy: { lastMessageAt: 'desc' },
        take: 4,
      }),
      prisma.lead.findMany({
        where: {
          clinicId,
          ...(doctorId ? { conversations: { some: { doctorId } } } : {}),
        },
        select: {
          id: true,
          name: true,
          status: true,
          interestedService: true,
          source: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 3,
      }),
    ]);

    const funnelCounts: Record<string, number> = {};
    for (const row of leadGroups as any[]) {
      funnelCounts[row.status] = (funnelCounts[row.status] || 0) + (row._count?._all || 1);
    }

    const newLeadsCount = funnelCounts.NEW || 0;
    const bookedCount = (funnelCounts.BOOKED || 0) + (funnelCounts.CONVERTED || 0);
    const lostCount = funnelCounts.LOST || 0;
    const totalLeads = Object.values(funnelCounts).reduce((sum, n) => sum + n, 0);
    const activeLeadsCount = Math.max(0, totalLeads - bookedCount - lostCount);

    const todayAppointments = todayAppointmentsRaw.map((a) => ({
      id: a.id,
      time: clinicTimeString(a.startsAt, timeZone),
      durationMinutes: a.durationMinutes || 30,
      patientName: a.patient?.name || 'Patient',
      service: a.service || 'Consultation',
      doctorName: a.doctor?.user
        ? `${a.doctor.user.firstName.startsWith('Dr.') ? '' : 'Dr. '}${a.doctor.user.firstName} ${a.doctor.user.lastName || ''}`.trim()
        : 'Unassigned',
      status: titleCaseStatus(a.status),
    }));

    const recentConversations = recentConversationsRaw.map((c) => ({
      id: c.id,
      participantName: c.participantName || 'Patient',
      state: mapConversationState(c.state),
      unreadCount: c.unreadCount || 0,
      lastMessage: c.lastMessageText || '',
      lastMessageTime: c.lastMessageAt ? relativeTime(c.lastMessageAt) : 'just now',
    }));

    const activities = [
      ...todayAppointments.slice(0, 4).map((a) => ({
        id: `apt-${a.id}`,
        type: 'appointment' as const,
        title: `${a.status} · ${a.service}`,
        description: `${a.patientName} with ${a.doctorName} on ${todayStr} at ${a.time}`,
        timestamp: relativeTime(todayAppointmentsRaw.find((r) => r.id === a.id)?.createdAt),
        actor: 'Clinic Staff',
      })),
      ...recentLeadsRaw.map((l) => ({
        id: `lead-${l.id}`,
        type: 'created' as const,
        title: `Lead · ${titleCaseStatus(l.status)}`,
        description: `${l.name} · ${l.interestedService || 'General inquiry'} (${titleCaseStatus(l.source)})`,
        timestamp: relativeTime(l.updatedAt),
        actor: 'AI Receptionist',
      })),
      ...recentConversations.slice(0, 3).map((c) => ({
        id: `conv-${c.id}`,
        type: 'message' as const,
        title: `Chat · ${c.state}`,
        description: c.lastMessage || c.participantName,
        timestamp: c.lastMessageTime,
        actor: c.state === 'AI Active' ? 'AI Receptionist' : 'Staff',
      })),
    ].slice(0, 8);

    return {
      newLeadsCount,
      activeLeadsCount,
      todayAppointmentsCount: todayAppointments.length,
      todayConfirmedCount: todayAppointments.filter((a) => a.status === 'Confirmed').length,
      activeConversationsCount,
      attentionConversationsCount,
      funnel: {
        new: newLeadsCount,
        contacted: funnelCounts.CONTACTED || 0,
        qualified: funnelCounts.QUALIFIED || 0,
        appointmentRequested: funnelCounts.APPOINTMENT_REQUESTED || 0,
        booked: bookedCount,
      },
      todayAppointments,
      recentConversations,
      activities,
    };
  }
}

export const dashboardService = new DashboardService();
