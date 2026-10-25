import { JobModel } from '../../models/Job.js';
import { logger } from '../../utils/logger.js';
import { getAdapter } from './adapters/index.js';
import { assessJobAge } from './age.js';
import { getSettings } from '../settingsService.js';
import { isSafeRemoteUrl } from '../../utils/urlSafety.js';

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

  if (!isSafeRemoteUrl(job.url)) {
    // Listing URLs are untrusted feed data; never let them make the backend fetch local or
    // private-network targets.
    result = {
      status: 'unknown',
      evidence: 'The listing URL is not a public http(s) URL; availability was not checked.',
    };
  } else if (adapter?.verifyJob) {
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

  const now = new Date();
  const update: Record<string, unknown> = { lastVerifiedAt: now, lastSeenAt: now };
  let status = job.status;
  if (result.status === 'unavailable') {
    update.status = 'unavailable';
    update.statusNote = result.evidence.slice(0, 300);
    status = 'unavailable';
  } else if (result.status === 'available' && job.status === 'unavailable') {
    update.status = 'active';
    update.statusNote = '';
    status = 'active';
  }
  const settings = await getSettings();
  const age = assessJobAge({
    postedAt: job.postedAt,
    expiresAt: job.expiresAt,
    status,
    months: settings.search.minAgeMonths,
    now,
  });
  update.ageEligibility = age.ageEligibility;
  update.eligibleAfter = age.eligibleAfter;
  update.ageCheckAt = age.ageCheckAt;
  update.ageReason = age.ageReason;
  await JobModel.updateOne({ _id: job._id }, { $set: update });

  logger.info({ jobId, status: result.status, source: job.source }, 'Job availability verified');
  return result;
}
