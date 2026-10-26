import { SearchRunModel } from '../../models/SearchRun.js';
import { JobModel } from '../../models/Job.js';
import { CandidateProfileModel } from '../../models/CandidateProfile.js';
import { getSettings } from '../settingsService.js';
import { logger } from '../../utils/logger.js';
import { conflict, AppError } from '../../utils/errors.js';
import { withTimeout } from '../../utils/async.js';
import { adapters, getAdapter } from './adapters/index.js';
import { applyDeterministicFilters } from './filters.js';
import { upsertJobListings } from './dedupe.js';
import { criteriaFromSettings, type JobListing, type JobSearchCriteria } from './types.js';

type StoredJob = InstanceType<typeof JobModel>;

function storedJobToListing(job: StoredJob): JobListing {
  return {
    source: job.source,
    sourceJobId: job.sourceJobId,
    sourceLabel: job.sourceLabel ?? '',
    url: job.url,
    canonicalUrl: job.canonicalUrl,
    applicationUrl: job.applicationUrl ?? '',
    employer: job.employer,
    title: job.title,
    location: job.location ?? '',
    country: job.country ?? '',
    remote: job.remote ?? false,
    workArrangement: job.workArrangement ?? 'unknown',
    employmentType: job.employmentType ?? '',
    salary: job.salary ?? '',
    tags: job.tags ?? [],
    description: job.description ?? '',
    postedAt: job.postedAt ?? null,
    postedLocalDate: job.postedLocalDate ?? '',
    expiresAt: job.expiresAt ?? null,
    ageEligibility: job.ageEligibility ?? 'Unknown',
    eligibleAfter: job.eligibleAfter ?? null,
    ageCheckAt: job.ageCheckAt ?? new Date(),
    ageReason: job.ageReason ?? '',
    languageRequirement: job.languageRequirement ?? 'unknown',
    jobLanguage: job.jobLanguage ?? 'Unknown',
    englishRequired: job.englishRequired ?? null,
    germanRequired: job.germanRequired ?? null,
    germanOptional: job.germanOptional ?? null,
    languageEvidence: job.languageEvidence ?? '',
    languageConfidence: job.languageConfidence ?? 0,
    languageDecision: job.languageDecision ?? 'Needs Review',
    languageReason: job.languageReason ?? '',
    seniority: job.seniority ?? 'unknown',
    remoteEligibleFromGermany: job.remoteEligibleFromGermany ?? null,
  };
}

/**
 * Stored vacancies can outlive the rule that admitted them, for example when geography or
 * availability rules are tightened. Re-check the active rows against the current criteria and
 * mark the ones that no longer qualify, so the normal list cannot keep showing an ineligible
 * vacancy. Preference-based reasons (title, keywords, internships) are ignored here: they are
 * applied at read time, while this sweep only enforces listing facts.
 */
export async function deactivateIneligibleStoredJobs(
  criteria: JobSearchCriteria,
): Promise<number> {
  const jobs = await JobModel.find({ status: 'active' });
  let deactivated = 0;
  for (const job of jobs) {
    const outcome = applyDeterministicFilters(storedJobToListing(job), criteria);
    const fatal = outcome.reasons.filter(
      (reason) => reason === 'location_mismatch' || reason === 'expired',
    );
    if (fatal.length === 0) continue;
    job.status = 'unavailable';
    job.statusNote = `No longer eligible under the current rules (${fatal.join(', ')}).`;
    await job.save();
    deactivated += 1;
  }
  return deactivated;
}

export interface DiscoveryOverrides {
  sources?: string[];
  keywords?: string[];
  maxJobs?: number;
}

export interface DiscoveryResult {
  runId: string;
  status: 'completed' | 'failed';
  discovered: number;
  created: number;
  updated: number;
  duplicates: number;
  filteredOut: number;
  sources: Array<{
    source: string;
    status: 'ok' | 'failed' | 'skipped';
    found: number;
    created: number;
    updated: number;
    duplicates: number;
    filtered: number;
    durationMs: number;
    error: string;
  }>;
}

const STALE_RUN_MS = 15 * 60_000;

async function assertNoRunningRun(): Promise<void> {
  const staleBefore = new Date(Date.now() - STALE_RUN_MS);
  await SearchRunModel.updateMany(
    { status: 'running', startedAt: { $lt: staleBefore } },
    { $set: { status: 'failed', finishedAt: new Date(), errors: ['Run timed out or the process stopped'] } },
  );
  const running = await SearchRunModel.findOne({ status: 'running' });
  if (running) {
    throw conflict('A job search is already running. Wait for it to finish.', {
      runId: String(running._id),
    });
  }
}

