import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../lib/errors.js';
import { assertApproved } from '../lib/guards.js';
import { containsProhibited } from '../lib/moderation.js';
import { prisma } from '../lib/prisma.js';
import { getObject, presignPut, putObject } from '../lib/s3.js';
import { parseBody, requireUser } from './auth.js';

const MAX_BYTES = 2_000_000;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

function extension(contentType: (typeof TYPES)[number]) {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  return 'jpg';
}

function mediaUrl(req: FastifyRequest, key: string) {
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost:3000';
  const proto = req.headers['x-forwarded-proto'] ?? 'http';
  return `${proto}://${host}/v1/media/${key}`;
}

function visibleTo(societyId: string) {
  return {
    status: 'ACTIVE' as const,
    expiresAt: { gt: new Date() },
    OR: [{ societyId }, { visibility: 'NEARBY' as const }],
  };
}

export function presentListing(listing: {
  id: string;
  title: string;
  description: string | null;
  pricePaise: number;
  type: string;
  photos: string[];
  visibility: string;
  status: string;
  contactWhatsappAllowed: boolean;
  contactCallAllowed: boolean;
  createdAt: Date;
  expiresAt: Date;
  categoryId: string;
  sellerId: string;
  seller?: { name: string | null; building: { name: string } | null } | null;
}) {
  return {
    id: listing.id,
    title: listing.title,
    description: listing.description,
    pricePaise: listing.pricePaise,
    type: listing.type,
    photos: listing.photos,
    photoUrl: listing.photos[0] ?? null,
    visibility: listing.visibility,
    status: listing.status,
    contactWhatsappAllowed: listing.contactWhatsappAllowed,
    contactCallAllowed: listing.contactCallAllowed,
    buildingName: listing.seller?.building?.name ?? '',
    sellerName: listing.seller?.name ?? '',
    sellerId: listing.sellerId,
    categoryId: listing.categoryId,
    createdAt: listing.createdAt.toISOString(),
    expiresAt: listing.expiresAt.toISOString(),
  };
}

const listingInclude = { seller: { select: { name: true, building: { select: { name: true } } } } } as const;

