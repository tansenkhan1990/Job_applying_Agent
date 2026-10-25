import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDb, disconnectDb } from './db/mongoose.js';
import { logger } from './utils/logger.js';
import { ensureDefaultProfiles } from './services/profilesService.js';
import { getSettings } from './services/settingsService.js';
import { rescanDocuments } from './services/documents/ingestion.js';
import { startScheduler } from './services/scheduler.js';

async function main(): Promise<void> {
  if (!env.APPROVAL_REQUIRED) {
    logger.warn(
      'APPROVAL_REQUIRED=false is ignored: this build always requires an explicit approval record before submission.',
    );
  }
  await connectDb();
  await ensureDefaultProfiles();
  await getSettings();

  const app = createApp();
  const server = app.listen(env.PORT, '0.0.0.0', () => {
    logger.info({ port: env.PORT, docs: env.documentsPath }, 'Job Agent API listening');
  });

  // Initial read-only scan; failures are reported in the dashboard, never fatal.
  rescanDocuments()
    .then((summary) => {
      logger.info(
        { scanned: summary.scanned, processed: summary.added + summary.updated, warnings: summary.warnings.length },
        'Initial document scan complete',
      );
    })
    .catch((error) => {
      logger.warn(
        { error: error instanceof Error ? error.message : 'unknown' },
        'Initial document scan failed',
      );
    });

  const stopScheduler = env.SCHEDULER_ENABLED ? startScheduler() : () => undefined;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    stopScheduler();
    server.close(async () => {
      await disconnectDb().catch(() => undefined);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: reason instanceof Error ? reason.message : String(reason) }, 'Unhandled rejection');
  });
}

main().catch((error) => {
  logger.fatal({ error: error instanceof Error ? error.message : 'unknown' }, 'Failed to start backend');
  process.exit(1);
});
