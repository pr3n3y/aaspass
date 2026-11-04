import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.js';
import { isApiError } from './lib/errors.js';
import { captureError } from './lib/observe.js';
import { prisma } from './lib/prisma.js';
import { createPushProvider, type PushProvider } from './lib/push.js';
import { createSmsProvider } from './lib/sms.js';
import { registerAdminOpsRoutes } from './routes/admin_ops.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCommerceRoutes } from './routes/commerce.js';
import { registerCommunityRoutes } from './routes/community.js';
import { registerListingRoutes } from './routes/listings.js';
import { registerResidentRoutes } from './routes/resident.js';
import { registerServiceRoutes } from './routes/services.js';

export async function buildApp(): Promise<{ app: ReturnType<typeof Fastify>; push: PushProvider }> {
  const app = Fastify({
    logger: {
      level: 'info',
      redact: ['req.headers.authorization', 'req.body.phone', 'req.body.code', 'req.body.refreshToken'],
    },
    trustProxy: true,
  });

  const origin =
    config.nodeEnv === 'development' ? true : config.corsOrigin.split(',').map((item) => item.trim());
  await app.register(cors, { origin });
  await app.register(jwt, { secret: config.jwtAccessSecret });

  const sms = createSmsProvider(config.smsProvider, config.msg91AuthKey, config.msg91TemplateId);
  const push = createPushProvider(config.pushProvider, config.googleApplicationCredentials);

  app.setErrorHandler((error, request, reply) => {
    if (isApiError(error)) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'validation_error' } });
    }
    captureError(error, { path: request.url });
    request.log.error({ msg: error instanceof Error ? error.message : 'error' });
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal_error' } });
  });

  app.get('/health', async () => ({ ok: true }));
  app.get('/v1/health', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  });

  registerAuthRoutes(app, sms);
  registerResidentRoutes(app);
  registerCommerceRoutes(app);
  registerServiceRoutes(app, push);
  registerListingRoutes(app);
  registerCommunityRoutes(app, push);
  registerAdminRoutes(app, push);
  registerAdminOpsRoutes(app);

  return { app, push };
}
