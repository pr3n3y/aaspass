import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ACCESS_TTL, config, CONSENT_VERSION, OTP_TTL_MS, REFRESH_TTL_MS } from '../config.js';
import { ApiError } from '../lib/errors.js';
import { hashOtp, hashSecret, isIndianMobile, normalizePhone, otpMatches, randomOtp } from '../lib/crypto.js';
import { newRefreshToken } from '../lib/push.js';
import { prisma } from '../lib/prisma.js';
import { assertRateLimit } from '../lib/guards.js';
import type { SmsProvider } from '../lib/sms.js';
import { presentMe } from '../lib/user.js';
import type { User } from '@prisma/client';

const phoneSchema = z.object({
  phone: z.string().min(10).max(16),
});

const verifySchema = phoneSchema.extend({
  code: z.string().regex(/^\d{6}$/),
  language: z.enum(['MR', 'HI', 'EN']).optional(),
});

const loginSchema = phoneSchema.extend({
  language: z.enum(['MR', 'HI', 'EN']).optional(),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(20),
});

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'validation_error');
  return result.data;
}

export async function requireUser(req: FastifyRequest): Promise<User> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new ApiError(401, 'UNAUTHORIZED', 'unauthorized');
  try {
    const payload = (await req.server.jwt.verify(header.slice('Bearer '.length))) as { sub: string };
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.deletedAt) throw new ApiError(401, 'UNAUTHORIZED', 'unauthorized');
    return user;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(401, 'UNAUTHORIZED', 'unauthorized');
  }
}

async function issueTokens(app: FastifyInstance, userId: string, role: string) {
  const accessToken = await app.jwt.sign({ sub: userId, role }, { expiresIn: ACCESS_TTL });
  const refreshToken = newRefreshToken();
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashSecret(refreshToken, config.jwtRefreshSecret),
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return { accessToken, refreshToken };
}

export async function loadMe(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const [society, building, consents] = await Promise.all([
    user.societyId ? prisma.society.findUnique({ where: { id: user.societyId } }) : null,
    user.buildingId ? prisma.building.findUnique({ where: { id: user.buildingId } }) : null,
    prisma.userConsent.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);
  return presentMe(user, society, building, consents);
}

async function loginWithPhone(app: FastifyInstance, phone: string, language?: 'MR' | 'HI' | 'EN') {
  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing?.deletedAt) throw new ApiError(401, 'UNAUTHORIZED', 'unauthorized');
  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: language ? { language } : {},
      })
    : await prisma.user.create({
        data: { phone, language: language ?? 'MR' },
      });
  const tokens = await issueTokens(app, user.id, user.role);
  return { ...tokens, user: await loadMe(user.id) };
}

export function registerAuthRoutes(app: FastifyInstance, sms: SmsProvider) {
  app.post('/v1/auth/phone', async (req) => {
    const body = parseBody(loginSchema, req.body);
    const phone = normalizePhone(body.phone);
    if (!isIndianMobile(phone)) throw new ApiError(400, 'INVALID_PHONE', 'invalid_phone');
    assertRateLimit(`login:phone:${phone}`, 10, 10 * 60 * 1000);
    return loginWithPhone(app, phone, body.language);
  });

  app.post('/v1/auth/otp/request', async (req) => {
    const body = parseBody(phoneSchema, req.body);
    const phone = normalizePhone(body.phone);
    if (!isIndianMobile(phone)) throw new ApiError(400, 'INVALID_PHONE', 'invalid_phone');
    assertRateLimit(`otp:phone:${phone}`, 5, 10 * 60 * 1000);
    assertRateLimit(`otp:ip:${req.ip}`, 20, 10 * 60 * 1000);

    const code = randomOtp();
    await prisma.otpRequest.create({
      data: {
        phone,
        codeHash: hashOtp(code),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });
    await sms.sendOtp(phone, code);
    const devCode = config.smsProvider === 'console' && config.nodeEnv !== 'production' ? code : undefined;
    return { ok: true, expiresInSeconds: OTP_TTL_MS / 1000, devCode };
  });

  app.post('/v1/auth/otp/verify', async (req) => {
    const body = parseBody(verifySchema, req.body);
    const phone = normalizePhone(body.phone);
    if (!isIndianMobile(phone)) throw new ApiError(400, 'INVALID_PHONE', 'invalid_phone');
    assertRateLimit(`otp-verify:${phone}`, 10, 10 * 60 * 1000);

    const otp = await prisma.otpRequest.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp || otp.expiresAt.getTime() < Date.now()) {
      throw new ApiError(400, 'OTP_EXPIRED', 'otp_expired');
    }
    if (otp.attempts >= 5) throw new ApiError(429, 'RATE_LIMITED', 'rate_limited');
    await prisma.otpRequest.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    if (!otpMatches(otp.codeHash, body.code)) throw new ApiError(400, 'INVALID_OTP', 'invalid_otp');
    await prisma.otpRequest.update({ where: { id: otp.id }, data: { expiresAt: new Date(0) } });
    return loginWithPhone(app, phone, body.language);
  });

  app.post('/v1/auth/refresh', async (req) => {
    const body = parseBody(refreshSchema, req.body);
    const tokenHash = hashSecret(body.refreshToken, config.jwtRefreshSecret);
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!stored || stored.revokedAt || stored.expiresAt.getTime() < Date.now()) {
      throw new ApiError(401, 'UNAUTHORIZED', 'unauthorized');
    }
    const user = await prisma.user.findUnique({ where: { id: stored.userId } });
    if (!user || user.deletedAt) throw new ApiError(401, 'UNAUTHORIZED', 'unauthorized');
    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    const tokens = await issueTokens(app, user.id, user.role);
    return tokens;
  });

  app.post('/v1/auth/logout', async (req) => {
    const body = parseBody(refreshSchema, req.body);
    const tokenHash = hashSecret(body.refreshToken, config.jwtRefreshSecret);
    await prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  });
}

export { CONSENT_VERSION };
