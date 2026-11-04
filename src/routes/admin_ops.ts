import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { assertRole, assertSameSociety } from '../lib/guards.js';
import { i18n } from '../lib/i18n.js';
import { prisma } from '../lib/prisma.js';
import { parseBody, requireUser } from './auth.js';

function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function csvCell(value: string | number) {
  const text = String(value);
  if (text.includes(',') || text.includes('"') || text.includes('\n')) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function registerAdminOpsRoutes(app: FastifyInstance) {
  app.get('/v1/admin/residents', async (req) => {
    const user = await requireUser(req);
    assertRole(user, ['SUPER_ADMIN', 'SOCIETY_ADMIN']);
    const query = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING') }).parse(req.query);
    const residents = await prisma.user.findMany({
      where: {
        membershipStatus: query.status,
        role: 'RESIDENT',
        ...(user.role === 'SOCIETY_ADMIN' ? { societyId: user.societyId ?? 'none' } : {}),
      },
      include: { building: true, society: true },
      take: 100,
    });
    return {
      items: residents.map((resident) => ({
        id: resident.id,
        name: resident.name,
        phone: resident.phone,
        flatNumber: resident.flatNumber,
        buildingName: resident.building?.name ?? '',
        societyName: resident.society?.name ?? '',
        membershipStatus: resident.membershipStatus,
      })),
    };
  });

  app.patch('/v1/admin/residents/:id', async (req) => {
    const user = await requireUser(req);
    assertRole(user, ['SUPER_ADMIN', 'SOCIETY_ADMIN']);
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = parseBody(z.object({ membershipStatus: z.enum(['APPROVED', 'REJECTED']) }), req.body);
    const resident = await prisma.user.findUnique({ where: { id: params.id } });
    if (!resident?.societyId) throw new ApiError(404, 'NOT_FOUND', 'not_found');
    if (user.role === 'SOCIETY_ADMIN') assertSameSociety(user, resident.societyId);
    await prisma.user.update({ where: { id: resident.id }, data: { membershipStatus: body.membershipStatus } });
    await prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: 'resident.membership',
        targetType: 'user',
        targetId: resident.id,
        meta: { membershipStatus: body.membershipStatus },
      },
    });
    return { ok: true };
  });

  app.get('/v1/admin/ads', async (req) => {
    const user = await requireUser(req);
    assertRole(user, ['SUPER_ADMIN']);
    const ads = await prisma.ad.findMany({ include: { stats: true }, orderBy: { createdAt: 'desc' }, take: 50 });
    return {
      items: ads.map((ad) => ({
        id: ad.id,
        advertiserName: ad.advertiserName,
        kind: ad.kind,
        title: ad.titleI18n,
        imageUrl: ad.imageUrl,
        actionType: ad.actionType,
        actionValue: ad.actionValue,
        startAt: ad.startAt.toISOString(),
        endAt: ad.endAt.toISOString(),
        dailyImpressionCap: ad.dailyImpressionCap,
        status: ad.status,
        impressions: ad.stats.reduce((sum, row) => sum + row.impressions, 0),
        taps: ad.stats.reduce((sum, row) => sum + row.taps, 0),
      })),
    };
  });

  app.post('/v1/admin/ads', async (req) => {
    const user = await requireUser(req);
    assertRole(user, ['SUPER_ADMIN']);
    const body = parseBody(
      z.object({
        advertiserName: z.string().trim().min(2).max(80),
        kind: z.enum(['VENDOR_STRIP', 'DEAL_CARD', 'PROVIDER_FEATURE', 'ORDER_BANNER']),
        title: z.string().trim().min(2).max(80),
        imageUrl: z.string().url(),
        actionType: z.enum(['URL', 'CALL', 'WHATSAPP', 'DEAL']),
        actionValue: z.string().trim().min(1).max(200),
        dailyImpressionCap: z.number().int().positive().max(100000),
        targetSocietyIds: z.array(z.string().uuid()).default([]),
        days: z.number().int().positive().max(90).default(30),
      }),
      req.body,
    );
    const startAt = new Date();
    const endAt = new Date(startAt.getTime() + (body.days ?? 30) * 24 * 60 * 60 * 1000);
    const ad = await prisma.ad.create({
      data: {
        advertiserName: body.advertiserName,
        kind: body.kind,
        titleI18n: i18n(body.title, body.title, body.title),
        imageUrl: body.imageUrl,
        actionType: body.actionType,
        actionValue: body.actionValue,
        startAt,
        endAt,
        dailyImpressionCap: body.dailyImpressionCap,
        targetSocietyIds: body.targetSocietyIds,
        status: 'ACTIVE',
      },
    });
    await prisma.auditLog.create({
      data: { actorId: user.id, action: 'ad.create', targetType: 'ad', targetId: ad.id },
    });
    return { id: ad.id };
  });

  app.get('/v1/admin/ads/report', async (req) => {
    const user = await requireUser(req);
    assertRole(user, ['SUPER_ADMIN']);
    const stats = await prisma.adStatDaily.findMany({ include: { ad: true }, orderBy: { date: 'desc' }, take: 200 });
    return {
      items: stats.map((row) => ({
        adId: row.adId,
        advertiserName: row.ad.advertiserName,
        kind: row.ad.kind,
        date: row.date.toISOString().slice(0, 10),
        impressions: row.impressions,
        taps: row.taps,
      })),
    };
  });

  app.get('/v1/admin/ads/report.csv', async (req, reply) => {
    const user = await requireUser(req);
    assertRole(user, ['SUPER_ADMIN']);
    const stats = await prisma.adStatDaily.findMany({ include: { ad: true }, orderBy: { date: 'desc' }, take: 500 });
    const lines = ['date,advertiser,kind,impressions,taps'];
    for (const row of stats) {
      lines.push(
        [row.date.toISOString().slice(0, 10), row.ad.advertiserName, row.ad.kind, row.impressions, row.taps]
          .map(csvCell)
          .join(','),
      );
    }
    reply.header('content-type', 'text/csv; charset=utf-8');
    return reply.send(lines.join('\n'));
  });

  app.get('/v1/admin/reports', async (req) => {
    const user = await requireUser(req);
    assertRole(user, ['SUPER_ADMIN', 'SOCIETY_ADMIN']);
    const reports = await prisma.report.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    return {
      items: reports.map((report) => ({
        id: report.id,
        targetType: report.targetType,
        targetId: report.targetId,
        reason: report.reason,
        status: report.status,
        createdAt: report.createdAt.toISOString(),
      })),
    };
  });

  app.post('/v1/admin/reports/:id/action', async (req) => {
    const user = await requireUser(req);
    assertRole(user, ['SUPER_ADMIN', 'SOCIETY_ADMIN']);
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = parseBody(z.object({ action: z.enum(['REMOVE', 'DISMISS']) }), req.body);
    const report = await prisma.report.findUnique({ where: { id: params.id } });
    if (!report) throw new ApiError(404, 'NOT_FOUND', 'not_found');
    if (body.action === 'REMOVE' && report.targetType === 'listing') {
      const listing = await prisma.listing.findUnique({ where: { id: report.targetId } });
      if (listing) {
        if (user.role === 'SOCIETY_ADMIN') assertSameSociety(user, listing.societyId);
        await prisma.listing.update({ where: { id: listing.id }, data: { status: 'REMOVED' } });
      }
    }
    await prisma.report.update({
      where: { id: report.id },
      data: { status: body.action === 'REMOVE' ? 'ACTIONED' : 'DISMISSED' },
    });
    await prisma.auditLog.create({
      data: { actorId: user.id, action: 'report.action', targetType: report.targetType, targetId: report.targetId, meta: body },
    });
    return { ok: true };
  });

  app.get('/v1/admin/analytics/dashboard', async (req) => {
    const user = await requireUser(req);
    assertRole(user, ['SUPER_ADMIN', 'SOCIETY_ADMIN']);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
    const societyWhere = user.role === 'SOCIETY_ADMIN' && user.societyId ? { societyId: user.societyId } : {};
    const [active, newResidents, orders, dealGroups, adSums, events, cohort, cohortActive] = await Promise.all([
      prisma.user.count({
        where: { ...societyWhere, deletedAt: null, lastSeenAt: { gte: weekAgo }, role: { in: ['RESIDENT', 'SOCIETY_ADMIN'] } },
      }),
      prisma.user.count({ where: { ...societyWhere, createdAt: { gte: weekAgo }, role: 'RESIDENT' } }),
      prisma.order.findMany({
        where: { ...(user.role === 'SOCIETY_ADMIN' && user.societyId ? { societyId: user.societyId } : {}), createdAt: { gte: weekAgo } },
        select: { userId: true, status: true },
      }),
      prisma.deal.groupBy({
        by: ['status'],
        _count: true,
        where: user.role === 'SOCIETY_ADMIN' && user.societyId ? { societies: { some: { societyId: user.societyId } } } : {},
      }),
      prisma.adStatDaily.aggregate({ _sum: { impressions: true, taps: true } }),
      prisma.analyticsEvent.groupBy({ by: ['name'], _count: true, where: { createdAt: { gte: weekAgo } } }),
      prisma.user.count({
        where: { ...societyWhere, role: 'RESIDENT', createdAt: { gte: new Date(Date.now() - 35 * 86400000), lt: monthAgo } },
      }),
      prisma.user.count({
        where: {
          ...societyWhere,
          role: 'RESIDENT',
          createdAt: { gte: new Date(Date.now() - 35 * 86400000), lt: monthAgo },
          lastSeenAt: { gte: weekAgo },
        },
      }),
    ]);
    const byUser = new Map<string, number>();
    for (const order of orders) byUser.set(order.userId, (byUser.get(order.userId) ?? 0) + 1);
    const buyers = byUser.size;
    const repeatBuyers = [...byUser.values()].filter((count) => count >= 2).length;
    const confirmed = dealGroups.find((row) => row.status === 'CONFIRMED')?._count ?? 0;
    const cancelled = dealGroups.find((row) => row.status === 'CANCELLED')?._count ?? 0;
    const impressions = adSums._sum.impressions ?? 0;
    const taps = adSums._sum.taps ?? 0;
    return {
      weeklyActiveResidents: active,
      newResidents,
      orders: orders.length,
      repeatOrderRate: buyers === 0 ? 0 : Math.round((repeatBuyers * 100) / buyers),
      dealFillRate: confirmed + cancelled === 0 ? 0 : Math.round((confirmed * 100) / (confirmed + cancelled)),
      sponsoredTapRate: impressions === 0 ? 0 : Math.round((taps * 1000) / impressions) / 10,
      week4Retention: cohort === 0 ? 0 : Math.round((cohortActive * 100) / cohort),
      features: events.map((row) => ({ name: row.name, count: row._count })),
      asOf: todayUtc().toISOString().slice(0, 10),
    };
  });
}
