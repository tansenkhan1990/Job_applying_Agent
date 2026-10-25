import { JobModel } from '../../models/Job.js';
import { logger } from '../../utils/logger.js';
import { getAdapter } from './adapters/index.js';

export interface AvailabilityResult {
  status: 'available' | 'unavailable' | 'unknown';
  evidence: string;
}

/**
 * Best-effort availability check. It never claims success when the source cannot
 * confirm it: blocked or ambiguous responses are reported as "unknown".
 */
export async function verifyJobAvailability(jobId: string): Promise<AvailabilityResult> {
  const job = await JobModel.findById(jobId);
  if (!job) return { status: 'unknown', evidence: 'Job not found in the local database' };

  const adapter = getAdapter(job.source);
  let result: AvailabilityResult;

  if (adapter?.verifyJob) {
    try {
      result = await adapter.verifyJob({
        url: job.url,
        sourceJobId: job.sourceJobId,
        source: job.source,
      });
    } catch (error) {
      result = {
        status: 'unknown',
        evidence: `Verification error: ${error instanceof Error ? error.message : 'unknown'}`,
      };
    }
  } else {
    result = {
      status: 'unknown',
      evidence: `No availability verifier for source "${job.source}"`,
    };
  }

  const update: Record<string, unknown> = { lastVerifiedAt: new Date() };
  if (result.status === 'unavailable') {
    update.status = 'unavailable';
    update.statusNote = result.evidence.slice(0, 300);
  } else if (result.status === 'available' && job.status === 'unavailable') {
    update.status = 'active';
    update.statusNote = '';
  }
  await JobModel.updateOne({ _id: job._id }, { $set: update });

  logger.info({ jobId, status: result.status, source: job.source }, 'Job availability verified');
  return result;
}
