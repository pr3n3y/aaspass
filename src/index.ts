import cron from 'node-cron';
import { buildApp } from './app.js';
import { config } from './config.js';
import { runCutoff } from './jobs/cutoff.js';
import { runExpiry } from './jobs/expiry.js';

const { app, push } = await buildApp();

cron.schedule('* * * * *', () => {
  runCutoff(push).catch((error: unknown) => {
    app.log.error({ msg: error instanceof Error ? error.message : 'cutoff failed' });
  });
  runExpiry(push).catch((error: unknown) => {
    app.log.error({ msg: error instanceof Error ? error.message : 'expiry failed' });
  });
});

await app.listen({ port: config.port, host: '0.0.0.0' });
