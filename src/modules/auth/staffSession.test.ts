import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, any>>,
}));

vi.mock('../../config/db.js', () => ({
  prisma: {
    staffRefreshSession: {
      create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        const row = {
          id: `sess-${db.sessions.length + 1}`,
          revokedAt: null,
          replacedById: null,
          ...data,
        };
        db.sessions.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => {
        return db.sessions.find((row) => row.tokenHash === where.tokenHash) || null;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        return (
          db.sessions.find(
            (row) => row.id === where.id && !row.revokedAt && new Date(row.expiresAt).getTime() > Date.now()
          ) || null
        );
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
        const row = db.sessions.find((item) => item.id === where.id);
        Object.assign(row || {}, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
        let count = 0;
        for (const row of db.sessions) {
          if (where.id && row.id !== where.id) continue;
          if (where.userId && row.userId !== where.userId) continue;
          if (where.tokenHash && row.tokenHash !== where.tokenHash) continue;
          if (where.revokedAt === null && row.revokedAt) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      }),
    },
    user: {
      update: vi.fn(async () => ({ id: 'user-1' })),
    },
  },
}));

vi.mock('../../middleware/audit.js', () => ({ logAuditEvent: vi.fn() }));
vi.mock('../../utils/doctorScope.js', () => ({
  resolveDoctorScope: vi.fn(async () => ({ doctorId: 'doc-1', isPrimary: true, seesAllClinicData: true })),
}));

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  createStaffSession,
  findActiveStaffSession,
  hashRefreshToken,
  parseDurationMs,
  readRefreshCookie,
  refreshCookieOptions,
  rotateStaffSession,
} from './staffSession.js';
import { AuthService } from './auth.service.js';
import { requireAuth } from '../../middleware/auth.js';
import { env } from '../../config/env.js';

describe('staff session helpers', () => {
  it('parses durations and keeps the refresh cookie httpOnly', () => {
    expect(parseDurationMs('15m', 0)).toBe(15 * 60 * 1000);
    expect(parseDurationMs('7d', 0)).toBe(7 * 86_400_000);
    const options = refreshCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.path).toBe('/cgs_api/v1/auth');
    expect(readRefreshCookie('other=1; cgs_staff_refresh=abc%3D')).toBe('abc=');
  });

  it('hashes refresh tokens so the raw value is not what gets stored', () => {
    expect(hashRefreshToken('raw-token')).toHaveLength(64);
    expect(hashRefreshToken('raw-token')).not.toBe('raw-token');
  });
});

describe('staff refresh rotation', () => {
  beforeEach(() => {
    db.sessions.length = 0;
  });

  it('rotates the refresh token and rejects the previous one', async () => {
    const created = await createStaffSession({ userId: 'user-1', clinicId: 'clinic-a' });
    const rotated = await rotateStaffSession(created.refreshToken, {});
    expect(rotated.refreshToken).not.toBe(created.refreshToken);
    expect(rotated.sessionId).not.toBe(created.sessionId);

    const active = await findActiveStaffSession(rotated.sessionId);
    expect(active?.userId).toBe('user-1');
    await expect(findActiveStaffSession(created.sessionId)).resolves.toBeNull();
    await expect(rotateStaffSession(created.refreshToken, {})).rejects.toMatchObject({ code: 'INVALID_REFRESH' });
    expect(db.sessions.filter((row) => !row.revokedAt)).toHaveLength(0);
  });

  it('revokes every session when the password changes', async () => {
    const passwordHash = await bcrypt.hash('old-password', 4);
    await createStaffSession({ userId: 'user-1', clinicId: 'clinic-a' });
    await createStaffSession({ userId: 'user-1', clinicId: 'clinic-a' });
    const service = new AuthService({
      findById: async () => ({ id: 'user-1', passwordHash, status: 'ACTIVE' }),
    } as any);

    await service.changePassword('user-1', 'old-password', 'new-password-1');
    expect(db.sessions.every((row) => row.revokedAt)).toBe(true);
    await expect(service.changePassword('user-1', 'wrong-password', 'new-password-1')).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('rejects a wrong password and an expired access token', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 4);
    const service = new AuthService({
      findAllByEmail: async () => [
        {
          id: 'user-1',
          passwordHash,
          status: 'ACTIVE',
          clinicId: 'clinic-a',
          clinic: { status: 'ACTIVE', name: 'Clinic' },
          firstName: 'Asha',
          lastName: 'R',
          email: 'a@example.com',
          role: 'DOCTOR',
          title: null,
          phone: null,
        },
      ],
      updateLastLogin: async () => undefined,
      findById: async () => null,
    } as any);

    await expect(service.login({ email: 'a@example.com', password: 'nope' }, {})).rejects.toMatchObject({
      statusCode: 401,
    });

    const loggedIn = await service.login({ email: 'a@example.com', password: 'correct-password' }, {});
    expect(loggedIn.accessToken).toBeTruthy();
    expect(loggedIn.refreshToken).toBeTruthy();
    await service.logout({ refreshToken: loggedIn.refreshToken });
    await expect(rotateStaffSession(loggedIn.refreshToken, {})).rejects.toMatchObject({ code: 'INVALID_REFRESH' });

    const expired = jwt.sign(
      {
        userId: 'user-1',
        clinicId: 'clinic-a',
        role: 'DOCTOR',
        email: 'a@example.com',
        name: 'Asha',
        sid: 'sess-1',
        tokenUse: 'staff',
        exp: Math.floor(Date.now() / 1000) - 10,
      },
      env.JWT_SECRET
    );

    const status = await new Promise<number>((resolve, reject) => {
      requireAuth({ headers: { authorization: `Bearer ${expired}` } } as any, {} as any, (err?: any) => {
        if (!err) reject(new Error('expected rejection'));
        else resolve(err.statusCode);
      });
    });
    expect(status).toBe(401);
  });
});