export async function runDiscovery(options: {
  trigger: 'manual' | 'scheduled';
  overrides?: DiscoveryOverrides;
}): Promise<DiscoveryResult> {
  await assertNoRunningRun();

  const settings = await getSettings();
  const profiles = await CandidateProfileModel.find({
    kind: { $in: settings.search.profileKinds },
  }).lean();
  const targetTitles = [
    ...new Set([
      ...profiles.flatMap((profile) => profile.targetTitles),
      ...settings.search.targetTitles,
    ]),
  ];

  const requestedSources = options.overrides?.sources;
  const enabledAdapters = adapters.filter((adapter) => {
    const configured = settings.sources[adapter.id]?.enabled ?? false;
    const searchFlag = settings.search.sources[adapter.id] ?? false;
    const requested = requestedSources ? requestedSources.includes(adapter.id) : true;
    return configured && searchFlag && requested && adapter.isConfigured();
  });

  if (enabledAdapters.length === 0) {
    const known = adapters.map((adapter) => adapter.id).join(', ');
    throw new AppError(
      400,
      'BAD_REQUEST',
      `No job sources are enabled and configured. Enable a source in Settings (available: ${known}).`,
    );
  }

  const totalBudget = Math.min(
    200,
    Math.max(1, options.overrides?.maxJobs ?? settings.search.maxJobsPerRun),
  );
  const perSourceBudget = Math.max(1, Math.floor(totalBudget / enabledAdapters.length));

  const run = await SearchRunModel.create({
    kind: 'jobs',
    status: 'running',
    trigger: options.trigger,
    criteriaSnapshot: {
      ...settings.search,
      targetTitles,
      requestedSources: requestedSources ?? null,
      keywords: options.overrides?.keywords ?? [],
      maxJobsPerRun: totalBudget,
    },
    startedAt: new Date(),
  });

  const started = Date.now();
  const sourceResults: DiscoveryResult['sources'] = [];
  let totalDiscovered = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalDuplicates = 0;
  let totalFiltered = 0;
  let successes = 0;

  for (const adapter of enabledAdapters) {
    const sourceStart = Date.now();
    const criteria: JobSearchCriteria = criteriaFromSettings(settings.search, {
      targetTitles,
      maxJobs: perSourceBudget,
      ...(options.overrides?.keywords?.length ? { includeKeywords: options.overrides.keywords } : {}),
    });

    let listings: JobListing[] = [];
    let adapterError = '';

    try {
      listings = await withTimeout(
        adapter.searchJobs(criteria),
        60_000,
        `${adapter.label} did not respond within 60 seconds`,
      );
      successes += 1;
    } catch (error) {
      adapterError = error instanceof Error ? error.message : 'Unknown adapter error';
      logger.warn({ source: adapter.id, error: adapterError }, 'Job source failed');
    }

    let filtered: JobListing[] = [];
    let rejected = 0;
    if (listings.length > 0) {
      const batchUrls = new Set<string>();
      for (const listing of listings) {
        if (batchUrls.has(listing.canonicalUrl)) {
          rejected += 1;
          continue;
        }
        const outcome = applyDeterministicFilters(listing, criteria);
        if (!outcome.included) {
          rejected += 1;
          continue;
        }
        batchUrls.add(listing.canonicalUrl);
        filtered.push(listing);
      }
      const remainingBudget = Math.max(0, totalBudget - totalCreated - totalUpdated);
      const limit = Math.min(perSourceBudget, remainingBudget);
      const budgetSkipped = Math.max(0, filtered.length - limit);
      if (budgetSkipped > 0) {
        // These listings passed the eligibility rules but were not processed because the run
        // budget was reached. Counting them keeps `found = created + updated + filtered` true,
        // so the run summary cannot look like listings vanished without a reason.
        logger.info(
          { source: adapter.id, budgetSkipped, limit },
          'Eligible listings skipped because the run budget was reached',
        );
        rejected += budgetSkipped;
      }
      filtered = filtered.slice(0, limit);
    }

    let upsert = { created: 0, updated: 0, duplicates: 0, jobIds: [] as unknown[] };
    if (filtered.length > 0) {
      try {
        upsert = await upsertJobListings(filtered, { searchRunId: run._id });
      } catch (error) {
        adapterError = adapterError || (error instanceof Error ? error.message : 'Failed to persist jobs');
      }
    }

    totalDiscovered += listings.length;
    totalCreated += upsert.created;
    totalUpdated += upsert.updated;
    totalDuplicates += upsert.duplicates;
    totalFiltered += rejected;

    sourceResults.push({
      source: adapter.id,
      status: adapterError ? 'failed' : 'ok',
      found: listings.length,
      created: upsert.created,
      updated: upsert.updated,
      duplicates: upsert.duplicates,
      filtered: rejected,
      durationMs: Date.now() - sourceStart,
      error: adapterError,
    });
  }

  const status: 'completed' | 'failed' = successes > 0 ? 'completed' : 'failed';
  const errors = sourceResults.filter((item) => item.error).map((item) => `${item.source}: ${item.error}`);

  // Keep previously stored rows consistent with the rules in force now.
  let deactivated = 0;
  try {
    deactivated = await deactivateIneligibleStoredJobs(
      criteriaFromSettings(settings.search, { targetTitles }),
    );
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : 'unknown' },
      'Stored job revalidation failed',
    );
  }

  await SearchRunModel.updateOne(
    { _id: run._id },
    {
      $set: {
        status,
        sources: sourceResults,
        discovered: totalDiscovered,
        created: totalCreated,
        updatedJobs: totalUpdated,
        duplicates: totalDuplicates,
        filteredOut: totalFiltered,
        errorMessages: errors,
        finishedAt: new Date(),
        durationMs: Date.now() - started,
      },
    },
  );

  logger.info(
    {
      runId: String(run._id),
      status,
      discovered: totalDiscovered,
      created: totalCreated,
      updated: totalUpdated,
      filtered: totalFiltered,
      deactivated,
      durationMs: Date.now() - started,
    },
    'Job discovery finished',
  );

  return {
    runId: String(run._id),
    status,
    discovered: totalDiscovered,
    created: totalCreated,
    updated: totalUpdated,
    duplicates: totalDuplicates,
    filteredOut: totalFiltered,
    sources: sourceResults,
  };
}

export async function getSourceConfigStatuses() {
  const settings = await getSettings();
  return adapters.map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    description: adapter.description,
    enabled: settings.sources[adapter.id]?.enabled ?? false,
    configured: adapter.isConfigured(),
    requiresConfiguration: adapter.requiresConfiguration,
    note: adapter.isConfigured() ? 'Ready' : 'Disabled until configured',
  }));
}

export { getAdapter };
