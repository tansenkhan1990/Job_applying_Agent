import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { SearchRunModel } from '../src/models/SearchRun.js';
import { mockAdapter } from '../src/services/jobs/adapters/mock.js';
import { applyDeterministicFilters } from '../src/services/jobs/filters.js';
import { jobAgeCutoff } from '../src/services/jobs/age.js';
import { seedJob } from './helpers.js';
import type { JobListing, JobSearchCriteria } from '../src/services/jobs/types.js';

const app = createApp();
const day = 86_400_000;

const criteria: JobSearchCriteria = {
  countries: ['Germany'],
  remoteScope: ['Germany', 'European Union'],
  languages: ['English'],
  workArrangements: ['remote', 'hybrid', 'onsite'],
  seniority: ['mid', 'senior'],
  targetTitles: ['Full Stack Developer'],
  profileKinds: ['full_stack'],
  includeKeywords: [],
  excludeKeywords: [],
  excludeInternships: true,
  excludeUnpaid: true,
  excludeGermanRequired: true,
  freshnessDays: 365,
  maxAgeMonths: 3,
  maxJobs: 50,
};

interface Page {
  items: Array<{
    id: string;
    title: string;
    employer: string;
    country: string;
    workArrangement: string;
    seniority: string;
    status: string;
    ageEligibility: string;
    languageDecision: string;
    languageRequirement: string;
    postedAt: string | null;
    salaryMax: number | null;
    saved: boolean;
    bestMatch: { score: number } | null;
  }>;
  total: number;
  page: number;
  limit: number;
  pages: number;
}

async function list(query: string): Promise<Page> {
  const response = await request(app).get(`/api/jobs?limit=100${query ? `&${query}` : ''}`).expect(200);
  return response.body as Page;
}

/**
 * A small corpus that covers every branch the list has to get right: in-window German rows,
 * an EU-remote row, an out-of-window row, a row without a posting date, a German-mandatory row
 * and a foreign on-site row that discovery would never store.
 */
async function seedCorpus() {
  const listings = await mockAdapter.searchJobs(criteria);
  const base = listings[0]!;
  const germanRequired = listings.find((item) => item.languageRequirement === 'german_required')!;

  const seed = (
    sourceJobId: string,
    overrides: Partial<JobListing>,
    modelFields: Record<string, unknown> = {},
  ) =>
    seedJob(
      {
        ...base,
        sourceJobId,
        url: `https://example.com/integrity/${sourceJobId}`,
        applicationUrl: `https://example.com/integrity/${sourceJobId}`,
        expiresAt: null,
        ...overrides,
      } as JobListing,
      { fingerprint: `integrity-${sourceJobId}`, ...modelFields },
    );

  const rows = {
    cpp: await seed('integrity-cpp', {
      title: 'C++ Developer (m/w/d)',
      employer: 'AT&T Digital GmbH',
      location: 'Berlin, Germany',
      country: 'Germany',
      workArrangement: 'hybrid',
      seniority: 'mid',
      salary: '€70,000 – €90,000',
      postedAt: new Date(Date.now() - day),
    }),
    backend: await seed('integrity-backend', {
      title: 'Senior Backend Engineer',
      employer: 'Example Commerce GmbH',
      location: 'Munich, Germany',
      country: 'Germany',
      workArrangement: 'onsite',
      seniority: 'senior',
      postedAt: new Date(Date.now() - 2 * day),
    }),
    ai: await seed('integrity-ai', {
      title: 'AI Engineer (LLM)',
      employer: 'Foo [Bar] Technologies GmbH',
      location: 'Remote – European Union',
      country: 'European Union',
      workArrangement: 'remote',
      remote: true,
      seniority: 'mid',
      postedAt: new Date(Date.now() - 5 * day),
    }),
    devops: await seed('integrity-devops', {
      title: 'DevOps Engineer',
      employer: 'Example Cloud GmbH',
      location: 'Frankfurt, Germany',
      country: 'Germany',
      workArrangement: 'hybrid',
      seniority: 'senior',
      postedAt: new Date(Date.now() - 10 * day),
    }),
    saved: await seed(
      'integrity-saved',
      {
        title: 'Frontend Engineer',
        employer: 'Example Digital GmbH',
        location: 'Cologne, Germany',
        country: 'Germany',
        workArrangement: 'onsite',
        seniority: 'mid',
        postedAt: new Date(Date.now() - 20 * day),
      },
      { saved: true },
    ),
    data: await seed('integrity-data', {
      title: 'Data Engineer',
      employer: 'Example Data GmbH',
      location: 'Stuttgart, Germany',
      country: 'Germany',
      workArrangement: 'onsite',
      seniority: 'mid',
      postedAt: new Date(Date.now() - 40 * day),
    }),
    old: await seed('integrity-old', {
      title: 'Software Engineer',
      employer: 'Example Legacy GmbH',
      location: 'Bremen, Germany',
      country: 'Germany',
      workArrangement: 'onsite',
      postedAt: new Date(Date.now() - 150 * day),
    }),
    unknownDate: await seed('integrity-unknown-date', {
      title: 'Software Engineer',
      employer: 'Example Mystery GmbH',
      location: 'Dresden, Germany',
      country: 'Germany',
      workArrangement: 'onsite',
      postedAt: null,
    }),
    germanRequired: await seed('integrity-german-required', {
      title: germanRequired.title,
      employer: 'Example Deutsch GmbH',
      location: 'Leipzig, Germany',
      country: 'Germany',
      workArrangement: 'onsite',
      description: germanRequired.description,
      postedAt: new Date(Date.now() - 3 * day),
    }),
    foreignOnsite: await seed('integrity-foreign-onsite', {
      title: 'Backend Engineer',
      employer: 'Example Inc',
      location: 'Boston, United States',
      country: 'United States',
      workArrangement: 'onsite',
      postedAt: new Date(Date.now() - 3 * day),
    }),
  };

  return rows;
}

