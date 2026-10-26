import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { JobModel } from '../src/models/Job.js';
import { PhdPositionModel } from '../src/models/PhdPosition.js';
import { mockAdapter } from '../src/services/jobs/adapters/mock.js';
import { normalizePhdListing, type RawPhdListing } from '../src/services/phd/normalize.js';
import {
  assessPhdDeadline,
  classifyPhdResearchArea,
} from '../src/services/phd/metadata.js';
import { seedJob } from './helpers.js';
import type { JobSearchCriteria } from '../src/services/jobs/types.js';

const app = createApp();

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
  maxJobs: 20,
};

const day = 86_400_000;

async function seedJobsForDateRules() {
  const [sample] = await mockAdapter.searchJobs(criteria);
  const base = {
    ...sample,
    employer: 'Date Rule Examples GmbH',
    description: 'English is the working language.',
  };
  const recent = await seedJob(
    {
      ...base,
      sourceJobId: 'date-recent',
      url: 'https://example.org/date-rules/recent',
      postedAt: new Date(Date.now() - 10 * day),
    },
    { fingerprint: 'date-recent-fingerprint' },
  );
  const old = await seedJob(
    {
      ...base,
      sourceJobId: 'date-old',
      url: 'https://example.org/date-rules/old',
      postedAt: new Date(Date.now() - 150 * day),
      expiresAt: null,
    },
    { fingerprint: 'date-old-fingerprint' },
  );
  const unknown = await seedJob(
    {
      ...base,
      sourceJobId: 'date-unknown',
      url: 'https://example.org/date-rules/unknown',
      postedAt: null,
    },
    { fingerprint: 'date-unknown-fingerprint' },
  );
  return { recent, old, unknown };
}

describe('professional job posting-date boundary', () => {
  it('keeps unknown-date listings out of normal results and in a separate review view', async () => {
    const { recent, old, unknown } = await seedJobsForDateRules();

    const normal = await request(app).get('/api/jobs?limit=50').expect(200);
    const normalIds = normal.body.items.map((item: { id: string }) => item.id);
    expect(normalIds).toContain(String(recent._id));
    expect(normalIds).not.toContain(String(old._id));
    expect(normalIds).not.toContain(String(unknown._id));

    const review = await request(app)
      .get('/api/jobs?limit=50&ageEligibility=Unknown')
      .expect(200);
    expect(review.body.items.map((item: { id: string }) => item.id)).toEqual([String(unknown._id)]);
    expect(review.body.items[0].postedAt).toBeNull();
    expect(review.body.items[0].ageEligibility).toBe('Unknown');
  });

  it('never reveals older vacancies through a broad or custom date range', async () => {
    const { recent, old } = await seedJobsForDateRules();

    for (const query of [
      'postedWithinDays=3650',
      'postedAfter=2020-01-01',
      'postedBefore=2030-01-01',
    ]) {
      const response = await request(app).get(`/api/jobs?limit=50&${query}`).expect(200);
      const ids = response.body.items.map((item: { id: string }) => item.id);
      expect(ids).toContain(String(recent._id));
      expect(ids).not.toContain(String(old._id));
    }

    const capped = await request(app)
      .get('/api/jobs?limit=50&postedAfter=2020-01-01&postedBefore=2030-01-01')
      .expect(200);
    expect(capped.body.items.map((item: { id: string }) => item.id)).toContain(String(recent._id));
    expect(capped.body.items.map((item: { id: string }) => item.id)).not.toContain(String(old._id));
    expect(await JobModel.countDocuments()).toBeGreaterThan(0);
  });
});

const phdBase: RawPhdListing = {
  source: 'phd_test',
  sourceJobId: 'test-base',
  sourceLabel: 'Test PhD source',
  url: 'https://example.org/phd/test-base',
  institution: 'Example University',
  title: 'Doctoral Researcher',
  country: 'Germany',
  location: 'Berlin, Germany',
  researchTopic: 'Knowledge graphs and large language models',
  description:
    'English is the working language. Requirements: master degree in computer science and Python.',
  workArrangement: 'onsite',
};

async function seedPhd(raw: Partial<RawPhdListing>) {
  const listing = normalizePhdListing({ ...phdBase, ...raw });
  if (!listing) throw new Error('Test PhD listing could not be normalized');
  return PhdPositionModel.create({
    ...listing,
    discoveredAt: new Date(),
    lastVerifiedAt: new Date(),
  });
}

describe('PhD research-area classification', () => {
  it('classifies the prioritized areas deterministically', () => {
    expect(classifyPhdResearchArea('PhD in knowledge graphs and LLM evaluation').area).toBe('ai');
    expect(
      classifyPhdResearchArea('Doctoral position in cybersecurity and secure software systems')
        .area,
    ).toBe('cybersecurity');
    expect(
      classifyPhdResearchArea('Research on software engineering, developer tools, and testing')
        .area,
    ).toBe('software_engineering');
    expect(classifyPhdResearchArea('Doctoral researcher in marine biology').area).toBe('other');
  });
});

