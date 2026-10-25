import { connectDb, disconnectDb } from './db/mongoose.js';
import { ensureDefaultProfiles } from './services/profilesService.js';
import { getSettings } from './services/settingsService.js';
import { startScheduler } from './services/scheduler.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  await connectDb();
  await ensureDefaultProfiles();
  const settings = await getSettings();

  const stop = startScheduler();
  logger.info(
    { scheduleEnabled: settings.schedule.enabled, intervalMinutes: settings.schedule.intervalMinutes },
    'Background worker ready',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Worker shutting down');
    stop();
    await disconnectDb().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.fatal({ error: error instanceof Error ? error.message : 'unknown' }, 'Worker failed to start');
  process.exit(1);
});
