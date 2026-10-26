import type { Types } from 'mongoose';
import { SearchRunModel } from '../../models/SearchRun.js';
import { PhdPositionModel } from '../../models/PhdPosition.js';
import { getSettings } from '../settingsService.js';
import { assertNoRunningRun } from '../searchRuns.js';
import { withTimeout } from '../../utils/async.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { phdAdapters } from './adapters/index.js';
import { isTargetResearchArea } from './metadata.js';
import { passesPhdLocationRule } from './normalize.js';
import type { PhdDiscoveryResult, PhdListing } from './types.js';

function fieldsFor(listing: PhdListing) {
  return {
    source: listing.source,
    sourceJobId: listing.sourceJobId,
    sourceLabel: listing.sourceLabel,
    simulated: listing.simulated,
    url: listing.url,
    canonicalUrl: listing.canonicalUrl,
    applicationUrl: listing.applicationUrl,
    institution: listing.institution,
    title: listing.title,
    researchGroup: listing.researchGroup,
    supervisor: listing.supervisor,
    department: listing.department,
    location: listing.location,
    country: listing.country,
    workArrangement: listing.workArrangement,
    remoteEligibleFromGermany: listing.remoteEligibleFromGermany,
    researchTopic: listing.researchTopic,
    researchArea: listing.researchArea,
    researchAreaEvidence: listing.researchAreaEvidence,
    description: listing.description,
    requiredQualifications: listing.requiredQualifications,
    requiredSkills: listing.requiredSkills,
    preferredSkills: listing.preferredSkills,
    requiredMethods: listing.requiredMethods,
    requiredLanguages: listing.requiredLanguages,
    funding: listing.funding,
    fundingStatus: listing.fundingStatus,
    fundingEvidence: listing.fundingEvidence,
    salary: listing.salary,
    employmentRequirements: listing.employmentRequirements,
    languageRequirement: listing.languageRequirement,
    languageDecision: listing.languageDecision,
    languageEvidence: listing.languageEvidence,
    languageReason: listing.languageReason,
    languageConfidence: listing.languageConfidence,
    postedAt: listing.postedAt,
    postedAtUnknown: listing.postedAtUnknown,
    applicationDeadline: listing.applicationDeadline,
    deadlineTimezone: listing.deadlineTimezone,
    deadlineHasTime: listing.deadlineHasTime,
    deadlineStatus: listing.deadlineStatus,
    deadlineNote: listing.deadlineNote,
    expectedStartDate: listing.expectedStartDate,
    status: listing.status,
    statusNote: listing.statusNote,
    fingerprint: listing.fingerprint,
    contentHash: listing.contentHash,
    lastSeenAt: new Date(),
    // The source was fetched successfully in this run, which is what the timestamp verifies.
    lastVerifiedAt: new Date(),
  };
}