describe('PhD deadline assessment', () => {
  it('treats a date-only deadline as the whole local day', () => {
    const now = new Date('2026-10-25T23:30:00Z');
    const todayInBerlin = assessPhdDeadline({
      deadline: new Date('2026-10-26'),
      timezone: 'Europe/Berlin',
      hasTime: false,
      now,
    });
    expect(todayInBerlin.status).toBe('open');

    const passed = assessPhdDeadline({
      deadline: new Date('2026-10-24'),
      hasTime: false,
      timezone: 'Europe/Berlin',
      now,
    });
    expect(passed.status).toBe('expired');
  });

  it('compares an explicit clock time exactly and never assumes unknown deadlines are open', () => {
    const explicit = assessPhdDeadline({
      deadline: new Date('2026-10-26T10:00:00Z'),
      hasTime: true,
      now: new Date('2026-10-26T11:00:00Z'),
    });
    expect(explicit.status).toBe('expired');

    expect(assessPhdDeadline({ deadline: null }).status).toBe('unknown');
    expect(assessPhdDeadline({ deadline: new Date(Date.now() + day), closed: true }).status).toBe(
      'closed',
    );
  });
});

describe('PhD deadline eligibility in the API', () => {
  it('keeps old open positions, excludes expired/closed ones, and groups unknown deadlines', async () => {
    const oldButOpen = await seedPhd({
      sourceJobId: 'phd-old-open',
      url: 'https://example.org/phd/old-open',
      title: 'Old but open PhD in knowledge graphs',
      postedAt: new Date(Date.now() - 200 * day),
      applicationDeadline: new Date(Date.now() + 60 * day),
    });
    const expired = await seedPhd({
      sourceJobId: 'phd-expired',
      url: 'https://example.org/phd/expired',
      title: 'Expired PhD in cybersecurity',
      postedAt: new Date(Date.now() - 30 * day),
      applicationDeadline: new Date(Date.now() - 5 * day),
    });
    const unknown = await seedPhd({
      sourceJobId: 'phd-unknown-deadline',
      url: 'https://example.org/phd/unknown',
      title: 'PhD in software engineering with no stated deadline',
      postedAt: new Date(Date.now() - 30 * day),
    });
    const closed = await seedPhd({
      sourceJobId: 'phd-closed',
      url: 'https://example.org/phd/closed',
      title: 'Closed PhD in graph machine learning',
      postedAt: new Date(Date.now() - 30 * day),
      applicationDeadline: new Date(Date.now() + 30 * day),
      closed: true,
    });

    const openList = await request(app).get('/api/phd/positions?limit=50').expect(200);
    const openIds = openList.body.items.map((item: { id: string }) => item.id);
    expect(openIds).toContain(String(oldButOpen._id));
    expect(openIds).not.toContain(String(expired._id));
    expect(openIds).not.toContain(String(unknown._id));
    expect(openIds).not.toContain(String(closed._id));

    const unknownList = await request(app)
      .get('/api/phd/positions?limit=50&deadlineStatus=unknown')
      .expect(200);
    expect(unknownList.body.total).toBe(1);
    expect(unknownList.body.items[0].id).toBe(String(unknown._id));
    expect(unknownList.body.items[0].deadlineStatus).toBe('unknown');
    expect(unknownList.body.items[0].deadlineNote).toMatch(/does not state/i);

    const expiredList = await request(app)
      .get('/api/phd/positions?limit=50&deadlineStatus=expired')
      .expect(200);
    expect(expiredList.body.items.map((item: { id: string }) => item.id)).toEqual([
      String(expired._id),
    ]);

    const closedList = await request(app)
      .get('/api/phd/positions?limit=50&deadlineStatus=closed')
      .expect(200);
    expect(closedList.body.items.map((item: { id: string }) => item.id)).toEqual([
      String(closed._id),
    ]);
  });

  it('filters by research area, institution, and deadline window', async () => {
    const ai = await seedPhd({
      sourceJobId: 'phd-filter-ai',
      url: 'https://example.org/phd/filter-ai',
      title: 'PhD in large language models',
      institution: 'AI Institute Berlin',
      applicationDeadline: new Date(Date.now() + 20 * day),
    });
    const cyber = await seedPhd({
      sourceJobId: 'phd-filter-cyber',
      url: 'https://example.org/phd/filter-cyber',
      title: 'PhD in cybersecurity and secure software',
      institution: 'Security Research Institute',
      applicationDeadline: new Date(Date.now() + 80 * day),
    });

    const aiOnly = await request(app)
      .get('/api/phd/positions?limit=50&researchArea=ai')
      .expect(200);
    expect(aiOnly.body.items.map((item: { id: string }) => item.id)).toContain(String(ai._id));
    expect(aiOnly.body.items.map((item: { id: string }) => item.id)).not.toContain(
      String(cyber._id),
    );

    const byInstitution = await request(app)
      .get('/api/phd/positions?limit=50&institution=Security%20Research')
      .expect(200);
    expect(byInstitution.body.items.map((item: { id: string }) => item.id)).toContain(
      String(cyber._id),
    );
    expect(byInstitution.body.items.map((item: { id: string }) => item.id)).not.toContain(
      String(ai._id),
    );

    const closingSoon = await request(app)
      .get('/api/phd/positions?limit=50&deadlineWithinDays=30')
      .expect(200);
    const ids = closingSoon.body.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(String(ai._id));
    expect(ids).not.toContain(String(cyber._id));
    expect(closingSoon.body.items[0].researchAreaEvidence.length).toBeGreaterThan(0);
  });
});
