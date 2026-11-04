import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { assertRole, assertSameSociety } from '../lib/guards.js';
import { i18n } from '../lib/i18n.js';
import { participantCounts, presentDeal } from '../lib/deals.js';
import { notifyUser } from '../lib/notify.js';
import type { PushProvider } from '../lib/push.js';
import { parseBody, requireUser } from './auth.js';
import { runCutoff } from '../jobs/cutoff.js';

const tierSchema = z.object({
  minParticipants: z.number().int().positive(),
  pricePaise: z.number().int().positive(),
});

const patchDealSchema = z.object({
  cutoffAt: z.string().datetime().optional(),
  status: z.enum(['DRAFT', 'OPEN', 'CONFIRMED', 'CANCELLED', 'COMPLETED']).optional(),
  tiers: z.array(tierSchema).min(1).optional(),
  minParticipants: z.number().int().positive().optional(),
});

const createDealSchema = z.object({
  productId: z.string().uuid(),
  title: z.object({ en: z.string().min(1), hi: z.string().min(1), mr: z.string().min(1) }),
  minParticipants: z.number().int().positive(),
  maxQuantity: z.number().int().positive().max(50),
  cutoffAt: z.string().datetime(),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  deliverySlot: z.enum(['MORNING', 'AFTERNOON', 'EVENING']),
  societyIds: z.array(z.string().uuid()).min(1),
  tiers: z.array(tierSchema).min(1),
  bannerUrl: z.string().url().optional(),
});

const statusSchema = z.object({
  status: z.enum(['OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED']),
});