describe('job search text queries', () => {
  it('survives every query string, including regular-expression metacharacters', async () => {
    await seedCorpus();

    for (const q of ['C++', '(m/w/d)', 'Foo [Bar]', 'AT&T', 'a+b*c?', '\\', '(', 'Backend|Frontend']) {
      const response = await request(app)
        .get(`/api/jobs?limit=50&q=${encodeURIComponent(q)}`)
        .expect(200);
      expect(Array.isArray(response.body.items)).toBe(true);
    }

    // The escaped query must still find the row it names.
    const cpp = await list(`q=${encodeURIComponent('C++')}`);
    expect(cpp.items.map((item) => item.title)).toContain('C++ Developer (m/w/d)');

    // A stray bracket must not widen the search into every row.
    const bracket = await list(`q=${encodeURIComponent('Foo [Bar]')}`);
    expect(bracket.total).toBe(1);
    expect(bracket.items[0]!.employer).toBe('Foo [Bar] Technologies GmbH');

    const metachars = await list(`q=${encodeURIComponent('a+b*c?')}`);
    expect(metachars.total).toBe(0);
  });

  it('treats employer and country text as literal text', async () => {
    await seedCorpus();

    const at = await list(`employer=${encodeURIComponent('AT&T')}`);
    expect(at.total).toBe(1);
    expect(at.items[0]!.employer).toBe('AT&T Digital GmbH');

    const wrong = await list(`employer=${encodeURIComponent('A&T')}`);
    expect(wrong.total).toBe(0);
  });
});

describe('job search default results', () => {
  it('never leaks out-of-window, undated, German-mandatory or inactive rows', async () => {
    const rows = await seedCorpus();
    const page = await list('');
    const ids = page.items.map((item) => item.id);
    const cutoff = jobAgeCutoff(3);

    expect(ids).not.toContain(String(rows.old._id));
    expect(ids).not.toContain(String(rows.unknownDate._id));
    expect(ids).not.toContain(String(rows.germanRequired._id));
    expect(ids).toContain(String(rows.cpp._id));

    for (const item of page.items) {
      expect(item.status).toBe('active');
      expect(item.postedAt).toBeTruthy();
      expect(new Date(item.postedAt!).getTime()).toBeGreaterThan(cutoff.getTime());
      expect(item.ageEligibility).not.toBe('Expired');
      expect(item.languageRequirement).not.toBe('german_required');
      expect(item.languageDecision).not.toBe('Excluded');
    }

    // The German-mandatory row is reachable, but only when the caller asks for it.
    const explicit = await list('languageDecision=Excluded');
    expect(explicit.items.map((item) => item.id)).toEqual([String(rows.germanRequired._id)]);

    const review = await list('ageEligibility=Unknown');
    expect(review.items.map((item) => item.id)).toEqual([String(rows.unknownDate._id)]);
  });

  it('honours every filter it accepts', async () => {
    const rows = await seedCorpus();

    const checks: Array<[string, (item: Page['items'][number]) => boolean]> = [
      ['workArrangement=remote', (item) => item.workArrangement === 'remote'],
      ['workArrangement=onsite', (item) => item.workArrangement === 'onsite'],
      ['country=Germany', (item) => item.country === 'Germany'],
      ['seniority=senior', (item) => item.seniority === 'senior'],
      ['saved=true', (item) => item.saved === true],
      ['minSalary=70000', (item) => (item.salaryMax ?? 0) >= 70000],
    ];

    for (const [query, predicate] of checks) {
      const page = await list(query);
      expect(page.total).toBeGreaterThan(0);
      expect(page.items.every(predicate), `filter ${query} returned a mismatching row`).toBe(true);
    }

    const remote = await list('workArrangement=remote');
    expect(remote.items.map((item) => item.id)).toContain(String(rows.ai._id));

    const saved = await list('saved=true');
    expect(saved.items.map((item) => item.id)).toEqual([String(rows.saved._id)]);

    // Combining filters must narrow, never widen.
    const combined = await list('workArrangement=onsite&country=Germany&seniority=senior');
    expect(combined.items.map((item) => item.id)).toEqual([String(rows.backend._id)]);
  });
});

