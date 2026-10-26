import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { JobModel } from '../src/models/Job.js';
import { SearchRunModel } from '../src/models/SearchRun.js';
import { mockAdapter } from '../src/services/jobs/adapters/mock.js';
import { applyDeterministicFilters } from '../src/services/jobs/filters.js';
import { normalizeListing } from '../src/services/jobs/normalize.js';
import { deactivateIneligibleStoredJobs, runDiscovery } from '../src/services/jobs/discovery.js';
import { upsertJobListings } from '../src/services/jobs/dedupe.js';
import { getSettings } from '../src/services/settingsService.js';
import { defaultSettings } from '../src/config/defaults.js';
import { AppSettingModel } from '../src/models/AppSetting.js';
import { seedApprovedProfiles } from './helpers.js';
import { criteriaFromSettings, type JobSearchCriteria } from '../src/services/jobs/types.js';

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
  excludeGermanRequired: true,
  freshnessDays: 30,
  maxAgeMonths: 3,
  maxJobs: 20,
};

describe('mock job source', () => {
  it('returns clearly fictional listings with stable identifiers', async () => {
    const listings = await mockAdapter.searchJobs(baseCriteria);
    expect(listings).toHaveLength(8);
    expect(listings.every((listing) => listing.source === 'mock')).toBe(true);
    expect(listings.every((listing) => listing.employer.includes('fictional'))).toBe(true);
  });

  it('rejects remote listings that are explicitly restricted to another region', async () => {
    const [listing] = await mockAdapter.searchJobs(baseCriteria);
    const restricted = {
      ...listing,
      location: 'Europe, USA, Canada, APAC',
      country: 'Other',
      remote: true,
      workArrangement: 'remote' as const,
      remoteEligibleFromGermany: false,
    };
    expect(applyDeterministicFilters(restricted, baseCriteria).reasons).toContain(
      'location_mismatch',
    );
  });

  it('filters test cases deterministically', async () => {
    const listings = await mockAdapter.searchJobs(baseCriteria);
    const included = listings.filter(
      (listing) => applyDeterministicFilters(listing, baseCriteria).included,
    );
    const ids = included.map((listing) => listing.sourceJobId).sort();
    expect(ids).toEqual([
      'mock-ai-engineer-rag',
      'mock-fullstack-senior',
      'mock-platform-engineer',
    ]);

    const german = listings.find((listing) => listing.sourceJobId === 'mock-backend-german');
    expect(german?.languageRequirement).toBe('german_required');
    expect(applyDeterministicFilters(german!, baseCriteria).reasons).toContain('language_excluded');
  });

  it('keeps German-optional and explicitly not-required listings', async () => {
    const listings = await mockAdapter.searchJobs(baseCriteria);
    const ai = listings.find((listing) => listing.sourceJobId === 'mock-ai-engineer-rag')!;
    const platform = listings.find((listing) => listing.sourceJobId === 'mock-platform-engineer')!;
    expect(ai.languageRequirement).toBe('german_not_required');
    expect(platform.languageRequirement).toBe('german_not_required');
    expect(applyDeterministicFilters(ai, baseCriteria).included).toBe(true);
    expect(applyDeterministicFilters(platform, baseCriteria).included).toBe(true);
  });

  it('keeps German-mandatory listings when the filter is disabled', async () => {
    const listings = await mockAdapter.searchJobs(baseCriteria);
    const german = listings.find((listing) => listing.sourceJobId === 'mock-backend-german')!;
    const outcome = applyDeterministicFilters(german, {
      ...baseCriteria,
      excludeGermanRequired: false,
    });
    expect(outcome.included).toBe(true);
    expect(outcome.flags).toContain('german_required');
  });
});

