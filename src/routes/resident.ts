import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CONSENT_VERSION } from '../config.js';
import { ApiError } from '../lib/errors.js';
import { asI18n, escapeLike, normalizeQuery } from '../lib/i18n.js';
import { prisma } from '../lib/prisma.js';
import { assertSameSociety } from '../lib/guards.js';
import { decodeCursor, encodeCursor } from '../lib/pagination.js';
import { loadMe, parseBody, requireUser } from './auth.js';
import { participantCounts, presentDeal, type DealWithRelations } from '../lib/deals.js';

const joinSchema = z.object({
  societyId: z.string().uuid().optional(),
  code: z.string().trim().min(6).max(6).optional(),
  name: z.string().trim().min(2).max(80),
  buildingId: z.string().uuid(),
  flatNumber: z.string().trim().min(1).max(20),
  consents: z
    .array(
      z.object({
        type: z.enum(['TERMS', 'PRIVACY', 'PROMOTIONS']),
        granted: z.boolean(),
      }),
    )
    .min(2),
});

const consentSchema = z.object({
  consents: joinSchema.shape.consents,
});

const patchMeSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  language: z.enum(['MR', 'HI', 'EN']).optional(),
  photoUrl: z.string().url().nullable().optional(),
});

function societyCard(society: {
  id: string;
  name: string;
  area: string;
  city: string;
  buildings: { id: string; name: string }[];
}) {
  return {
    id: society.id,
    name: society.name,
    area: society.area,
    city: society.city,
    buildings: society.buildings.map((building) => ({ id: building.id, name: building.name })),
  };
}

async function searchProductIds(query: string): Promise<string[]> {
  const like = `%${escapeLike(query)}%`;
  try {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT p.id::text AS id
      FROM products p
      WHERE p.is_active = true
        AND (
          EXISTS (
            SELECT 1 FROM unnest(p.search_keywords) kw
            WHERE kw ILIKE ${like} ESCAPE '\\'
               OR similarity(lower(kw), ${query}) > 0.3
          )
          OR lower(p.name_i18n::text) LIKE ${like} ESCAPE '\\'
        )
      LIMIT 20
    `;
    return rows.map((row) => row.id);
  } catch {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT p.id::text AS id
      FROM products p
      WHERE p.is_active = true
        AND (
          EXISTS (
            SELECT 1 FROM unnest(p.search_keywords) kw
            WHERE kw ILIKE ${like} ESCAPE '\\'
          )
          OR lower(p.name_i18n::text) LIKE ${like} ESCAPE '\\'
        )
      LIMIT 20
    `;
    return rows.map((row) => row.id);
  }
}

async function searchCategoryIds(query: string): Promise<string[]> {
  const like = `%${escapeLike(query)}%`;
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT c.id::text AS id
    FROM categories c
    WHERE c.is_active = true
      AND (
        EXISTS (
          SELECT 1 FROM unnest(c.search_keywords) kw
          WHERE kw ILIKE ${like} ESCAPE '\\'
        )
        OR lower(c.name_i18n::text) LIKE ${like} ESCAPE '\\'
      )
    LIMIT 20
  `;
  return rows.map((row) => row.id);
}

function weekKey(date: Date): string {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  const utc = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-${week}`;
}

export async function savingsSummary(userId: string) {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const items = await prisma.orderItem.findMany({
    where: { order: { userId, status: 'DELIVERED', updatedAt: { gte: start } } },
  });
  const savedPaiseThisMonth = items.reduce((sum, item) => {
    const paid = item.finalPricePaise ?? item.joinedPricePaise;
    return sum + Math.max(0, item.mrpPaise - paid) * item.quantity;
  }, 0);
  const delivered = await prisma.order.findMany({
    where: { userId, status: 'DELIVERED' },
    select: { updatedAt: true },
  });
  const weeks = new Set(delivered.map((order) => weekKey(order.updatedAt)));
  let streakWeeks = 0;
  const cursor = new Date();
  for (let i = 0; i < 12; i += 1) {
    if (!weeks.has(weekKey(cursor))) break;
    streakWeeks += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 7);
  }
  return { savedPaiseThisMonth, streakWeeks };
}

