import type { Deal, DealTier, Order, OrderItem, Prisma, Product, Vendor } from '@prisma/client';
import { prisma } from './prisma.js';
import {
  bestTier,
  neighboursUntilNextTier,
  nextTier,
  priceForParticipants,
  progressGoal,
  type Tier,
} from './tiers.js';
import { asI18n } from './i18n.js';

export type DealWithRelations = Deal & {
  tiers: DealTier[];
  product: Product;
  vendor: Vendor;
};

const activeOrderFilter: Prisma.OrderWhereInput = { status: { not: 'CANCELLED' } };

export function toTiers(tiers: DealTier[]): Tier[] {
  return tiers.map((tier) => ({
    minParticipants: tier.minParticipants,
    pricePaise: tier.pricePaise,
  }));
}

export async function participantCount(dealId: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
  const items = await db.orderItem.findMany({
    where: { dealId, order: activeOrderFilter },
    select: { order: { select: { userId: true } } },
  });
  return new Set(items.map((item) => item.order.userId)).size;
}

export async function participantCounts(dealIds: string[]) {
  const counts = new Map<string, number>();
  if (dealIds.length === 0) return counts;
  const items = await prisma.orderItem.findMany({
    where: { dealId: { in: dealIds }, order: activeOrderFilter },
    select: { dealId: true, order: { select: { userId: true } } },
  });
  const users = new Map<string, Set<string>>();
  for (const item of items) {
    const set = users.get(item.dealId) ?? new Set<string>();
    set.add(item.order.userId);
    users.set(item.dealId, set);
  }
  for (const id of dealIds) counts.set(id, users.get(id)?.size ?? 0);
  return counts;
}

export function presentDeal(deal: DealWithRelations, participants: number) {
  const tiers = toTiers(deal.tiers);
  const current = bestTier(tiers, participants);
  const upcoming = nextTier(tiers, participants);
  const pricePaise = priceForParticipants(tiers, Math.max(participants, 0));
  const needed = neighboursUntilNextTier(tiers, participants);
  return {
    id: deal.id,
    productId: deal.productId,
    title: asI18n(deal.titleI18n),
    imageUrl: deal.bannerUrl || deal.product.imageUrl,
    unit: asI18n(deal.product.unitI18n),
    mrpPaise: deal.product.mrpPaise,
    currentPricePaise: current?.pricePaise ?? pricePaise,
    participantCount: participants,
    minParticipants: deal.minParticipants,
    maxQuantity: deal.maxQuantity,
    progressGoal: progressGoal(tiers, deal.minParticipants),
    nextTier: upcoming
      ? {
          minParticipants: upcoming.minParticipants,
          pricePaise: upcoming.pricePaise,
          neighboursNeeded: needed,
        }
      : null,
    tiers: tiers.map((tier) => ({
      minParticipants: tier.minParticipants,
      pricePaise: tier.pricePaise,
    })),
    cutoffAt: deal.cutoffAt.toISOString(),
    deliveryDate: deal.deliveryDate.toISOString().slice(0, 10),
    deliverySlot: deal.deliverySlot,
    status: deal.status,
    vendorName: deal.vendor.name,
    vendorVerified: deal.vendor.isVerified,
  };
}

export async function repriceDeal(db: Prisma.TransactionClient, dealId: string) {
  const deal = await db.deal.findUniqueOrThrow({
    where: { id: dealId },
    include: { tiers: true },
  });
  const items = await db.orderItem.findMany({
    where: { dealId, order: { status: 'PLACED' } },
  });
  const participants = await participantCount(dealId, db);
  const price = priceForParticipants(toTiers(deal.tiers), participants);
  for (const item of items) {
    await db.orderItem.update({
      where: { id: item.id },
      data: { joinedPricePaise: price },
    });
  }
  const orderIds = [...new Set(items.map((item) => item.orderId))];
  for (const orderId of orderIds) {
    const orderItems = await db.orderItem.findMany({ where: { orderId } });
    const total = orderItems.reduce((sum, item) => sum + item.joinedPricePaise * item.quantity, 0);
    await db.order.update({ where: { id: orderId }, data: { totalPaise: total } });
  }
  return { participants, pricePaise: price };
}

export function orderTotal(items: Pick<OrderItem, 'joinedPricePaise' | 'quantity' | 'finalPricePaise'>[], useFinal: boolean) {
  return items.reduce((sum, item) => {
    const price = useFinal ? (item.finalPricePaise ?? item.joinedPricePaise) : item.joinedPricePaise;
    return sum + price * item.quantity;
  }, 0);
}

export type OwnerOrder = Order & {
  items: (OrderItem & { product: Product; deal: Deal })[];
};

export function presentOrder(order: OwnerOrder) {
  return {
    id: order.id,
    status: order.status,
    paymentMethod: order.paymentMethod,
    deliverySlot: order.deliverySlot,
    address: order.addressSnapshot,
    totalPaise: order.totalPaise,
    finalTotalPaise: order.finalTotalPaise,
    createdAt: order.createdAt.toISOString(),
    items: order.items.map((item) => ({
      id: item.id,
      dealId: item.dealId,
      productId: item.productId,
      title: asI18n(item.deal.titleI18n),
      imageUrl: item.product.imageUrl,
      quantity: item.quantity,
      joinedPricePaise: item.joinedPricePaise,
      finalPricePaise: item.finalPricePaise,
      mrpPaise: item.mrpPaise,
    })),
  };
}
