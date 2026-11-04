import type { Prisma, User } from '@prisma/client';
import { prisma } from './prisma.js';
import { asI18n, type I18nText } from './i18n.js';
import type { PushProvider } from './push.js';

const NON_URGENT = new Set([
  'deal_closing',
  'notice',
  'help_reply',
  'listing_reply',
  'need_one_too',
  'listing_expired',
]);
const DAILY_CAP = 3;

export async function notifyUser(
  db: Prisma.TransactionClient | typeof prisma,
  push: PushProvider,
  user: Pick<User, 'id' | 'fcmToken' | 'language'>,
  input: { type: string; title: I18nText; body: I18nText; data?: Record<string, string> },
) {
  if (NON_URGENT.has(input.type)) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const sentToday = await db.appNotification.count({
      where: { userId: user.id, type: { in: [...NON_URGENT] }, createdAt: { gte: start } },
    });
    if (sentToday >= DAILY_CAP) return;
  }

  const dedupe = input.data?.dedupe ?? input.data?.dealId;
  const existing = dedupe
    ? await db.appNotification.findFirst({
        where: {
          userId: user.id,
          type: input.type,
          OR: [
            { data: { path: ['dedupe'], equals: dedupe } },
            { data: { path: ['dealId'], equals: dedupe } },
          ],
        },
      })
    : null;
  if (existing) return;

  await db.appNotification.create({
    data: {
      userId: user.id,
      type: input.type,
      titleI18n: input.title,
      bodyI18n: input.body,
      data: input.data ?? {},
    },
  });

  if (user.fcmToken) {
    const text = asI18n(input.title);
    const body = asI18n(input.body);
    const lang = user.language.toLowerCase();
    const title = lang === 'hi' ? text.hi : lang === 'mr' ? text.mr : text.en;
    const message = lang === 'hi' ? body.hi : lang === 'mr' ? body.mr : body.en;
    try {
      await push.send({
        token: user.fcmToken,
        title,
        body: message,
        data: { type: input.type, ...(input.data ?? {}) },
      });
    } catch (error) {
      console.error('[push] failed', error instanceof Error ? error.message : 'error');
    }
  }
}
