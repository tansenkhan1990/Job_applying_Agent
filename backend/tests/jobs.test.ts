import { describe, expect, it } from 'vitest';
import { JobModel } from '../src/models/Job.js';
import { SearchRunModel } from '../src/models/SearchRun.js';
import { mockAdapter } from '../src/services/jobs/adapters/mock.js';
import { applyDeterministicFilters } from '../src/services/jobs/filters.js';
import { runDiscovery } from '../src/services/jobs/discovery.js';
import { upsertJobListings } from '../src/services/jobs/dedupe.js';
import { getSettings } from '../src/services/settingsService.js';
import { seedApprovedProfiles } from './helpers.js';
import type { JobSearchCriteria } from '../src/services/jobs/types.js';

const baseCriteria: JobSearchCriteria = {
  countries: ['Germany'],
  remoteScope: ['Germany', 'European Union'],
  languages: ['English'],
  workArrangements: ['remote', 'hybrid', 'onsite'],
  seniority: ['mid', 'senior'],
  targetTitles: ['Full Stack Developer', 'AI Engineer', 'DevOps Engineer'],
  profileKinds: ['full_stack', 'ai_engineer', 'devops_cloud'],
  includeKeywords: [],
  excludeKeywords: ['commission only'],
  excludeInternships: true,
  excludeUnpaid: true,
  freshnessDays: 30,
  maxJobs: 20,
};

describe('mock job source', () => {
  it('returns clearly fictional listings with stable identifiers', async () => {
    const listings = await mockAdapter.searchJobs(baseCriteria);
    expect(listings).toHaveLength(8);
    expect(listings.every((listing) => listing.source === 'mock')).toBe(true);
    expect(listings.every((listing) => listing.employer.includes('fictional'))).toBe(true);
  });

  it('filters test cases deterministically', async () => {
    const listings = await mockAdapter.searchJobs(baseCriteria);
    const included = listings.filter(
      (listing) => applyDeterministicFilters(listing, baseCriteria).included,
    );
    const ids = included.map((listing) => listing.sourceJobId).sort();
    expect(ids).toEqual([
      'mock-ai-engineer-rag',
      'mock-backend-german',
      'mock-fullstack-senior',
      'mock-platform-engineer',
    ]);

    const german = included.find((listing) => listing.sourceJobId === 'mock-backend-german');
    expect(german?.languageRequirement).toBe('german_required');
  });
});

describe('freshness window', () => {
  it('defaults to the last three days', async () => {
    const settings = await getSettings();
    expect(settings.search.freshnessDays).toBe(3);
  });

  it('rejects vacancies posted before the window', async () => {
    const [recent] = await mockAdapter.searchJobs(baseCriteria);
    expect(applyDeterministicFilters(recent, { ...baseCriteria, freshnessDays: 3 }).included).toBe(
      true,
    );

    const stale = {
      ...recent,
      sourceJobId: 'synthetic-stale',
      postedAt: new Date(Date.now() - 5 * 86_400_000),
    };
    const outcome = applyDeterministicFilters(stale, { ...baseCriteria, freshnessDays: 3 });
    expect(outcome.included).toBe(false);
    expect(outcome.reasons).toContain('older_than_freshness_window');
  });

  it('keeps listings without a publication date but flags them for review', async () => {
    const [recent] = await mockAdapter.searchJobs(baseCriteria);
    const outcome = applyDeterministicFilters({ ...recent, postedAt: null }, baseCriteria);
    expect(outcome.included).toBe(true);
    expect(outcome.flags).toContain('posted_date_unknown');
  });
});

describe('job upsert and deduplication', () => {
  it('creates a listing once and updates it on repeat', async () => {
    const [listing] = await mockAdapter.searchJobs(baseCriteria);
    const first = await upsertJobListings([listing]);
    expect(first.created).toBe(1);
    expect(first.updated).toBe(0);

    const second = await upsertJobListings([{ ...listing, description: `${listing.description} Updated.` }]);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);

    const jobs = await JobModel.find({});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.lastVerifiedAt).toBeInstanceOf(Date);
  });

  it('merges a duplicate listing from another source by canonical URL', async () => {
    const [listing] = await mockAdapter.searchJobs(baseCriteria);
    await upsertJobListings([listing]);
    const duplicate = {
      ...listing,
      source: 'remotive',
      sourceJobId: 'remotive-999',
      sourceLabel: 'Remotive',
      employer: 'Different Name',
    };
    const result = await upsertJobListings([duplicate]);
    expect(result.created).toBe(0);
    expect(result.duplicates).toBe(1);

    const job = await JobModel.findOne({ canonicalUrl: listing.canonicalUrl });
    expect(job?.mergedSources).toContain('remotive');
  });

  it('detects duplicates within a batch', async () => {
    const [listing] = await mockAdapter.searchJobs(baseCriteria);
    const result = await upsertJobListings([listing, listing]);
    expect(result.created).toBe(1);
    expect(result.duplicates).toBe(1);
  });
});

describe('discovery runs', () => {
  it('stores filtered mock jobs and a search run record', async () => {
    await seedApprovedProfiles();
    const result = await runDiscovery({ trigger: 'manual', overrides: { sources: ['mock'] } });
    expect(result.status).toBe('completed');
    expect(result.created).toBe(4);
    expect(result.filteredOut).toBe(4);

    const jobs = await JobModel.find({ source: 'mock' });
    expect(jobs.map((job) => job.sourceJobId).sort()).toEqual([
      'mock-ai-engineer-rag',
      'mock-backend-german',
      'mock-fullstack-senior',
      'mock-platform-engineer',
    ]);

    const run = await SearchRunModel.findById(result.runId);
    expect(run?.status).toBe('completed');
    expect(run?.sources[0]?.source).toBe('mock');
    expect(run?.duplicates).toBeGreaterThanOrEqual(0);
  });

  it('blocks a second concurrent search run', async () => {
    await seedApprovedProfiles();
    await SearchRunModel.create({ status: 'running', startedAt: new Date() });
    await expect(
      runDiscovery({ trigger: 'manual', overrides: { sources: ['mock'] } }),
    ).rejects.toThrow(/already running/);
  });

  it('reports adapter failures without losing successful sources', async () => {
    await seedApprovedProfiles();
    const settings = await getSettings();
    expect(settings.search.sources.mock).toBe(true);
    // Mock is the only configured source in tests; running it twice must still persist.
    const first = await runDiscovery({ trigger: 'manual', overrides: { sources: ['mock'] } });
    const second = await runDiscovery({ trigger: 'manual', overrides: { sources: ['mock'] } });
    expect(first.created).toBe(4);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(4);
  });
});
