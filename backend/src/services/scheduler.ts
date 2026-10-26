import { SearchRunModel } from '../models/SearchRun.js';
import { JobModel } from '../models/Job.js';
import { JobMatchModel } from '../models/JobMatch.js';
import { getSettings, acquireSchedulerLock, releaseSchedulerLock } from './settingsService.js';
import { runDiscovery } from './jobs/discovery.js';
import { runPhdDiscovery } from './phd/discovery.js';
import { matchJobsBatch } from './matching/index.js';
import { logger } from '../utils/logger.js';

const OWNER = `worker-${process.pid}`;
const CHECK_INTERVAL_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let ticking = false;
let schedulerStartedAt = Date.now();

async function lastScheduledRun(): Promise<Date | null> {
  const run = await SearchRunModel.findOne({ trigger: 'scheduled', kind: 'jobs' }).sort({
    startedAt: -1,
  });
  return run?.startedAt ?? null;
}

async function scoreRecentJobs(limit = 5): Promise<void> {
  const jobs = await JobModel.find({ status: 'active' }).sort({ discoveredAt: -1 }).limit(limit);
  const unscored = [];
  for (const job of jobs) {
    const hasMatch = await JobMatchModel.exists({ job: job._id });
    if (!hasMatch) unscored.push(String(job._id));
  }
  if (unscored.length === 0) return;
  const results = await matchJobsBatch(unscored);
  logger.info({ scored: results.filter((result) => !result.error).length }, 'Scheduled matching finished');
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const settings = await getSettings();
    if (!settings.schedule.enabled) return;

    const previous = await lastScheduledRun();
    const intervalMs = settings.schedule.intervalMinutes * 60_000;
    if (previous && Date.now() - previous.getTime() < intervalMs) return;
    if (!previous && !settings.schedule.runOnStartup && Date.now() - schedulerStartedAt < intervalMs) {
      return;
    }

    const acquired = await acquireSchedulerLock(OWNER);
    if (!acquired) {
      logger.debug('Scheduler lock is held by another process; skipping tick');
      return;
    }

    try {
      const result = await runDiscovery({ trigger: 'scheduled' });
      logger.info({ runId: result.runId, created: result.created }, 'Scheduled discovery completed');
      await scoreRecentJobs(settings.ai.model ? 5 : 10);

      // PhD discovery is independent: a failure or a disabled PhD source must not undo the
      // job run.
      try {
        const phd = await runPhdDiscovery({ trigger: 'scheduled' });
        logger.info({ runId: phd.runId, created: phd.created }, 'Scheduled PhD discovery completed');
      } catch (error) {
        logger.debug(
          { error: error instanceof Error ? error.message : 'unknown' },
          'Scheduled PhD discovery skipped',
        );
      }
    } finally {
      await releaseSchedulerLock(OWNER);
    }
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : 'unknown' },
      'Scheduled job run failed',
    );
  } finally {
    ticking = false;
  }
}

export function startScheduler(): () => void {
  if (timer) return () => undefined;
  schedulerStartedAt = Date.now();
  const initial = setTimeout(() => {
    void tick();
  }, 10_000);
  initial.unref?.();

  timer = setInterval(() => {
    void tick();
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
  logger.info({ owner: OWNER }, 'Scheduler started (runs only when enabled in settings)');

  return () => {
    if (timer) clearInterval(timer);
    clearTimeout(initial);
    timer = null;
  };
}
