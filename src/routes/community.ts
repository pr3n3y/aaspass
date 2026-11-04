import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { assertApproved, assertRole, assertSameSociety } from '../lib/guards.js';
import { i18n } from '../lib/i18n.js';
import { notifyUser } from '../lib/notify.js';
import { prisma } from '../lib/prisma.js';
import type { PushProvider } from '../lib/push.js';
import { parseBody, requireUser } from './auth.js';

function assertCommittee(user: { role: 'RESIDENT' | 'SOCIETY_ADMIN' | 'VENDOR' | 'SUPER_ADMIN'; societyId: string | null; membershipStatus: 'PENDING' | 'APPROVED' | 'REJECTED' }) {
  assertRole(user, ['SOCIETY_ADMIN', 'SUPER_ADMIN']);
  assertApproved(user);
  if (user.role !== 'SUPER_ADMIN' && !user.societyId) throw new ApiError(403, 'FORBIDDEN', 'forbidden');
}

export function registerCommunityRoutes(app: FastifyInstance, push: PushProvider) {
  app.post('/v1/notices', async (req) => {
    const user = await requireUser(req);
    assertCommittee(user);
    const body = parseBody(
      z.object({
        title: z.string().trim().min(2).max(80),
        body: z.string().trim().min(2).max(500),
        category: z.enum(['MAINTENANCE', 'WATER', 'MEETING', 'FESTIVAL', 'EMERGENCY', 'GENERAL']).default('GENERAL'),
        isPinned: z.boolean().default(false),
        isEmergency: z.boolean().default(false),
        imageUrl: z.string().url().optional(),
        societyId: z.string().uuid().optional(),
      }),
      req.body,
    );
    const societyId = user.role === 'SUPER_ADMIN' ? body.societyId ?? user.societyId : user.societyId;
    if (!societyId) throw new ApiError(400, 'VALIDATION_ERROR', 'validation_error');
    if (user.role !== 'SUPER_ADMIN') assertSameSociety(user, societyId);
    const emergency = body.isEmergency || body.category === 'EMERGENCY';
    const notice = await prisma.notice.create({
      data: {
        societyId,
        authorId: user.id,
        title: body.title,
        body: body.body,
        category: emergency ? 'EMERGENCY' : body.category,
        isPinned: body.isPinned || emergency,
        isEmergency: emergency,
        imageUrl: body.imageUrl,
      },
    });
    const residents = await prisma.user.findMany({
      where: { societyId, membershipStatus: 'APPROVED', deletedAt: null, id: { not: user.id } },
    });
    const title = i18n(notice.title, notice.title, notice.title);
    const message = i18n(notice.body, notice.body, notice.body);
    for (const resident of residents) {
      await notifyUser(prisma, push, resident, {
        type: emergency ? 'emergency' : 'notice',
        title,
        body: message,
        data: { dedupe: notice.id, noticeId: notice.id },
      });
    }
    return {
      id: notice.id,
      title: notice.title,
      body: notice.body,
      category: notice.category,
      isPinned: notice.isPinned,
      isEmergency: notice.isEmergency,
      createdAt: notice.createdAt.toISOString(),
    };
  });

  app.get('/v1/events', async (req) => {
    const user = await requireUser(req);
    if (!user.societyId) return { items: [] };
    assertSameSociety(user, user.societyId);
    const events = await prisma.event.findMany({
      where: { societyId: user.societyId },
      include: { rsvps: true },
      orderBy: { eventDate: 'asc' },
      take: 30,
    });
    return {
      items: events.map((event) => ({
        id: event.id,
        title: event.title,
        place: event.place,
        imageUrl: event.imageUrl,
        eventDate: event.eventDate.toISOString(),
        attendeeCount: event.rsvps.length,
        going: event.rsvps.some((rsvp) => rsvp.userId === user.id),
      })),
    };
  });

  app.post('/v1/events', async (req) => {
    const user = await requireUser(req);
    assertCommittee(user);
    const body = parseBody(
      z.object({
        title: z.string().trim().min(2).max(80),
        place: z.string().trim().min(2).max(80),
        eventDate: z.string().datetime(),
        imageUrl: z.string().url().optional(),
      }),
      req.body,
    );
    if (!user.societyId) throw new ApiError(400, 'VALIDATION_ERROR', 'validation_error');
    const event = await prisma.event.create({
      data: {
        societyId: user.societyId,
        title: body.title,
        place: body.place,
        eventDate: new Date(body.eventDate),
        imageUrl: body.imageUrl,
      },
    });
    return { id: event.id };
  });

  app.post('/v1/events/:id/rsvp', async (req) => {
    const user = await requireUser(req);
    assertApproved(user);
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const event = await prisma.event.findUnique({ where: { id: params.id }, include: { rsvps: true } });
    if (!event) throw new ApiError(404, 'NOT_FOUND', 'not_found');
    assertSameSociety(user, event.societyId);
    const going = event.rsvps.some((rsvp) => rsvp.userId === user.id);
    if (going) {
      await prisma.eventRsvp.delete({ where: { eventId_userId: { eventId: event.id, userId: user.id } } });
    } else {
      await prisma.eventRsvp.create({ data: { eventId: event.id, userId: user.id } });
    }
    return { going: !going, attendeeCount: event.rsvps.length + (going ? -1 : 1) };
  });

  app.get('/v1/polls', async (req) => {
    const user = await requireUser(req);
    if (!user.societyId) return { items: [] };
    assertSameSociety(user, user.societyId);
    const polls = await prisma.poll.findMany({
      where: { societyId: user.societyId },
      include: { options: { include: { votes: true } }, votes: true },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return {
      items: polls.map((poll) => ({
        id: poll.id,
        question: poll.question,
        votedOptionId: poll.votes.find((vote) => vote.userId === user.id)?.optionId ?? null,
        options: poll.options.map((option) => ({
          id: option.id,
          label: option.label,
          votes: option.votes.length,
        })),
      })),
    };
  });

  app.post('/v1/polls', async (req) => {
    const user = await requireUser(req);
    assertCommittee(user);
    const body = parseBody(
      z.object({
        question: z.string().trim().min(2).max(140),
        options: z.array(z.string().trim().min(1).max(40)).min(2).max(4),
      }),
      req.body,
    );
    if (!user.societyId) throw new ApiError(400, 'VALIDATION_ERROR', 'validation_error');
    const poll = await prisma.poll.create({
      data: {
        societyId: user.societyId,
        question: body.question,
        options: { create: body.options.map((label) => ({ label })) },
      },
    });
    return { id: poll.id };
  });

  app.post('/v1/polls/:id/vote', async (req) => {
    const user = await requireUser(req);
    assertApproved(user);
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = parseBody(z.object({ optionId: z.string().uuid() }), req.body);
    const poll = await prisma.poll.findUnique({ where: { id: params.id }, include: { options: true } });
    if (!poll) throw new ApiError(404, 'NOT_FOUND', 'not_found');
    assertSameSociety(user, poll.societyId);
    if (!poll.options.some((option) => option.id === body.optionId)) throw new ApiError(400, 'VALIDATION_ERROR', 'validation_error');
    await prisma.pollVote.upsert({
      where: { pollId_userId: { pollId: poll.id, userId: user.id } },
      create: { pollId: poll.id, optionId: body.optionId, userId: user.id },
      update: { optionId: body.optionId },
    });
    return { ok: true };
  });

  app.get('/v1/lost-found', async (req) => {
    const user = await requireUser(req);
    if (!user.societyId) return { items: [] };
    assertSameSociety(user, user.societyId);
    const items = await prisma.lostFoundItem.findMany({
      where: { societyId: user.societyId },
      orderBy: { createdAt: 'desc' },
      take: 40,
    });
    return {
      items: items.map((item) => ({
        id: item.id,
        type: item.type,
        description: item.description,
        photoUrl: item.photoUrl,
        createdAt: item.createdAt.toISOString(),
      })),
    };
  });

  app.post('/v1/lost-found', async (req) => {
    const user = await requireUser(req);
    assertApproved(user);
    if (!user.societyId) throw new ApiError(400, 'VALIDATION_ERROR', 'validation_error');
    const body = parseBody(
      z.object({
        type: z.enum(['LOST', 'FOUND']),
        description: z.string().trim().min(2).max(280),
        photoUrl: z.string().url().optional(),
      }),
      req.body,
    );
    const item = await prisma.lostFoundItem.create({
      data: { societyId: user.societyId, type: body.type, description: body.description, photoUrl: body.photoUrl },
    });
    return { id: item.id };
  });

  app.post('/v1/suggestions', async (req) => {
    const user = await requireUser(req);
    assertApproved(user);
    if (!user.societyId) throw new ApiError(400, 'VALIDATION_ERROR', 'validation_error');
    const body = parseBody(z.object({ body: z.string().trim().min(2).max(500) }), req.body);
    const suggestion = await prisma.suggestion.create({
      data: { societyId: user.societyId, userId: user.id, body: body.body },
    });
    return { id: suggestion.id };
  });

  app.get('/v1/suggestions', async (req) => {
    const user = await requireUser(req);
    assertCommittee(user);
    if (!user.societyId) return { items: [] };
    const items = await prisma.suggestion.findMany({
      where: { societyId: user.societyId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { items: items.map((item) => ({ id: item.id, body: item.body, createdAt: item.createdAt.toISOString() })) };
  });

  app.post('/v1/reports', async (req) => {
    const user = await requireUser(req);
    const body = parseBody(
      z.object({
        targetType: z.enum(['listing', 'provider', 'notice']),
        targetId: z.string().uuid(),
        reason: z.string().trim().min(2).max(200),
      }),
      req.body,
    );
    const report = await prisma.report.create({
      data: { reporterId: user.id, targetType: body.targetType, targetId: body.targetId, reason: body.reason },
    });
    return { id: report.id };
  });

  app.post('/v1/blocks', async (req) => {
    const user = await requireUser(req);
    const body = parseBody(z.object({ userId: z.string().uuid() }), req.body);
    if (body.userId === user.id) throw new ApiError(400, 'VALIDATION_ERROR', 'validation_error');
    await prisma.block.upsert({
      where: { blockerId_blockedId: { blockerId: user.id, blockedId: body.userId } },
      create: { blockerId: user.id, blockedId: body.userId },
      update: {},
    });
    return { ok: true };
  });
}