export function registerListingRoutes(app: FastifyInstance) {
  app.post('/v1/uploads/presign', async (req) => {
    await requireUser(req);
    const body = parseBody(
      z.object({
        contentType: z.enum(TYPES),
        bytes: z.number().int().positive().max(MAX_BYTES),
      }),
      req.body,
    );
    const key = `uploads/${randomUUID()}.${extension(body.contentType)}`;
    return {
      key,
      uploadUrl: presignPut(key),
      publicUrl: mediaUrl(req, key),
      contentType: body.contentType,
    };
  });

  app.post('/v1/uploads', { bodyLimit: 3_000_000 }, async (req) => {
    await requireUser(req);
    const body = parseBody(
      z.object({
        contentType: z.enum(TYPES),
        dataBase64: z.string().min(8).max(2_800_000),
      }),
      req.body,
    );
    const bytes = Buffer.from(body.dataBase64, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new ApiError(400, 'VALIDATION_ERROR', 'validation_error');
    const key = `uploads/${randomUUID()}.${extension(body.contentType)}`;
    try {
      await putObject(key, bytes, body.contentType);
    } catch {
      throw new ApiError(502, 'UPLOAD_FAILED', 'upload_failed');
    }
    return { key, publicUrl: mediaUrl(req, key) };
  });

  app.get('/v1/media/*', async (req, reply) => {
    const key = (req.params as { '*': string })['*'];
    if (!key.startsWith('uploads/') || key.includes('..')) throw new ApiError(400, 'VALIDATION_ERROR', 'validation_error');
    try {
      const file = await getObject(key);
      reply.header('content-type', file.contentType);
      reply.header('cache-control', 'public, max-age=86400');
      return reply.send(file.body);
    } catch {
      throw new ApiError(404, 'NOT_FOUND', 'not_found');
    }
  });

  app.get('/v1/listings', async (req) => {
    const user = await requireUser(req);
    if (!user.societyId) return { items: [] };
    const query = z.object({ mine: z.enum(['1']).optional() }).parse(req.query);
    const listings = await prisma.listing.findMany({
      where: query.mine ? { sellerId: user.id } : visibleTo(user.societyId),
      include: listingInclude,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { items: listings.map((listing) => ({ ...presentListing(listing), mine: listing.sellerId === user.id })) };
  });

  app.get('/v1/listings/:id', async (req) => {
    const user = await requireUser(req);
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const listing = await prisma.listing.findUnique({ where: { id: params.id }, include: listingInclude });
    if (!listing || !user.societyId) throw new ApiError(404, 'NOT_FOUND', 'not_found');
    const owner = listing.sellerId === user.id;
    const visible =
      owner ||
      (listing.status === 'ACTIVE' &&
        listing.expiresAt > new Date() &&
        (listing.societyId === user.societyId || listing.visibility === 'NEARBY'));
    if (!visible && user.role !== 'SUPER_ADMIN') throw new ApiError(404, 'NOT_FOUND', 'not_found');
    return { ...presentListing(listing), mine: owner };
  });

  app.post('/v1/listings', async (req) => {
    const user = await requireUser(req);
    assertApproved(user);
    if (!user.societyId) throw new ApiError(400, 'VALIDATION_ERROR', 'validation_error');
    const body = parseBody(
      z.object({
        categoryId: z.string().uuid(),
        type: z.enum(['SELL', 'FREE', 'RENT']),
        title: z.string().trim().min(2).max(80),
        description: z.string().trim().max(280).optional(),
        pricePaise: z.number().int().min(0).max(100_000_000),
        photos: z.array(z.string().url()).max(4).default([]),
        contactWhatsappAllowed: z.boolean().default(true),
        contactCallAllowed: z.boolean().default(false),
        visibility: z.enum(['SOCIETY', 'NEARBY']).default('SOCIETY'),
      }),
      req.body,
    );
    if (containsProhibited(`${body.title} ${body.description ?? ''}`)) {
      throw new ApiError(400, 'PROHIBITED', 'prohibited_item');
    }
    const category = await prisma.category.findFirst({ where: { id: body.categoryId, kind: 'LISTING', isActive: true } });
    if (!category) throw new ApiError(400, 'VALIDATION_ERROR', 'validation_error');
    const pricePaise = body.type === 'FREE' ? 0 : body.pricePaise;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const listing = await prisma.listing.create({
      data: {
        societyId: user.societyId,
        sellerId: user.id,
        categoryId: body.categoryId,
        type: body.type,
        title: body.title,
        description: body.description,
        pricePaise,
        photos: body.photos,
        contactWhatsappAllowed: body.contactWhatsappAllowed,
        contactCallAllowed: body.contactCallAllowed,
        visibility: body.visibility,
        expiresAt,
      },
      include: listingInclude,
    });
    return { ...presentListing(listing), mine: true };
  });

  app.patch('/v1/listings/:id', async (req) => {
    const user = await requireUser(req);
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = parseBody(
      z.object({
        title: z.string().trim().min(2).max(80).optional(),
        description: z.string().trim().max(280).optional(),
        pricePaise: z.number().int().min(0).optional(),
        visibility: z.enum(['SOCIETY', 'NEARBY']).optional(),
        contactWhatsappAllowed: z.boolean().optional(),
        contactCallAllowed: z.boolean().optional(),
      }),
      req.body,
    );
    const listing = await prisma.listing.findUnique({ where: { id: params.id } });
    if (!listing || listing.sellerId !== user.id) throw new ApiError(404, 'NOT_FOUND', 'not_found');
    if (containsProhibited(`${body.title ?? listing.title} ${body.description ?? listing.description ?? ''}`)) {
      throw new ApiError(400, 'PROHIBITED', 'prohibited_item');
    }
    const updated = await prisma.listing.update({
      where: { id: listing.id },
      data: body,
      include: listingInclude,
    });
    return { ...presentListing(updated), mine: true };
  });

  app.post('/v1/listings/:id/sold', async (req) => {
    const user = await requireUser(req);
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const listing = await prisma.listing.findUnique({ where: { id: params.id } });
    if (!listing || listing.sellerId !== user.id) throw new ApiError(404, 'NOT_FOUND', 'not_found');
    await prisma.listing.update({ where: { id: listing.id }, data: { status: 'SOLD' } });
    return { ok: true, status: 'SOLD' };
  });

  app.post('/v1/listings/:id/contact', async (req) => {
    const user = await requireUser(req);
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = parseBody(z.object({ channel: z.enum(['WHATSAPP', 'CALL']) }), req.body);
    const listing = await prisma.listing.findUnique({
      where: { id: params.id },
      include: { seller: true },
    });
    if (!listing || !user.societyId) throw new ApiError(404, 'NOT_FOUND', 'not_found');
    const visible = listing.societyId === user.societyId || listing.visibility === 'NEARBY';
    if (!visible || listing.status !== 'ACTIVE') throw new ApiError(404, 'NOT_FOUND', 'not_found');
    if (listing.sellerId === user.id) throw new ApiError(400, 'VALIDATION_ERROR', 'validation_error');
    if (body.channel === 'WHATSAPP' && !listing.contactWhatsappAllowed) {
      throw new ApiError(403, 'FORBIDDEN', 'forbidden');
    }
    if (body.channel === 'CALL' && !listing.contactCallAllowed) throw new ApiError(403, 'FORBIDDEN', 'forbidden');
    const digits = listing.seller.phone.replace(/\D/g, '');
    const text = `Hello, I saw "${listing.title}" on Hamari Society.`;
    const url = body.channel === 'CALL' ? `tel:${listing.seller.phone}` : `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
    return { url };
  });
}
