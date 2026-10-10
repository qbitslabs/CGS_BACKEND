/* Staff refresh sessions: opaque tokens, hashed at rest, rotated on use. */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { AppError } from '../../middleware/errorHandler.js';
import { prisma } from '../../config/db.js';

export const REFRESH_COOKIE = 'cgs_staff_refresh';

export function parseDurationMs(value: string, fallbackMs: number): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(value.trim());
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return amount * multipliers[unit];
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function newRefreshToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function refreshCookieOptions() {
  const maxAge = parseDurationMs(env.STAFF_REFRESH_TOKEN_EXPIRES_IN, 7 * 86_400_000);
  const production = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: production,
    sameSite: (production ? 'none' : 'lax') as 'none' | 'lax',
    path: '/cgs_api/v1/auth',
    maxAge,
  };
}

export function readRefreshCookie(header: string | undefined): string | null {
  if (!header) return null;
  const parts = header.split(';');
  for (const part of parts) {
    const [name, ...rest] = part.trim().split('=');
    if (name === REFRESH_COOKIE) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

export function signStaffAccessToken(payload: {
  userId: string;
  clinicId: string;
  role: string;
  email: string;
  name: string;
  sid: string;
}): string {
  return jwt.sign(
    { ...payload, tokenUse: 'staff' },
    env.JWT_SECRET,
    { expiresIn: env.STAFF_ACCESS_TOKEN_EXPIRES_IN as jwt.SignOptions['expiresIn'] }
  );
}

export async function createStaffSession(input: {
  userId: string;
  clinicId: string;
  userAgent?: string;
  ipAddress?: string;
}): Promise<{ sessionId: string; refreshToken: string }> {
  const refreshToken = newRefreshToken();
  const expiresAt = new Date(Date.now() + parseDurationMs(env.STAFF_REFRESH_TOKEN_EXPIRES_IN, 7 * 86_400_000));
  const session = await prisma.staffRefreshSession.create({
    data: {
      userId: input.userId,
      clinicId: input.clinicId,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt,
      userAgent: input.userAgent,
      ipAddress: input.ipAddress,
    },
    select: { id: true },
  });
  return { sessionId: session.id, refreshToken };
}

export async function findActiveStaffSession(sessionId: string) {
  return prisma.staffRefreshSession.findFirst({
    where: {
      id: sessionId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true, userId: true, clinicId: true },
  });
}

export async function revokeStaffSession(sessionId: string) {
  await prisma.staffRefreshSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllStaffSessions(userId: string) {
  await prisma.staffRefreshSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function rotateStaffSession(rawToken: string, meta: { userAgent?: string; ipAddress?: string }) {
  const tokenHash = hashRefreshToken(rawToken);
  const current = await prisma.staffRefreshSession.findUnique({
    where: { tokenHash },
  });

  if (!current) {
    throw new AppError('Session expired. Please log in again.', 401, 'INVALID_REFRESH');
  }

  if (current.revokedAt) {
    if (current.replacedById) {
      await revokeAllStaffSessions(current.userId);
    }
    throw new AppError('Session expired. Please log in again.', 401, 'INVALID_REFRESH');
  }

  if (current.expiresAt.getTime() <= Date.now()) {
    await revokeStaffSession(current.id);
    throw new AppError('Session expired. Please log in again.', 401, 'INVALID_REFRESH');
  }

  const next = await createStaffSession({
    userId: current.userId,
    clinicId: current.clinicId,
    userAgent: meta.userAgent,
    ipAddress: meta.ipAddress,
  });

  await prisma.staffRefreshSession.update({
    where: { id: current.id },
    data: {
      revokedAt: new Date(),
      replacedById: next.sessionId,
      lastUsedAt: new Date(),
    },
  });

  return { userId: current.userId, clinicId: current.clinicId, sessionId: next.sessionId, refreshToken: next.refreshToken };
}

export async function revokeSessionByRefreshToken(rawToken: string | null) {
  if (!rawToken) return;
  const tokenHash = hashRefreshToken(rawToken);
  await prisma.staffRefreshSession.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