describe('job search pagination and sorting', () => {
  it('returns every row exactly once across pages', async () => {
    await seedCorpus();

    const all = await list('');
    const collected: string[] = [];
    const total = all.total;
    const limit = 3;
    const pages = Math.ceil(total / limit);

    for (let page = 1; page <= pages; page += 1) {
      const response = await request(app).get(`/api/jobs?limit=${limit}&page=${page}`).expect(200);
      expect(response.body.total).toBe(total);
      expect(response.body.pages).toBe(pages);
      collected.push(...response.body.items.map((item: { id: string }) => item.id));
    }

    expect(new Set(collected).size).toBe(collected.length);
    expect(collected.sort()).toEqual(all.items.map((item) => item.id).sort());
  });

  it('orders results according to the requested sort', async () => {
    await seedCorpus();

    const newest = await list('sort=newest');
    const dates = newest.items.map((item) => new Date(item.postedAt!).getTime());
    for (let index = 1; index < dates.length; index += 1) {
      expect(dates[index]!).toBeLessThanOrEqual(dates[index - 1]!);
    }

    const oldest = await list('sort=oldest');
    const ascending = oldest.items.map((item) => new Date(item.postedAt!).getTime());
    for (let index = 1; index < ascending.length; index += 1) {
      expect(ascending[index]!).toBeGreaterThanOrEqual(ascending[index - 1]!);
    }

    const byTitle = await list('sort=title');
    const titles = byTitle.items.map((item) => item.title.toLowerCase());
    expect(titles).toEqual([...titles].sort());

    const byEmployer = await list('sort=company');
    const employers = byEmployer.items.map((item) => item.employer.toLowerCase());
    expect(employers).toEqual([...employers].sort());

    const byScore = await list('sort=score');
    const scores = byScore.items.map((item) => item.bestMatch?.score ?? -1);
    for (let index = 1; index < scores.length; index += 1) {
      expect(scores[index]!).toBeLessThanOrEqual(scores[index - 1]!);
    }
  });
});

describe('German location recognition', () => {
  it('keeps German vacancies whose location omits the country or uses an umlaut spelling', async () => {
    const [base] = await mockAdapter.searchJobs(criteria);

    for (const location of [
      'Hanover',
      'München',
      'Köln',
      'Nürnberg',
      'Hagen',
      'Ludwigsburg',
      'Dingolfing, Bavaria',
      'Remote Germany',
    ]) {
      const outcome = applyDeterministicFilters(
        { ...base, location, country: '', workArrangement: 'onsite' } as JobListing,
        criteria,
      );
      expect(outcome.reasons, `location ${location}`).not.toContain('location_mismatch');
    }

    const foreign = applyDeterministicFilters(
      { ...base, location: 'Kielce, Poland', country: '', workArrangement: 'onsite' } as JobListing,
      criteria,
    );
    expect(foreign.reasons).toContain('location_mismatch');
  });
});

describe('job discovery accounting', () => {
  it('reports every listing it found as created, updated, duplicate or filtered', async () => {
    await request(app).post('/api/jobs/search').send({ sources: ['mock'] }).expect(201);

    const second = await request(app)
      .post('/api/jobs/search')
      .send({ sources: ['mock'] })
      .expect(201);

    expect(second.body.status).toBe('completed');
    expect(second.body.sources).toHaveLength(1);
    const source = second.body.sources[0];
    expect(source.found).toBeGreaterThan(0);
    expect(source.found).toBe(source.created + source.updated + source.duplicates + source.filtered);
    expect(second.body.discovered).toBe(source.found);
    expect(second.body.created).toBe(source.created);
    expect(second.body.filteredOut).toBe(source.filtered);

    // A second identical run refreshes the same rows instead of duplicating them.
    expect(source.created).toBe(0);
    expect(source.updated).toBeGreaterThan(0);
  });

  it('is not blocked by a running PhD search, but refuses a second job search', async () => {
    await SearchRunModel.create({ kind: 'phd', status: 'running', startedAt: new Date() });
    const response = await request(app)
      .post('/api/jobs/search')
      .send({ sources: ['mock'] })
      .expect(201);
    expect(response.body.status).toBe('completed');

    await SearchRunModel.create({ kind: 'jobs', status: 'running', startedAt: new Date() });
    const blocked = await request(app).post('/api/jobs/search').send({ sources: ['mock'] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/already running/);
  });
});
