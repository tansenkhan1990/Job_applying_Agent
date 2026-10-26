import { SearchRunModel } from '../models/SearchRun.js';
import { conflict } from '../utils/errors.js';

/** A run that is still marked running after this long was left behind by a stopped process. */
const STALE_RUN_MS = 15 * 60_000;

/**
 * Refuses a second search of the same kind while one is still running, after retiring runs that
 * a stopped process left behind. A jobs search and a PhD search are independent, so neither
 * blocks the other; without the kind scoping a PhD run would reject a job search with the
 * message "A job search is already running".
 */
export async function assertNoRunningRun(kind: 'jobs' | 'phd'): Promise<void> {
  const staleBefore = new Date(Date.now() - STALE_RUN_MS);
  await SearchRunModel.updateMany(
    { status: 'running', startedAt: { $lt: staleBefore } },
    {
      $set: {
        status: 'failed',
        finishedAt: new Date(),
        errorMessages: ['Run timed out or the process stopped'],
      },
    },
  );

  const running = await SearchRunModel.findOne({ kind, status: 'running' });
  if (running) {
    throw conflict(
      kind === 'jobs'
        ? 'A job search is already running. Wait for it to finish.'
        : 'A PhD search is already running. Wait for it to finish.',
      { runId: String(running._id) },
    );
  }
}