async function dealsForSociety(societyId: string | null) {
  if (!societyId) return [];
  const deals = await prisma.deal.findMany({
    where: {
      status: { in: ['OPEN', 'CONFIRMED'] },
      societies: { some: { societyId } },
    },
    include: { tiers: true, product: true, vendor: true },
    orderBy: { cutoffAt: 'asc' },
    take: 20,
  });
  const counts = await participantCounts(deals.map((deal) => deal.id));
  return deals.map((deal) => presentDeal(deal as DealWithRelations, counts.get(deal.id) ?? 0));
}

function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function registerResidentRoutes(app: FastifyInstance) {
  app.get('/v1/societies', async (req) => {
    const query = z
      .object({ search: z.string().optional(), cursor: z.string().optional() })
      .parse(req.query);
    const offset = decodeCursor(query.cursor);
    const search = query.search?.trim();
    const societies = await prisma.society.findMany({
      where: {
        isActive: true,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { area: { contains: search, mode: 'insensitive' } },
                { city: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      include: { buildings: { orderBy: { name: 'asc' } } },
      orderBy: { name: 'asc' },
      skip: offset,
      take: 20,
    });
    return {
      items: societies.map(societyCard),
      nextCursor: societies.length === 20 ? encodeCursor(offset + 20) : null,
    };
  });

  app.get('/v1/societies/by-code/:code', async (req) => {
    const params = z.object({ code: z.string().length(6) }).parse(req.params);
    const society = await prisma.society.findFirst({
      where: { code: params.code.toUpperCase(), isActive: true },
      include: { buildings: { orderBy: { name: 'asc' } } },
    });
    if (!society) throw new ApiError(404, 'NOT_FOUND', 'society_not_found');
    return societyCard(society);
  });

  app.get('/v1/me', async (req) => {
    const user = await requireUser(req);
    await prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } });
    return loadMe(user.id);
  });

  app.patch('/v1/me', async (req) => {
    const user = await requireUser(req);
    const body = parseBody(patchMeSchema, req.body);
    await prisma.user.update({ where: { id: user.id }, data: body });
    return loadMe(user.id);
  });

  app.post('/v1/me/fcm-token', async (req) => {
    const user = await requireUser(req);
    const body = parseBody(z.object({ token: z.string().min(8).max(512) }), req.body);
    await prisma.user.update({ where: { id: user.id }, data: { fcmToken: body.token } });
    return { ok: true };
  });

  app.get('/v1/me/consents', async (req) => {
    const user = await requireUser(req);
    const consents = await prisma.userConsent.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
    return { items: consents };
  });

  app.put('/v1/me/consents', async (req) => {
    const user = await requireUser(req);
    const body = parseBody(consentSchema, req.body);
    await prisma.userConsent.createMany({
      data: body.consents.map((consent) => ({
        userId: user.id,
        type: consent.type,
        granted: consent.granted,
        version: CONSENT_VERSION,
      })),
    });
    return loadMe(user.id);
  });

  app.delete('/v1/me', async (req) => {
    const user = await requireUser(req);
    const orders = await prisma.order.findMany({ where: { userId: user.id } });
    await prisma.$transaction([
      ...orders.map((order) =>
        prisma.order.update({
          where: { id: order.id },
          data: {
            addressSnapshot: {
              name: 'Deleted resident',
              buildingName: '',
              flatNumber: '',
              societyName: '',
            },
          },
        }),
      ),
      prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      prisma.user.update({
        where: { id: user.id },
        data: {
          phone: `deleted-${user.id}`,
          name: null,
          photoUrl: null,
          flatNumber: null,
          fcmToken: null,
          deletedAt: new Date(),
        },
      }),
    ]);
    return { ok: true };
  });

  app.post('/v1/me/join-society', async (req) => {
    const user = await requireUser(req);
    const body = parseBody(joinSchema, req.body);
    const terms = body.consents.find((consent) => consent.type === 'TERMS');
    const privacy = body.consents.find((consent) => consent.type === 'PRIVACY');
    if (!terms?.granted || !privacy?.granted) {
      throw new ApiError(400, 'CONSENT_REQUIRED', 'consent_required');
    }

    let societyId = body.societyId;
    if (body.code) {
      const society = await prisma.society.findFirst({
        where: { code: body.code.toUpperCase(), isActive: true },
      });
      if (!society) throw new ApiError(400, 'INVALID_CODE', 'invalid_code');
      societyId = society.id;
    }
    if (!societyId) throw new ApiError(400, 'VALIDATION_ERROR', 'validation_error');
    const building = await prisma.building.findFirst({
      where: { id: body.buildingId, societyId },
    });
    if (!building) throw new ApiError(400, 'VALIDATION_ERROR', 'validation_error');

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          name: body.name,
          societyId,
          buildingId: body.buildingId,
          flatNumber: body.flatNumber,
          membershipStatus: 'APPROVED',
        },
      }),
      prisma.userConsent.createMany({
        data: body.consents.map((consent) => ({
          userId: user.id,
          type: consent.type,
          granted: consent.granted,
          version: CONSENT_VERSION,
        })),
      }),
    ]);
    return loadMe(user.id);
  });

  app.get('/v1/home', async (req) => {
    const user = await requireUser(req);
    await prisma.user.update({ where: { id: user.id }, data: { lastSeenAt: new Date() } });
    const [categories, services, notices, emergency, deals, savings, sponsored] = await Promise.all([
      prisma.category.findMany({
        where: { kind: 'PRODUCT', isActive: true },
        orderBy: { sortOrder: 'asc' },
        take: 8,
      }),
      prisma.category.findMany({
        where: { kind: 'SERVICE', isActive: true },
        orderBy: { sortOrder: 'asc' },
        take: 8,
      }),
      user.societyId
        ? prisma.notice.findMany({
            where: { societyId: user.societyId },
            orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
            take: 2,
          })
        : Promise.resolve([]),
      user.societyId
        ? prisma.notice.findFirst({
            where: { societyId: user.societyId, isEmergency: true },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve(null),
      dealsForSociety(user.societyId),
      savingsSummary(user.id),
      pickSponsored(user.societyId),
    ]);
    const society = user.societyId
      ? await prisma.society.findUnique({ where: { id: user.societyId } })
      : null;
    return {
      society: society ? { id: society.id, name: society.name, area: society.area } : null,
      deals,
      categories: categories.map(presentCategory),
      services: services.map(presentCategory),
      notices: notices.map(presentNotice),
      emergency: emergency ? presentNotice(emergency) : null,
      sponsored,
      savings,
    };
  });

  app.get('/v1/categories', async (req) => {
    await requireUser(req);
    const query = z.object({ kind: z.enum(['PRODUCT', 'SERVICE', 'LISTING']).optional() }).parse(req.query);
    const categories = await prisma.category.findMany({
      where: { isActive: true, ...(query.kind ? { kind: query.kind } : {}) },
      orderBy: { sortOrder: 'asc' },
    });
    return { items: categories.map(presentCategory) };
  });

  app.get('/v1/search', async (req) => {
    const user = await requireUser(req);
    const query = z
      .object({
        q: z.string().min(1).max(80),
        lang: z.string().optional(),
        cursor: z.string().optional(),
      })
      .parse(req.query);
    const q = normalizeQuery(query.q);
    const [productIds, categoryIds] = await Promise.all([searchProductIds(q), searchCategoryIds(q)]);
    const categoryProducts = categoryIds.length
      ? await prisma.product.findMany({
          where: { categoryId: { in: categoryIds }, isActive: true },
          select: { id: true },
          take: 20,
        })
      : [];
    const matchedIds = [...new Set([...productIds, ...categoryProducts.map((product) => product.id)])];
    const [products, categories, listings, providers] = await Promise.all([
      matchedIds.length
        ? prisma.product.findMany({ where: { id: { in: matchedIds } }, include: { category: true } })
        : Promise.resolve([]),
      categoryIds.length
        ? prisma.category.findMany({ where: { id: { in: categoryIds } } })
        : Promise.resolve([]),
      user.societyId
        ? prisma.listing.findMany({
            where: {
              status: 'ACTIVE',
              expiresAt: { gt: new Date() },
              AND: [
                {
                  OR: [{ societyId: user.societyId }, { visibility: 'NEARBY' }],
                },
                { title: { contains: q, mode: 'insensitive' } },
              ],
            },
            include: { seller: { select: { building: { select: { name: true } } } } },
            take: 20,
          })
        : Promise.resolve([]),
      prisma.serviceProvider.findMany({
        where: {
          deletedAt: null,
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { category: { searchKeywords: { has: q } } },
          ],
        },
        include: { category: true },
        take: 20,
      }),
    ]);
    const openDeals = products.length
      ? await prisma.deal.findMany({
          where: {
            productId: { in: products.map((product) => product.id) },
            status: { in: ['OPEN', 'CONFIRMED'] },
            ...(user.societyId ? { societies: { some: { societyId: user.societyId } } } : {}),
          },
          select: { id: true, productId: true },
        })
      : [];
    const dealByProduct = new Map(openDeals.map((deal) => [deal.productId, deal.id]));
    return {
      products: products.map((product) => ({
        id: product.id,
        name: asI18n(product.nameI18n),
        imageUrl: product.imageUrl,
        unit: asI18n(product.unitI18n),
        mrpPaise: product.mrpPaise,
        categoryId: product.categoryId,
        dealId: dealByProduct.get(product.id) ?? null,
      })),
      categories: categories.map(presentCategory),
      listings: listings.map((listing) => ({
        id: listing.id,
        title: listing.title,
        pricePaise: listing.pricePaise,
        photoUrl: listing.photos[0] ?? null,
        buildingName: listing.seller.building?.name ?? '',
        type: listing.type,
        createdAt: listing.createdAt.toISOString(),
      })),
      providers: providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        photoUrl: provider.photoUrl,
        areasServed: provider.areasServed,
        isVerified: provider.isVerified,
        category: asI18n(provider.category.nameI18n),
      })),
      nextCursor: null,
    };
  });

  app.get('/v1/deals', async (req) => {
    const user = await requireUser(req);
    const query = z.object({ cursor: z.string().optional() }).parse(req.query);
    const offset = decodeCursor(query.cursor);
    if (!user.societyId) return { items: [], nextCursor: null };
    const deals = await prisma.deal.findMany({
      where: { societies: { some: { societyId: user.societyId } }, status: { not: 'DRAFT' } },
      include: { tiers: true, product: true, vendor: true },
      orderBy: { cutoffAt: 'asc' },
      skip: offset,
      take: 20,
    });
    const counts = await participantCounts(deals.map((deal) => deal.id));
    return {
      items: deals.map((deal) => presentDeal(deal, counts.get(deal.id) ?? 0)),
      nextCursor: deals.length === 20 ? encodeCursor(offset + 20) : null,
    };
  });

  app.get('/v1/deals/:id', async (req) => {
    const user = await requireUser(req);
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const deal = await prisma.deal.findUnique({
      where: { id: params.id },
      include: { tiers: true, product: true, vendor: true, societies: true },
    });
    if (!deal) throw new ApiError(404, 'NOT_FOUND', 'not_found');
    if (user.role !== 'SUPER_ADMIN') {
      if (!user.societyId || !deal.societies.some((row) => row.societyId === user.societyId)) {
        throw new ApiError(403, 'FORBIDDEN', 'forbidden');
      }
    }
    const counts = await participantCounts([deal.id]);
    return presentDeal(deal, counts.get(deal.id) ?? 0);
  });

  app.get('/v1/notices', async (req) => {
    const user = await requireUser(req);
    if (!user.societyId) return { items: [] };
    assertSameSociety(user, user.societyId);
    const notices = await prisma.notice.findMany({
      where: { societyId: user.societyId },
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
      take: 50,
    });
    return { items: notices.map(presentNotice) };
  });

  app.get('/v1/notices/:id', async (req) => {
    const user = await requireUser(req);
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const notice = await prisma.notice.findUnique({ where: { id: params.id } });
    if (!notice) throw new ApiError(404, 'NOT_FOUND', 'not_found');
    assertSameSociety(user, notice.societyId);
    return presentNotice(notice);
  });

  app.get('/v1/me/notifications', async (req) => {
    const user = await requireUser(req);
    const items = await prisma.appNotification.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    return {
      items: items.map((item) => ({
        id: item.id,
        type: item.type,
        title: asI18n(item.titleI18n),
        body: asI18n(item.bodyI18n),
        readAt: item.readAt?.toISOString() ?? null,
        createdAt: item.createdAt.toISOString(),
      })),
    };
  });

  app.post('/v1/analytics/events', async (req) => {
    const header = req.headers.authorization;
    let userId: string | null = null;
    let societyId: string | null = null;
    if (header?.startsWith('Bearer ')) {
      try {
        const user = await requireUser(req);
        userId = user.id;
        societyId = user.societyId;
      } catch {
        userId = null;
      }
    }
    const body = parseBody(
      z.object({
        name: z.string().min(2).max(64),
        props: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      }),
      req.body,
    );
    await prisma.analyticsEvent.create({
      data: {
        userId,
        societyId,
        name: body.name,
        props: { language: req.headers['x-language'] ?? null, ...(body.props ?? {}) },
      },
    });
    return { ok: true };
  });

  app.get('/v1/ads/slot', async (req) => {
    const user = await requireUser(req);
    const query = z
      .object({ placement: z.enum(['home', 'deals', 'service', 'order']) })
      .parse(req.query);
    const kind =
      query.placement === 'service'
        ? 'PROVIDER_FEATURE'
        : query.placement === 'order'
          ? 'ORDER_BANNER'
          : query.placement === 'deals'
            ? 'DEAL_CARD'
            : 'VENDOR_STRIP';
    const ad = await pickSponsored(user.societyId, kind);
    return { ad };
  });

  app.post('/v1/ads/:id/impression', async (req) => recordAd(req, 'impressions'));
  app.post('/v1/ads/:id/tap', async (req) => recordAd(req, 'taps'));
}

