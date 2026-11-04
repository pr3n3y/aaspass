import { prisma } from '../lib/prisma.js';
import { notifyUser } from '../lib/notify.js';
import { i18n } from '../lib/i18n.js';
import type { PushProvider } from '../lib/push.js';

let running = false;

export async function runExpiry(push: PushProvider) {
  if (running) return { reminded: 0, expired: 0 };
  running = true;
  try {
    const now = new Date();
    const soon = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    const ending = await prisma.listing.findMany({
      where: { status: 'ACTIVE', expiresAt: { gt: now, lte: soon } },
      include: { seller: true },
      take: 100,
    });
    for (const listing of ending) {
      await notifyUser(prisma, push, listing.seller, {
        type: 'listing_expired',
        title: i18n('Your listing ends soon', 'आपकी लिस्टिंग जल्द बंद होगी', 'तुमची यादी लवकरच बंद होईल'),
        body: i18n(listing.title, listing.title, listing.title),
        data: { dedupe: `soon-${listing.id}`, listingId: listing.id },
      });
    }

    const due = await prisma.listing.findMany({
      where: { status: 'ACTIVE', expiresAt: { lte: now } },
      include: { seller: true },
      take: 100,
    });
    if (due.length) {
      await prisma.listing.updateMany({
        where: { id: { in: due.map((listing) => listing.id) }, status: 'ACTIVE' },
        data: { status: 'EXPIRED' },
      });
    }
    for (const listing of due) {
      await notifyUser(prisma, push, listing.seller, {
        type: 'listing_expired',
        title: i18n('Your listing has ended', 'आपकी लिस्टिंग बंद हो गई', 'तुमची यादी बंद झाली'),
        body: i18n(listing.title, listing.title, listing.title),
        data: { dedupe: `expired-${listing.id}`, listingId: listing.id },
      });
    }
    return { reminded: ending.length, expired: due.length };
  } finally {
    running = false;
  }
}