async function upsertPositions(
  listings: PhdListing[],
  options: { searchRunId: Types.ObjectId },
): Promise<{ created: number; updated: number; duplicates: number }> {
  let created = 0;
  let updated = 0;
  let duplicates = 0;
  const seen = new Set<string>();

  for (const listing of listings) {
    const key = `${listing.source}:${listing.sourceJobId}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);

    const existing =
      (await PhdPositionModel.findOne({
        source: listing.source,
        sourceJobId: listing.sourceJobId,
      })) ??
      (await PhdPositionModel.findOne({ canonicalUrl: listing.canonicalUrl })) ??
      (await PhdPositionModel.findOne({
        fingerprint: listing.fingerprint,
        discoveredAt: { $gte: new Date(Date.now() - 120 * 86_400_000) },
      }));

    if (existing) {
      await PhdPositionModel.updateOne(
        { _id: existing._id },
        {
          $set: {
            ...fieldsFor(listing),
            searchRunId: options.searchRunId,
          },
          $addToSet: { mergedSources: listing.source },
        },
      );
      updated += 1;
    } else {
      await PhdPositionModel.create({
        ...fieldsFor(listing),
        discoveredAt: new Date(),
        searchRunId: options.searchRunId,
        mergedSources: [listing.source],
      });
      created += 1;
    }
  }

  return { created, updated, duplicates };
}

export async function runPhdDiscovery(options: {
  trigger?: 'manual' | 'scheduled' | 'startup';
} = {}): Promise<PhdDiscoveryResult> {
  await assertNoRunningRun('phd');

  const settings = await getSettings();
  const enabled = phdAdapters.filter(
    (adapter) => (settings.sources[adapter.id]?.enabled ?? false) && adapter.isConfigured(),
  );

  if (enabled.length === 0) {
    throw new AppError(
      400,
      'BAD_REQUEST',
      'No PhD sources are enabled and configured. Enable the simulated source or set PHD_FEED_URL.',
    );
  }

  const run = await SearchRunModel.create({
    kind: 'phd',
    status: 'running',
    trigger: options.trigger ?? 'manual',
    criteriaSnapshot: { ...settings.phd, sources: enabled.map((adapter) => adapter.id) },
    startedAt: new Date(),
  });

  const started = Date.now();
  const sources: PhdDiscoveryResult['sources'] = [];
  let totalDiscovered = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalDuplicates = 0;
  let totalFiltered = 0;
  let successes = 0;

  const perSource = Math.max(1, Math.floor(settings.phd.maxPositionsPerRun / enabled.length));

  for (const adapter of enabled) {
    const sourceStart = Date.now();
    let listings: PhdListing[] = [];
    let error = '';

    try {
      listings = await withTimeout(
        adapter.searchPositions({ maxPositions: perSource }),
        45_000,
        `${adapter.label} did not respond within 45 seconds`,
      );
      successes += 1;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Unknown PhD source error';
      logger.warn({ source: adapter.id, error }, 'PhD source failed');
    }

    const accepted: PhdListing[] = [];
    const batchUrls = new Set<string>();
    const rejectionReasons: Record<string, number> = {};
    let filtered = 0;
    const reject = (reason: string) => {
      filtered += 1;
      rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
    };
    for (const listing of listings) {
      if (batchUrls.has(listing.canonicalUrl)) {
        reject('duplicate in batch');
        continue;
      }
      const location = passesPhdLocationRule(listing);
      if (!location.included) {
        reject('outside the target regions');
        continue;
      }
      if (!isTargetResearchArea(listing.researchArea)) {
        reject('research area outside AI, cybersecurity, software engineering and data');
        continue;
      }
      if (listing.fundingStatus !== 'funded') {
        reject('no explicit funding evidence');
        continue;
      }
      if (settings.phd.excludeGermanRequired && listing.languageDecision === 'Excluded') {
        reject('German language mandatory');
        continue;
      }
      batchUrls.add(listing.canonicalUrl);
      accepted.push(listing);
    }

    let upsert = { created: 0, updated: 0, duplicates: 0 };
    if (accepted.length > 0) {
      try {
        upsert = await upsertPositions(accepted.slice(0, perSource), { searchRunId: run._id });
      } catch (caught) {
        error = error || (caught instanceof Error ? caught.message : 'Failed to persist PhD positions');
      }
    }

    totalDiscovered += listings.length;
    totalCreated += upsert.created;
    totalUpdated += upsert.updated;
    totalDuplicates += upsert.duplicates;
    totalFiltered += filtered;

    sources.push({
      source: adapter.id,
      status: error ? 'failed' : 'ok',
      found: listings.length,
      created: upsert.created,
      updated: upsert.updated,
      duplicates: upsert.duplicates,
      filtered,
      rejectionReasons,
      durationMs: Date.now() - sourceStart,
      error,
    });
  }

  const status = successes > 0 ? 'completed' : 'failed';
  const errors = sources.filter((source) => source.error).map((source) => `${source.source}: ${source.error}`);

  await SearchRunModel.updateOne(
    { _id: run._id },
    {
      $set: {
        status,
        sources,
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
      filtered: totalFiltered,
    },
    'PhD discovery finished',
  );

  return {
    runId: String(run._id),
    status,
    discovered: totalDiscovered,
    created: totalCreated,
    updated: totalUpdated,
    duplicates: totalDuplicates,
    filteredOut: totalFiltered,
    sources,
  };
}
