import { prisma } from '../lib/prisma.js';
import { notifyUser } from '../lib/notify.js';
import type { PushProvider } from '../lib/push.js';
import { i18n } from '../lib/i18n.js';
import { toTiers } from '../lib/deals.js';
import { decideCutoff } from '../lib/tiers.js';

let running = false;

export async function runCutoff(push: PushProvider): Promise<{ processed: number }> {
  if (running) return { processed: 0 };
  running = true;
  try {
    const now = new Date();
    await warnClosingSoon(push, now);
    const due = await prisma.deal.findMany({
      where: { status: 'OPEN', cutoffAt: { lte: now } },
      include: { tiers: true },
    });
    let processed = 0;
    for (const deal of due) {
      const changed = await finalizeDeal(deal.id, push);
      if (changed) processed += 1;
    }
    return { processed };
  } finally {
    running = false;
  }
}

async function warnClosingSoon(push: PushProvider, now: Date) {
  const soon = new Date(now.getTime() + 30 * 60 * 1000);
  const deals = await prisma.deal.findMany({
    where: { status: 'OPEN', cutoffAt: { gt: now, lte: soon } },
    select: { id: true },
  });
  for (const deal of deals) {
    const items = await prisma.orderItem.findMany({
      where: { dealId: deal.id, order: { status: 'PLACED' } },
      select: { order: { select: { user: true } } },
    });
    const seen = new Set<string>();
    for (const item of items) {
      const user = item.order.user;
      if (seen.has(user.id)) continue;
      seen.add(user.id);
      await notifyUser(prisma, push, user, {
        type: 'deal_closing',
        title: i18n('Deal closing soon', 'ऑफर जल्द बंद होगा', 'ऑफर लवकर बंद होईल'),
        body: i18n(
          'Your group deal closes in about 30 minutes.',
          'आपका ग्रुप ऑफर लगभग 30 मिनट में बंद होगा।',
          'तुमचा ग्रुप ऑफर सुमारे 30 मिनिटांत बंद होईल.',
        ),
        data: { dealId: deal.id },
      });
    }
  }
}

export async function finalizeDeal(dealId: string, push: PushProvider): Promise<boolean> {
  const outcome = await prisma.$transaction(async (tx) => {
    const deal = await tx.deal.findUnique({
      where: { id: dealId },
      include: { tiers: true },
    });
    if (!deal || deal.status !== 'OPEN' || deal.cutoffAt > new Date()) return null;

    const items = await tx.orderItem.findMany({
      where: { dealId, order: { status: 'PLACED' } },
      include: { order: { include: { user: true } } },
    });
    const participants = new Set(items.map((item) => item.order.userId)).size;
    const decision = decideCutoff({
      participantCount: participants,
      minParticipants: deal.minParticipants,
      tiers: toTiers(deal.tiers),
    });

    const claimed = await tx.deal.updateMany({
      where: { id: dealId, status: 'OPEN' },
      data: { status: decision.status === 'CONFIRMED' ? 'CONFIRMED' : 'CANCELLED' },
    });
    if (claimed.count !== 1) return null;

    const orderIds = [...new Set(items.map((item) => item.orderId))];
    if (decision.status === 'CONFIRMED' && decision.pricePaise != null) {
      await tx.orderItem.updateMany({
        where: { id: { in: items.map((item) => item.id) } },
        data: { finalPricePaise: decision.pricePaise, joinedPricePaise: decision.pricePaise },
      });
      for (const orderId of orderIds) {
        const orderItems = await tx.orderItem.findMany({
          where: { orderId },
          include: { deal: true },
        });
        const total = orderItems.reduce(
          (sum, row) => sum + (row.finalPricePaise ?? row.joinedPricePaise) * row.quantity,
          0,
        );
        const stillOpen = orderItems.some((row) => row.deal.status === 'OPEN' || row.deal.status === 'DRAFT');
        await tx.order.update({
          where: { id: orderId },
          data: {
            totalPaise: total,
            finalTotalPaise: stillOpen ? null : total,
            status: stillOpen ? 'PLACED' : 'CONFIRMED',
          },
        });
      }
    } else if (orderIds.length > 0) {
      await tx.order.updateMany({
        where: { id: { in: orderIds }, status: 'PLACED' },
        data: { status: 'CANCELLED', finalTotalPaise: null },
      });
    }

    await tx.auditLog.create({
      data: {
        action: 'deal.cutoff',
        targetType: 'deal',
        targetId: dealId,
        meta: { status: decision.status, participants, pricePaise: decision.pricePaise },
      },
    });

    return {
      status: decision.status,
      pricePaise: decision.pricePaise,
      users: items.map((item) => item.order.user),
    };
  });

  if (!outcome) return false;

  const seen = new Set<string>();
  for (const user of outcome.users) {
    if (seen.has(user.id)) continue;
    seen.add(user.id);
    if (outcome.status === 'CONFIRMED') {
      const rupees = outcome.pricePaise != null ? Math.round(outcome.pricePaise / 100) : 0;
      await notifyUser(prisma, push, user, {
        type: 'deal_confirmed',
        title: i18n('Deal confirmed', 'ऑफर पक्का हुआ', 'ऑफर निश्चित झाले'),
        body: i18n(
          `Pay ₹${rupees} to the vendor on delivery.`,
          `डिलीवरी पर दुकानदार को ₹${rupees} दें।`,
          `डिलिव्हरीवर दुकानदाराला ₹${rupees} द्या.`,
        ),
        data: { dealId },
      });
    } else {
      await notifyUser(prisma, push, user, {
        type: 'deal_cancelled',
        title: i18n('Deal cancelled', 'ऑफर रद्द हुआ', 'ऑफर रद्द झाले'),
        body: i18n(
          'Not enough neighbours joined. You will not be charged.',
          'पर्याप्त पड़ोसी नहीं जुड़े। आपसे पैसे नहीं लगेंगे।',
          'पुरेसे शेजारी सामील झाले नाहीत. पैसे लागणार नाहीत.',
        ),
        data: { dealId },
      });
    }
  }
  return true;
}
