import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { assertApproved, assertSameSociety } from '../lib/guards.js';
import { asI18n, i18n } from '../lib/i18n.js';
import { notifyUser } from '../lib/notify.js';
import { prisma } from '../lib/prisma.js';
import type { PushProvider } from '../lib/push.js';
import { parseBody, requireUser } from './auth.js';

const slot = z.enum(['MORNING', 'AFTERNOON', 'EVENING']);

function waLink(phone: string, text: string) {
  const digits = phone.replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

function ratingTimes10(ratings: number[]): number | null {
  if (ratings.length === 0) return null;
  const sum = ratings.reduce((total, rating) => total + rating, 0);
  return Math.round((sum * 10) / ratings.length);
}

type ProviderRow = {
  id: string;
  name: string;
  phone: string;
  whatsapp: string | null;
  photoUrl: string | null;
  areasServed: string[];
  isVerified: boolean;
  isSponsored: boolean;
  sponsorUntil: Date | null;
  categoryId: string;
  recommendations: { rating: number | null; societyId: string; usedIt: boolean }[];
};

function presentProvider(provider: ProviderRow, societyId: string | null) {
  const inSociety = provider.recommendations.filter((row) => row.usedIt && row.societyId === societyId);
  const ratings = inSociety.map((row) => row.rating).filter((rating): rating is number => rating != null);
  const sponsored =
    provider.isSponsored && (provider.sponsorUntil == null || provider.sponsorUntil.getTime() > Date.now());
  return {
    id: provider.id,
    name: provider.name,
    photoUrl: provider.photoUrl,
    areasServed: provider.areasServed,
    isVerified: provider.isVerified,
    isSponsored: sponsored,
    recommendationCount: inSociety.length,
    ratingTimes10: ratingTimes10(ratings),
    phone: provider.phone,
    whatsapp: provider.whatsapp ?? provider.phone,
    categoryId: provider.categoryId,
  };
}

async function topProvider(categoryId: string, societyId: string) {
  const providers = await prisma.serviceProvider.findMany({
    where: { categoryId, deletedAt: null, isVerified: true },
    include: { recommendations: true },
  });
  const ranked = providers
    .map((provider) => presentProvider(provider, societyId))
    .sort((a, b) => b.recommendationCount - a.recommendationCount || (b.ratingTimes10 ?? 0) - (a.ratingTimes10 ?? 0));
  return ranked[0] ?? null;
}

export function registerServiceRoutes(app: FastifyInstance, push: PushProvider) {
  app.get('/v1/services/types', async (req) => {
    await requireUser(req);
    const items = await prisma.category.findMany({
      where: { kind: 'SERVICE', isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    return {
      items: items.map((category) => ({
        id: category.id,
        name: asI18n(category.nameI18n),
        imageUrl: category.imageUrl,
      })),
    };
  });

  app.get('/v1/services/providers', async (req) => {
    const user = await requireUser(req);
    const query = z.object({ type: z.string().uuid() }).parse(req.query);
    const providers = await prisma.serviceProvider.findMany({
      where: { categoryId: query.type, deletedAt: null, isVerified: true },
      include: { recommendations: true },
    });
    const items = providers
      .map((provider) => presentProvider(provider, user.societyId))
      .sort((a, b) => Number(b.isSponsored) - Number(a.isSponsored) || b.recommendationCount - a.recommendationCount);
    return { items };
  });

  app.post('/v1/services/providers/suggest', async (req) => {
    const user = await requireUser(req);
    assertApproved(user);
    const body = parseBody(
      z.object({
        name: z.string().trim().min(2).max(80),
        phone: z.string().trim().min(10).max(16),
        categoryId: z.string().uuid(),
      }),
      req.body,
    );
    const category = await prisma.category.findFirst({ where: { id: body.categoryId, kind: 'SERVICE' } });
    if (!category) throw new ApiError(400, 'VALIDATION_ERROR', 'validation_error');
    const provider = await prisma.serviceProvider.create({
      data: {
        categoryId: body.categoryId,
        name: body.name,
        phone: body.phone,
        whatsapp: body.phone,
        areasServed: [],
        isVerified: false,
      },
    });
    return { id: provider.id, pending: true };
  });

  app.post('/v1/services/recommendations', async (req) => {
    const user = await requireUser(req);
    assertApproved(user);
    if (!user.societyId) throw new ApiError(400, 'VALIDATION_ERROR', 'validation_error');
    const body = parseBody(
      z.object({
        providerId: z.string().uuid(),
        usedIt: z.boolean(),
        rating: z.number().int().min(1).max(5).optional(),
      }),
      req.body,
    );
    if (body.usedIt && body.rating == null) throw new ApiError(400, 'VALIDATION_ERROR', 'validation_error');
    const provider = await prisma.serviceProvider.findFirst({ where: { id: body.providerId, deletedAt: null } });
    if (!provider) throw new ApiError(404, 'NOT_FOUND', 'not_found');
    await prisma.providerRecommendation.upsert({
      where: { providerId_userId: { providerId: provider.id, userId: user.id } },
      create: {
        providerId: provider.id,
        userId: user.id,
        societyId: user.societyId,
        usedIt: body.usedIt,
        rating: body.usedIt ? body.rating : null,
      },
      update: { usedIt: body.usedIt, rating: body.usedIt ? body.rating : null, societyId: user.societyId },
    });
    return { ok: true };
  });

  app.get('/v1/services/requests', async (req) => {
    const user = await requireUser(req);
    if (!user.societyId) return { items: [] };
    assertSameSociety(user, user.societyId);
    const query = z.object({ mine: z.enum(['1']).optional() }).parse(req.query);
    const requests = await prisma.serviceRequest.findMany({
      where: {
        societyId: user.societyId,
        status: { in: ['OPEN', 'MATCHED'] },
        ...(query.mine ? { OR: [{ requesterId: user.id }, { joiners: { some: { userId: user.id } } }] } : {}),
      },
      include: { serviceType: true, joiners: true, requester: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const items = [];
    for (const request of requests) {
      items.push(await presentRequest(request, user.societyId, user.id));
    }
    return { items };
  });

  app.post('/v1/services/requests', async (req) => {
    const user = await requireUser(req);
    assertApproved(user);
    if (!user.societyId) throw new ApiError(400, 'VALIDATION_ERROR', 'validation_error');
    const body = parseBody(
      z.object({
        serviceTypeId: z.string().uuid(),
        preferredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        preferredSlot: slot,
        note: z.string().trim().max(280).optional(),
        photoUrl: z.string().url().optional(),
        voiceUrl: z.string().url().optional(),
      }),
      req.body,
    );
    const category = await prisma.category.findFirst({ where: { id: body.serviceTypeId, kind: 'SERVICE' } });
    if (!category) throw new ApiError(400, 'VALIDATION_ERROR', 'validation_error');
    const created = await prisma.serviceRequest.create({
      data: {
        societyId: user.societyId,
        requesterId: user.id,
        serviceTypeId: body.serviceTypeId,
        preferredDate: new Date(body.preferredDate),
        preferredSlot: body.preferredSlot,
        note: body.note,
        photoUrl: body.photoUrl,
        voiceUrl: body.voiceUrl,
        joiners: { create: [{ userId: user.id }] },
      },
      include: { serviceType: true, joiners: true, requester: { select: { name: true } } },
    });
    return presentRequest(created, user.societyId, user.id);
  });

  app.post('/v1/services/requests/:id/join', async (req) => {
    const user = await requireUser(req);
    assertApproved(user);
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const request = await prisma.serviceRequest.findUnique({
      where: { id: params.id },
      include: { serviceType: true, joiners: true, requester: true },
    });
    if (!request || request.status === 'CLOSED') throw new ApiError(404, 'NOT_FOUND', 'not_found');
    assertSameSociety(user, request.societyId);
    if (request.joiners.some((joiner) => joiner.userId === user.id)) {
      throw new ApiError(409, 'ALREADY_JOINED', 'already_joined');
    }
    await prisma.serviceRequestJoiner.create({ data: { requestId: request.id, userId: user.id } });
    const count = request.joiners.length + 1;
    if (count >= 2 && request.status === 'OPEN') {
      await prisma.serviceRequest.update({ where: { id: request.id }, data: { status: 'MATCHED' } });
    }
    await notifyUser(prisma, push, request.requester, {
      type: 'need_one_too',
      title: i18n('A neighbour needs this too', 'एक पड़ोसी को भी यही चाहिए', 'एक शेजाऱ्यालाही हे हवे आहे'),
      body: i18n(
        asI18n(request.serviceType.nameI18n).en,
        asI18n(request.serviceType.nameI18n).hi,
        asI18n(request.serviceType.nameI18n).mr,
      ),
      data: { dedupe: `${request.id}-${user.id}`, requestId: request.id },
    });
    const fresh = await prisma.serviceRequest.findUniqueOrThrow({
      where: { id: request.id },
      include: { serviceType: true, joiners: true, requester: { select: { name: true } } },
    });
    return presentRequest(fresh, request.societyId, user.id);
  });
}

async function presentRequest(
  request: {
    id: string;
    societyId: string;
    serviceTypeId: string;
    preferredDate: Date;
    preferredSlot: string;
    note: string | null;
    photoUrl: string | null;
    status: string;
    createdAt: Date;
    serviceType: { nameI18n: unknown };
    joiners: { userId: string }[];
    requester: { name: string | null };
  },
  societyId: string,
  userId: string,
) {
  const suggested = request.joiners.length >= 2 ? await topProvider(request.serviceTypeId, societyId) : null;
  const society = await prisma.society.findUnique({ where: { id: societyId } });
  const serviceName = asI18n(request.serviceType.nameI18n).en;
  const message = `${request.joiners.length} neighbours in ${society?.name ?? 'our society'} need a ${serviceName} on ${request.preferredDate.toISOString().slice(0, 10)} (${request.preferredSlot}).`;
  return {
    id: request.id,
    serviceTypeId: request.serviceTypeId,
    service: asI18n(request.serviceType.nameI18n),
    preferredDate: request.preferredDate.toISOString().slice(0, 10),
    preferredSlot: request.preferredSlot,
    note: request.note,
    photoUrl: request.photoUrl,
    status: request.joiners.length >= 2 ? 'MATCHED' : request.status,
    joinerCount: request.joiners.length,
    joinedByMe: request.joiners.some((joiner) => joiner.userId === userId),
    requesterName: request.requester.name,
    suggestedProvider: suggested
      ? {
          ...suggested,
          whatsappUrl: waLink(suggested.whatsapp, message),
        }
      : null,
  };
}