describe('freshness window', () => {
  it('defaults to a three-calendar-month posting window and one-year retention cap', async () => {
    const settings = await getSettings();
    expect(settings.search.maxAgeMonths).toBe(3);
    expect(settings.search.freshnessDays).toBe(365);
  });

  it('rejects vacancies that are three or more calendar months old', async () => {
    const [recent] = await mockAdapter.searchJobs(baseCriteria);
    const stale = {
      ...recent,
      sourceJobId: 'synthetic-old',
      postedAt: new Date(Date.now() - 120 * 86_400_000),
    };
    const outcome = applyDeterministicFilters(stale, baseCriteria);
    expect(outcome.included).toBe(false);
    expect(outcome.reasons).toContain('older_than_max_age');
  });

  it('rejects vacancies older than the retention window', async () => {
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
    expect(outcome.reasons).toContain('older_than_max_age');
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

  it('persists the unknown-publication-date marker', async () => {
    const [listing] = await mockAdapter.searchJobs(baseCriteria);
    await upsertJobListings([
      { ...listing, sourceJobId: 'synthetic-undated', postedAt: null },
    ]);
    const stored = await JobModel.findOne({ sourceJobId: 'synthetic-undated' });
    expect(stored?.postedAtUnknown).toBe(true);
  });

  it('detects duplicates within a batch', async () => {
    const [listing] = await mockAdapter.searchJobs(baseCriteria);
    const result = await upsertJobListings([listing, listing]);
    expect(result.created).toBe(1);
    expect(result.duplicates).toBe(1);
  });
});

describe('jobs API language filter', () => {
  it('hides German-mandatory listings by default and only includes them when requested', async () => {
    const listings = await mockAdapter.searchJobs(baseCriteria);
    const german = listings.find((listing) => listing.sourceJobId === 'mock-backend-german')!;
    const english = listings.find((listing) => listing.sourceJobId === 'mock-fullstack-senior')!;
    await upsertJobListings([german, english]);

    const app = createApp();
    const filtered = await request(app).get(
      '/api/jobs?limit=50&status=active&excludeGermanRequired=true',
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.items[0].title).toBe('Senior Full Stack Engineer');

    // The configured default applies server-side, so a plain list request cannot reveal a
    // German-mandatory vacancy.
    const defaultList = await request(app).get('/api/jobs?limit=50&status=active');
    expect(defaultList.status).toBe(200);
    expect(defaultList.body.items.map((item: { title: string }) => item.title)).toEqual([
      'Senior Full Stack Engineer',
    ]);

    const all = await request(app).get(
      '/api/jobs?limit=50&status=active&excludeGermanRequired=false',
    );
    expect(all.status).toBe(200);
    expect(all.body.items.map((item: { title: string }) => item.title)).toContain(
      'Senior Backend Engineer',
    );
  });
});

describe('stored listing revalidation', () => {
  it('deactivates stored vacancies that no longer satisfy the geography rule', async () => {
    const [listing] = await mockAdapter.searchJobs(baseCriteria);
    await upsertJobListings([listing]);
    // Simulate a row stored before the current geography rule was enforced.
    await JobModel.updateOne(
      { sourceJobId: listing.sourceJobId },
      { $set: { country: '', location: 'London', workArrangement: 'hybrid', remote: false } },
    );

    const settings = await getSettings();
    const deactivated = await deactivateIneligibleStoredJobs(
      criteriaFromSettings(settings.search, { targetTitles: [] }),
    );
    expect(deactivated).toBe(1);

    const stored = await JobModel.findOne({ sourceJobId: listing.sourceJobId });
    expect(stored?.status).toBe('unavailable');
    expect(stored?.statusNote).toMatch(/location_mismatch/);

    const app = createApp();
    const list = await request(app).get('/api/jobs?limit=50&status=active');
    expect(list.body.items).toHaveLength(0);
  });
});

describe('settings migration', () => {
  it('defaults the German filter on for settings stored before the option existed', async () => {
    const legacy = structuredClone(defaultSettings()) as {
      search: { excludeGermanRequired?: boolean };
    };
    delete legacy.search.excludeGermanRequired;
    await AppSettingModel.create({ key: 'global', value: legacy });

    const settings = await getSettings();
    expect(settings.search.excludeGermanRequired).toBe(true);
  });

  it('persists a model selected in settings without exposing the API key', async () => {
    const app = createApp();
    const updated = await request(app)
      .patch('/api/settings')
      .send({ ai: { model: 'google/gemini-2.5-flash' } });
    expect(updated.status).toBe(200);
    expect(updated.body.settings.ai.model).toBe('google/gemini-2.5-flash');

    const fetched = await request(app).get('/api/settings');
    expect(fetched.body.settings.ai.model).toBe('google/gemini-2.5-flash');
    expect(fetched.body.ai).not.toHaveProperty('apiKey');
    expect(JSON.stringify(fetched.body.ai)).not.toMatch(/sk-or-v1-/);
  });
});

describe('discovery runs', () => {
  it('stores filtered mock jobs and a search run record', async () => {
    await seedApprovedProfiles();
    const result = await runDiscovery({ trigger: 'manual', overrides: { sources: ['mock'] } });
    expect(result.status).toBe('completed');
    expect(result.created).toBe(3);
    expect(result.filteredOut).toBe(5);

    const jobs = await JobModel.find({ source: 'mock' });
    expect(jobs.map((job) => job.sourceJobId).sort()).toEqual([
      'mock-ai-engineer-rag',
      'mock-fullstack-senior',
      'mock-platform-engineer',
    ]);
    expect(jobs.every((job) => job.languageRequirement !== 'german_required')).toBe(true);

    const run = await SearchRunModel.findById(result.runId);
    expect(run?.status).toBe('completed');
    expect(run?.sources[0]?.source).toBe('mock');
    expect(run?.duplicates).toBeGreaterThanOrEqual(0);
  });

  it('counts eligible listings that the run budget skipped instead of dropping them silently', async () => {
    await seedApprovedProfiles();
    // The mock adapter normally honours the budget itself; bypass it so the run sees three
    // eligible listings and can only persist two of them.
    const eligibleIds = ['mock-ai-engineer-rag', 'mock-fullstack-senior', 'mock-platform-engineer'];
    const original = mockAdapter.searchJobs;
    const seeded = await original(baseCriteria);
    const eligible = seeded.filter((listing) => eligibleIds.includes(listing.sourceJobId));
    expect(eligible).toHaveLength(3);
    mockAdapter.searchJobs = async () => eligible;

    try {
      const result = await runDiscovery({
        trigger: 'manual',
        overrides: { sources: ['mock'], maxJobs: 2 },
      });

      expect(result.created).toBe(2);
      // The third eligible listing did not fit the budget. Reporting 0 would make the run
      // totals appear to lose a listing that passed every rule.
      expect(result.filteredOut).toBe(1);
      expect(result.created + result.updated + result.filteredOut).toBe(result.discovered);
    } finally {
      mockAdapter.searchJobs = original;
    }
  });

  it('stores an age classification and reason for every discovered job with a date', async () => {
    await seedApprovedProfiles();
    await runDiscovery({ trigger: 'manual', overrides: { sources: ['mock'] } });
    const jobs = await JobModel.find({ source: 'mock' });
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job.postedAt).toBeInstanceOf(Date);
      expect(job.ageEligibility).toBe('Eligible');
      expect(job.ageReason.length).toBeGreaterThan(10);
      expect(job.eligibleAfter).toBeInstanceOf(Date);
    }
  });

  it('defaults to keeping only non-German-required vacancies', async () => {
    const settings = await getSettings();
    expect(settings.search.excludeGermanRequired).toBe(true);
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
    expect(first.created).toBe(3);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(3);
  });

  it('keeps previously discovered jobs when a source is temporarily unavailable', async () => {
    await seedApprovedProfiles();
    await runDiscovery({ trigger: 'manual', overrides: { sources: ['mock'] } });
    const before = await JobModel.countDocuments();
    expect(before).toBeGreaterThan(0);

    const original = mockAdapter.searchJobs;
    mockAdapter.searchJobs = async () => {
      throw new Error('Source temporarily unavailable (simulated)');
    };
    try {
      const result = await runDiscovery({ trigger: 'manual', overrides: { sources: ['mock'] } });
      expect(result.status).toBe('failed');
      expect(result.sources[0].error).toMatch(/temporarily unavailable/i);
    } finally {
      mockAdapter.searchJobs = original;
    }
    expect(await JobModel.countDocuments()).toBe(before);
  });
});

describe('simulated fixture labelling', () => {
  it('marks mock listings as simulated and never marks live adapters', async () => {
    const listings = await mockAdapter.searchJobs(baseCriteria);
    expect(listings.length).toBeGreaterThan(0);
    expect(listings.every((listing) => listing.simulated === true)).toBe(true);
    expect(listings.every((listing) => listing.sourceLabel.includes('fictional'))).toBe(true);

    const live = normalizeListing({
      source: 'arbeitnow',
      sourceJobId: 'live-1',
      sourceLabel: 'Arbeitnow',
      url: 'https://example.com/jobs/1',
      employer: 'Example GmbH',
      title: 'Backend Engineer',
      location: 'Berlin',
      remote: false,
      workArrangement: 'onsite',
      applicationUrl: 'https://example.com/jobs/1',
      employmentType: 'full-time',
      salary: '',
      tags: [],
      description: 'English is the working language.',
      postedAt: new Date(),
      expiresAt: null,
    });
    expect(live.simulated).toBe(false);
  });
});
