import { JobModel } from '../models/Job.js';
import { JobMatchModel } from '../models/JobMatch.js';
import { PhdPositionModel } from '../models/PhdPosition.js';
import { CoverLetterModel } from '../models/CoverLetter.js';
import { CandidateProfileModel } from '../models/CandidateProfile.js';
import { SearchRunModel } from '../models/SearchRun.js';
import { getSettings, resolveModel } from './settingsService.js';
import { effectiveMaxAgeMonths, jobAgeCutoff, startOfUtcDay } from './jobs/age.js';
import { env } from '../config/env.js';

const DAY_MS = 86_400_000;

/**
 * Read-only aggregate for the overview page. Everything here is derived from stored records;
 * missing deadlines and unverified posting dates are counted separately instead of being
 * treated as eligible.
 */
export async function dashboardSummary() {
  const settings = await getSettings();
  const now = new Date();
  const cutoff = jobAgeCutoff(effectiveMaxAgeMonths(settings.search.maxAgeMonths));
  const since24h = new Date(now.getTime() - DAY_MS);
  const todayStart = startOfUtcDay(now);
  const soon = new Date(now.getTime() + 14 * DAY_MS);
  const highMatchThreshold = settings.search.minRelevanceScore;

  // Same eligibility as the normal job list: inside the calendar-month window, and not a
  // vacancy whose posting mandates German.
  const inWindow = {
    status: 'active',
    postedAt: { $gt: cutoff },
    languageDecision: { $ne: 'Excluded' },
    languageRequirement: { $ne: 'german_required' },
  };
  const openDeadline = {
    status: 'active',
    $or: [
      { deadlineHasTime: true, applicationDeadline: { $gte: now } },
      { deadlineHasTime: { $ne: true }, applicationDeadline: { $gte: todayStart } },
      { rollingAdmissions: true, applicationDeadline: null },
    ],
  };

  const [
    totalJobs,
    eligibleByDate,
    newJobs,
    unknownPostingDate,
    savedJobs,
    highMatchJobIds,
    openPhd,
    phdDeadlineSoon,
    phdUnknownDeadline,
    savedPhd,
    savedLetters,
    approvedProfiles,
    recentRuns,
    topMatches,
  ] = await Promise.all([
    JobModel.countDocuments({ status: 'active' }),
    JobModel.countDocuments(inWindow),
    JobModel.countDocuments({ ...inWindow, discoveredAt: { $gte: since24h } }),
    JobModel.countDocuments({
      status: 'active',
      $or: [{ postedAt: null }, { postedAt: { $exists: false } }],
    }),
    JobModel.countDocuments({ status: 'active', saved: true }),
    JobMatchModel.distinct('job', { score: { $gte: highMatchThreshold } }),
    PhdPositionModel.countDocuments(openDeadline),
    PhdPositionModel.countDocuments({
      ...openDeadline,
      applicationDeadline: { $gte: now, $lte: soon },
    }),
    PhdPositionModel.countDocuments({
      status: 'active',
      applicationDeadline: null,
      rollingAdmissions: { $ne: true },
    }),
    PhdPositionModel.countDocuments({ status: 'active', saved: true }),
    CoverLetterModel.countDocuments(),
    CandidateProfileModel.countDocuments({ status: 'approved' }),
    SearchRunModel.find().sort({ startedAt: -1 }).limit(8),
    JobMatchModel.find({ score: { $gt: 0 } })
      .sort({ score: -1 })
      .limit(6)
      .populate('job', 'title employer location'),
  ]);

  const highMatchJobs =
    highMatchJobIds.length > 0
      ? await JobModel.countDocuments({ ...inWindow, _id: { $in: highMatchJobIds } })
      : 0;

  const lastSuccessfulJobRun =
    recentRuns.find((run) => run.kind === 'jobs' && run.status === 'completed') ?? null;
  const lastSuccessfulPhdRun =
    recentRuns.find((run) => run.kind === 'phd' && run.status === 'completed') ?? null;

  const sourceFailures: Array<{ kind: 'jobs' | 'phd'; source: string; error: string; runId: string }> = [];
  for (const kind of ['jobs', 'phd'] as const) {
    const latest = recentRuns.find((run) => run.kind === kind);
    if (!latest) continue;
    for (const source of latest.sources) {
      if (source.status === 'failed') {
        sourceFailures.push({
          kind,
          source: source.source,
          error: source.error || 'Source failed without an error message.',
          runId: String(latest._id),
        });
      }
    }
  }

  return {
    highMatchThreshold,
    totals: {
      totalJobs,
      eligibleByDate,
      newJobs,
      highMatchJobs,
      unknownPostingDate,
      savedJobs,
      openPhd,
      phdDeadlineSoon,
      phdUnknownDeadline,
      savedPhd,
      savedLetters,
      approvedProfiles,
    },
    lastSuccessful: {
      jobs: lastSuccessfulJobRun ? lastSuccessfulJobRun.startedAt : null,
      phd: lastSuccessfulPhdRun ? lastSuccessfulPhdRun.startedAt : null,
    },
    sourceFailures,
    topMatches: topMatches
      .filter((match) => match.job)
      .map((match) => {
        const job = match.job as unknown as {
          _id: unknown;
          title?: string;
          employer?: string;
          location?: string;
        };
        return {
          id: String(match._id),
          jobId: String(job._id),
          jobTitle: job.title ?? match.jobTitle,
          employer: job.employer ?? match.employer,
          location: job.location ?? '',
          score: match.score,
          profileKind: match.profileKind,
          reviewRequired: match.reviewRequired,
        };
      }),
    recentRuns,
    ai: {
      configured: env.aiConfigured,
      model: resolveModel(settings),
    },
  };
}
