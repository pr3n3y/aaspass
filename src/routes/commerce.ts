import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { assertApproved, assertRateLimit } from '../lib/guards.js';
import { decodeCursor, encodeCursor } from '../lib/pagination.js';
import { parseBody, requireUser } from './auth.js';
import { presentOrder, repriceDeal, type OwnerOrder } from '../lib/deals.js';

const createOrderSchema = z.object({
  items: z
    .array(
      z.object({
        dealId: z.string().uuid(),
        quantity: z.number().int().positive().max(20),
      }),
    )
    .min(1)
    .max(10),
  deliverySlot: z.enum(['MORNING', 'AFTERNOON', 'EVENING']),
  paymentMethod: z.enum(['COD', 'UPI_ON_DELIVERY']),
  standingProductIds: z.array(z.string().uuid()).optional(),
});

const standingSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive().max(20).default(1),
  paused: z.boolean().optional(),
});

async function loadOwnerOrder(id: string): Promise<OwnerOrder> {
  const order = await prisma.order.findUnique({
    where: { id },
    include: { items: { include: { product: true, deal: true } } },
  });
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'not_found');
  return order;
}

export function registerCommerceRoutes(app: FastifyInstance) {
  app.post('/v1/orders', async (req) => {
    const user = await requireUser(req);
    assertApproved(user);
    if (!user.societyId || !user.buildingId || !user.flatNumber || !user.name) {
      throw new ApiError(400, 'PROFILE_INCOMPLETE', 'profile_incomplete');
    }
    const body = parseBody(createOrderSchema, req.body);
    assertRateLimit(`order:${user.id}`, 30, 60 * 60 * 1000);
    const societyId = user.societyId;
    const buildingId = user.buildingId;
    const flatNumber = user.flatNumber;
    const name = user.name;

    const orderIds = await prisma.$transaction(async (tx) => {
      const building = await tx.building.findUnique({ where: { id: buildingId } });
      const society = await tx.society.findUnique({ where: { id: societyId } });
      const created: string[] = [];
      for (const item of body.items) {
        const deal = await tx.deal.findUnique({
          where: { id: item.dealId },
          include: { tiers: true, product: true, societies: true },
        });
        if (!deal || deal.status !== 'OPEN' || deal.cutoffAt <= new Date()) {
          throw new ApiError(400, 'DEAL_CLOSED', 'deal_closed');
        }
        if (!deal.societies.some((row) => row.societyId === societyId)) {
          throw new ApiError(403, 'FORBIDDEN', 'forbidden');
        }
        if (item.quantity > deal.maxQuantity) throw new ApiError(400, 'QUANTITY_TOO_HIGH', 'quantity_too_high');
        const existing = await tx.orderItem.findFirst({
          where: { dealId: deal.id, order: { userId: user.id, status: { not: 'CANCELLED' } } },
        });
        if (existing) throw new ApiError(409, 'ALREADY_JOINED', 'already_joined');
        const order = await tx.order.create({
          data: {
            userId: user.id,
            societyId,
            paymentMethod: body.paymentMethod,
            deliverySlot: body.deliverySlot,
            addressSnapshot: {
              name,
              buildingName: building?.name ?? '',
              flatNumber,
              societyName: society?.name ?? '',
            },
            totalPaise: 0,
            items: {
              create: {
                dealId: deal.id,
                productId: deal.productId,
                quantity: item.quantity,
                joinedPricePaise: 0,
                mrpPaise: deal.product.mrpPaise,
              },
            },
          },
        });
        await repriceDeal(tx, deal.id);
        created.push(order.id);
      }
      for (const productId of body.standingProductIds ?? []) {
        const current = await tx.standingRequest.findFirst({
          where: { userId: user.id, productId },
        });
        if (current) {
          await tx.standingRequest.update({
            where: { id: current.id },
            data: { paused: false, quantity: 1 },
          });
        } else {
          await tx.standingRequest.create({
            data: { userId: user.id, productId, quantity: 1, paused: false },
          });
        }
      }
      return created;
    });

    const orders = [];
    for (const id of orderIds) orders.push(presentOrder(await loadOwnerOrder(id)));
    return { orders };
  });

  app.get('/v1/orders', async (req) => {
    const user = await requireUser(req);
    const query = z.object({ cursor: z.string().optional() }).parse(req.query);
    const offset = decodeCursor(query.cursor);
    const orders = await prisma.order.findMany({
      where: { userId: user.id },
      include: { items: { include: { product: true, deal: true } } },
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: 20,
    });
    return {
      items: orders.map((order) => presentOrder(order)),
      nextCursor: orders.length === 20 ? encodeCursor(offset + 20) : null,
    };
  });

  app.get('/v1/orders/:id', async (req) => {
    const user = await requireUser(req);
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const order = await loadOwnerOrder(params.id);
    if (order.userId !== user.id && user.role !== 'SUPER_ADMIN') {
      throw new ApiError(404, 'NOT_FOUND', 'not_found');
    }
    if (user.role === 'SUPER_ADMIN') return presentOrder(order);
    return presentOrder(order);
  });

  app.post('/v1/orders/:id/cancel', async (req) => {
    const user = await requireUser(req);
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const order = await prisma.order.findUnique({
      where: { id: params.id },
      include: { items: { include: { deal: true } } },
    });
    if (!order || order.userId !== user.id) throw new ApiError(404, 'NOT_FOUND', 'not_found');
    if (order.status !== 'PLACED') throw new ApiError(400, 'CANNOT_CANCEL', 'cannot_cancel');
    if (order.items.some((item) => item.deal.status !== 'OPEN' || item.deal.cutoffAt <= new Date())) {
      throw new ApiError(400, 'CANNOT_CANCEL', 'cannot_cancel');
    }
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
      for (const item of order.items) await repriceDeal(tx, item.dealId);
    });
    return presentOrder(await loadOwnerOrder(order.id));
  });

  app.post('/v1/standing-requests', async (req) => {
    const user = await requireUser(req);
    assertApproved(user);
    const body = parseBody(standingSchema, req.body);
    const product = await prisma.product.findFirst({ where: { id: body.productId, isActive: true } });
    if (!product) throw new ApiError(404, 'NOT_FOUND', 'not_found');
    const current = await prisma.standingRequest.findFirst({
      where: { userId: user.id, productId: body.productId },
    });
    const saved = current
      ? await prisma.standingRequest.update({
          where: { id: current.id },
          data: { quantity: body.quantity, paused: body.paused ?? current.paused },
        })
      : await prisma.standingRequest.create({
          data: {
            userId: user.id,
            productId: body.productId,
            quantity: body.quantity,
            paused: body.paused ?? false,
          },
        });
    return {
      id: saved.id,
      productId: saved.productId,
      quantity: saved.quantity,
      paused: saved.paused,
    };
  });
}