export function registerAdminRoutes(app: FastifyInstance, push: PushProvider) {
  app.get('/v1/admin/deals', async (req) => {
    const user = await requireUser(req);
    assertRole(user, ['SUPER_ADMIN', 'SOCIETY_ADMIN']);
    const deals = await prisma.deal.findMany({
      where:
        user.role === 'SOCIETY_ADMIN' && user.societyId
          ? { societies: { some: { societyId: user.societyId } } }
          : {},
      include: { tiers: true, product: true, vendor: true },
      orderBy: { cutoffAt: 'asc' },
      take: 100,
    });
    const counts = await participantCounts(deals.map((deal) => deal.id));
    return {
      items: deals.map((deal) => ({
        ...presentDeal(deal, counts.get(deal.id) ?? 0),
        participantCount: counts.get(deal.id) ?? 0,
      })),
    };
  });

  app.get('/v1/admin/deals/:id', async (req) => {
    const user = await requireUser(req);
    assertRole(user, ['SUPER_ADMIN', 'SOCIETY_ADMIN']);
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const deal = await prisma.deal.findUnique({
      where: { id: params.id },
      include: { tiers: true, product: true, vendor: true, societies: true },
    });
    if (!deal) throw new ApiError(404, 'NOT_FOUND', 'not_found');
    if (user.role === 'SOCIETY_ADMIN') {
      if (!user.societyId || !deal.societies.some((row) => row.societyId === user.societyId)) {
        throw new ApiError(403, 'FORBIDDEN', 'forbidden');
      }
    }
    const counts = await participantCounts([deal.id]);
    return presentDeal(deal, counts.get(deal.id) ?? 0);
  });

  app.post('/v1/admin/deals', async (req) => {
    const user = await requireUser(req);
    assertRole(user, ['SUPER_ADMIN', 'SOCIETY_ADMIN']);
    const body = parseBody(createDealSchema, req.body);
    if (user.role === 'SOCIETY_ADMIN') {
      if (!user.societyId || body.societyIds.some((id) => id !== user.societyId)) {
        throw new ApiError(403, 'FORBIDDEN', 'forbidden');
      }
    }
    const product = await prisma.product.findUnique({ where: { id: body.productId } });
    if (!product) throw new ApiError(404, 'NOT_FOUND', 'not_found');
    const deal = await prisma.deal.create({
      data: {
        productId: product.id,
        vendorId: product.vendorId,
        titleI18n: body.title,
        bannerUrl: body.bannerUrl ?? product.imageUrl,
        minParticipants: body.minParticipants,
        maxQuantity: body.maxQuantity,
        cutoffAt: new Date(body.cutoffAt),
        deliveryDate: new Date(body.deliveryDate),
        deliverySlot: body.deliverySlot,
        status: 'OPEN',
        createdBy: user.id,
        tiers: { create: body.tiers },
        societies: { create: body.societyIds.map((societyId) => ({ societyId })) },
      },
      include: { tiers: true, product: true, vendor: true },
    });
    await prisma.auditLog.create({
      data: { actorId: user.id, action: 'deal.create', targetType: 'deal', targetId: deal.id },
    });
    return presentDeal(deal, 0);
  });

  app.patch('/v1/admin/deals/:id', async (req) => {
    const user = await requireUser(req);
    assertRole(user, ['SUPER_ADMIN', 'SOCIETY_ADMIN']);
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = parseBody(patchDealSchema, req.body);
    const deal = await prisma.deal.findUnique({
      where: { id: params.id },
      include: { societies: true },
    });
    if (!deal) throw new ApiError(404, 'NOT_FOUND', 'not_found');
    if (user.role === 'SOCIETY_ADMIN') {
      if (!user.societyId || !deal.societies.some((row) => row.societyId === user.societyId)) {
        throw new ApiError(403, 'FORBIDDEN', 'forbidden');
      }
    }
    await prisma.$transaction(async (tx) => {
      await tx.deal.update({
        where: { id: deal.id },
        data: {
          cutoffAt: body.cutoffAt ? new Date(body.cutoffAt) : undefined,
          status: body.status,
          minParticipants: body.minParticipants,
        },
      });
      if (body.tiers) {
        await tx.dealTier.deleteMany({ where: { dealId: deal.id } });
        await tx.dealTier.createMany({
          data: body.tiers.map((tier) => ({ ...tier, dealId: deal.id })),
        });
      }
      await tx.auditLog.create({
        data: { actorId: user.id, action: 'deal.update', targetType: 'deal', targetId: deal.id },
      });
    });
    const updated = await prisma.deal.findUniqueOrThrow({
      where: { id: deal.id },
      include: { tiers: true, product: true, vendor: true },
    });
    const counts = await participantCounts([deal.id]);
    return presentDeal(updated, counts.get(deal.id) ?? 0);
  });

  app.get('/v1/admin/deals/:id/delivery-list', async (req) => {
    const user = await requireUser(req);
    assertRole(user, ['SUPER_ADMIN', 'SOCIETY_ADMIN']);
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const deal = await prisma.deal.findUnique({
      where: { id: params.id },
      include: { societies: true, product: true, tiers: true, vendor: true },
    });
    if (!deal) throw new ApiError(404, 'NOT_FOUND', 'not_found');
    if (user.role === 'SOCIETY_ADMIN') {
      if (!user.societyId || !deal.societies.some((row) => row.societyId === user.societyId)) {
        throw new ApiError(403, 'FORBIDDEN', 'forbidden');
      }
    }
    const items = await prisma.orderItem.findMany({
      where: { dealId: deal.id, order: { status: { not: 'CANCELLED' } } },
      include: { order: true },
    });
    const groups = new Map<string, Array<Record<string, unknown>>>();
    for (const item of items) {
      const address = item.order.addressSnapshot as {
        name?: string;
        buildingName?: string;
        flatNumber?: string;
      };
      if (user.role === 'SOCIETY_ADMIN') assertSameSociety(user, item.order.societyId);
      const buildingName = address.buildingName || 'Building';
      const rows = groups.get(buildingName) ?? [];
      rows.push({
        orderId: item.order.id,
        name: address.name ?? '',
        flatNumber: address.flatNumber ?? '',
        quantity: item.quantity,
        paymentMethod: item.order.paymentMethod,
        status: item.order.status,
        totalPaise: item.order.finalTotalPaise ?? item.order.totalPaise,
      });
      groups.set(buildingName, rows);
    }
    const counts = await participantCounts([deal.id]);
    return {
      deal: presentDeal(deal, counts.get(deal.id) ?? 0),
      groups: [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([buildingName, orders]) => ({
          buildingName,
          orders: orders.sort((a, b) => String(a.flatNumber).localeCompare(String(b.flatNumber))),
        })),
    };
  });

  app.post('/v1/admin/deals/:id/mark-delivered', async (req) => {
    const user = await requireUser(req);
    assertRole(user, ['SUPER_ADMIN', 'SOCIETY_ADMIN']);
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const deal = await prisma.deal.findUnique({
      where: { id: params.id },
      include: { societies: true },
    });
    if (!deal) throw new ApiError(404, 'NOT_FOUND', 'not_found');
    if (user.role === 'SOCIETY_ADMIN' && user.societyId) {
      if (!deal.societies.some((row) => row.societyId === user.societyId)) {
        throw new ApiError(403, 'FORBIDDEN', 'forbidden');
      }
    }
    const orders = await prisma.order.findMany({
      where: {
        status: { in: ['CONFIRMED', 'OUT_FOR_DELIVERY'] },
        items: { some: { dealId: deal.id } },
        ...(user.role === 'SOCIETY_ADMIN' && user.societyId ? { societyId: user.societyId } : {}),
      },
      include: { user: true },
    });
    await prisma.order.updateMany({
      where: { id: { in: orders.map((order) => order.id) } },
      data: { status: 'DELIVERED' },
    });
    const remaining = await prisma.order.count({
      where: {
        status: { in: ['PLACED', 'CONFIRMED', 'OUT_FOR_DELIVERY'] },
        items: { some: { dealId: deal.id } },
      },
    });
    if (remaining === 0 && deal.status === 'CONFIRMED') {
      await prisma.deal.update({ where: { id: deal.id }, data: { status: 'COMPLETED' } });
    }
    await prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: 'deal.mark_delivered',
        targetType: 'deal',
        targetId: deal.id,
        meta: { count: orders.length },
      },
    });
    return { ok: true, updated: orders.length };
  });

  app.patch('/v1/admin/orders/:id/status', async (req) => {
    const user = await requireUser(req);
    assertRole(user, ['SUPER_ADMIN', 'SOCIETY_ADMIN']);
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = parseBody(statusSchema, req.body);
    const order = await prisma.order.findUnique({
      where: { id: params.id },
      include: { user: true, items: true },
    });
    if (!order) throw new ApiError(404, 'NOT_FOUND', 'not_found');
    if (user.role === 'SOCIETY_ADMIN') assertSameSociety(user, order.societyId);
    await prisma.order.update({ where: { id: order.id }, data: { status: body.status } });
    await prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: 'order.status',
        targetType: 'order',
        targetId: order.id,
        meta: { status: body.status },
      },
    });
    if (body.status === 'OUT_FOR_DELIVERY') {
      await notifyUser(prisma, push, order.user, {
        type: 'out_for_delivery',
        title: i18n('Out for delivery', 'डिलीवरी पर है', 'डिलिव्हरीसाठी निघाले'),
        body: i18n(
          'Your group order is on the way. Pay the vendor on delivery.',
          'आपका ऑर्डर रास्ते में है। डिलीवरी पर दुकानदार को पैसे दें।',
          'तुमची ऑर्डर वाटेत आहे. डिलिव्हरीवर दुकानदाराला पैसे द्या.',
        ),
        data: { orderId: order.id },
      });
    }
    if (body.status === 'DELIVERED') {
      const deal = await prisma.deal.findUnique({ where: { id: order.items[0]?.dealId } });
      if (deal && deal.status === 'CONFIRMED') {
        const remaining = await prisma.order.count({
          where: {
            status: { in: ['PLACED', 'CONFIRMED', 'OUT_FOR_DELIVERY'] },
            items: { some: { dealId: deal.id } },
          },
        });
        if (remaining === 0) {
          await prisma.deal.update({ where: { id: deal.id }, data: { status: 'COMPLETED' } });
        }
      }
    }
    return { ok: true, status: body.status };
  });

  app.post('/v1/admin/jobs/cutoff', async (req) => {
    const user = await requireUser(req);
    assertRole(user, ['SUPER_ADMIN']);
    const result = await runCutoff(push);
    return result;
  });

  app.get('/v1/admin/societies/:id/subscription', async (req) => {
    const user = await requireUser(req);
    assertRole(user, ['SUPER_ADMIN']);
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const society = await prisma.society.findUnique({ where: { id: params.id } });
    if (!society) throw new ApiError(404, 'NOT_FOUND', 'not_found');
    return {
      subscriptionStatus: society.subscriptionStatus,
      subscriptionPriceInr: society.subscriptionPriceInr,
    };
  });

  app.patch('/v1/admin/societies/:id/subscription', async (req) => {
    const user = await requireUser(req);
    assertRole(user, ['SUPER_ADMIN']);
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = parseBody(
      z.object({ subscriptionStatus: z.enum(['NONE', 'ACTIVE']) }),
      req.body,
    );
    const society = await prisma.society.update({
      where: { id: params.id },
      data: { subscriptionStatus: body.subscriptionStatus },
    });
    await prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: 'society.subscription',
        targetType: 'society',
        targetId: society.id,
        meta: { subscriptionStatus: body.subscriptionStatus },
      },
    });
    return {
      subscriptionStatus: society.subscriptionStatus,
      subscriptionPriceInr: society.subscriptionPriceInr,
    };
  });
}
