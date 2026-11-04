import type { User } from '@prisma/client';
import { ApiError } from './errors.js';

const hits = new Map<string, number[]>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((at) => now - at < windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

export function assertRateLimit(key: string, limit: number, windowMs: number): void {
  if (!rateLimit(key, limit, windowMs)) {
    throw new ApiError(429, 'RATE_LIMITED', 'rate_limited');
  }
}

/** Residents only read their own society. One place for this check. */
export function assertSameSociety(user: Pick<User, 'role' | 'societyId'>, societyId: string): void {
  if (user.role === 'SUPER_ADMIN') return;
  if (!user.societyId || user.societyId !== societyId) {
    throw new ApiError(403, 'FORBIDDEN', 'forbidden');
  }
}

export function assertApproved(user: Pick<User, 'membershipStatus'>): void {
  if (user.membershipStatus !== 'APPROVED') {
    throw new ApiError(403, 'MEMBERSHIP_PENDING', 'membership_pending');
  }
}

export function assertRole(user: Pick<User, 'role'>, roles: Array<User['role']>): void {
  if (!roles.includes(user.role)) {
    throw new ApiError(403, 'FORBIDDEN', 'forbidden');
  }
}