function presentCategory(category: {
  id: string;
  kind: string;
  nameI18n: unknown;
  imageUrl: string;
  sortOrder: number;
}) {
  return {
    id: category.id,
    kind: category.kind,
    name: asI18n(category.nameI18n),
    imageUrl: category.imageUrl,
    sortOrder: category.sortOrder,
  };
}

function presentNotice(notice: {
  id: string;
  title: string;
  body: string;
  imageUrl: string | null;
  category: string;
  isPinned: boolean;
  isEmergency: boolean;
  createdAt: Date;
}) {
  return {
    id: notice.id,
    title: notice.title,
    body: notice.body,
    imageUrl: notice.imageUrl,
    category: notice.category,
    isPinned: notice.isPinned,
    isEmergency: notice.isEmergency,
    createdAt: notice.createdAt.toISOString(),
  };
}

async function pickSponsored(societyId: string | null, kind?: 'VENDOR_STRIP' | 'DEAL_CARD' | 'PROVIDER_FEATURE' | 'ORDER_BANNER') {
  const now = new Date();
  const ads = await prisma.ad.findMany({
    where: {
      status: 'ACTIVE',
      startAt: { lte: now },
      endAt: { gte: now },
      ...(kind ? { kind } : { kind: { in: ['VENDOR_STRIP', 'DEAL_CARD'] } }),
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  const match = ads.find(
    (ad) => ad.targetSocietyIds.length === 0 || (societyId != null && ad.targetSocietyIds.includes(societyId)),
  );
  if (!match) return null;
  const stat = await prisma.adStatDaily.findUnique({
    where: { adId_date: { adId: match.id, date: todayUtc() } },
  });
  if (stat && stat.impressions >= match.dailyImpressionCap) return null;
  return {
    id: match.id,
    kind: match.kind,
    title: asI18n(match.titleI18n),
    imageUrl: match.imageUrl,
    actionType: match.actionType,
    actionValue: match.actionValue,
    label: 'sponsored',
  };
}

async function recordAd(req: Parameters<typeof requireUser>[0], field: 'impressions' | 'taps') {
  await requireUser(req);
  const params = z.object({ id: z.string().uuid() }).parse(req.params);
  const ad = await prisma.ad.findUnique({ where: { id: params.id } });
  if (!ad) throw new ApiError(404, 'NOT_FOUND', 'not_found');
  const date = todayUtc();
  if (field === 'impressions') {
    const stat = await prisma.adStatDaily.findUnique({
      where: { adId_date: { adId: ad.id, date } },
    });
    if (stat && stat.impressions >= ad.dailyImpressionCap) return { ok: true, counted: false };
  }
  await prisma.adStatDaily.upsert({
    where: { adId_date: { adId: ad.id, date } },
    create: { adId: ad.id, date, impressions: field === 'impressions' ? 1 : 0, taps: field === 'taps' ? 1 : 0 },
    update: { [field]: { increment: 1 } },
  });
  return { ok: true, counted: true };
}
