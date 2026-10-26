import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { JobModel } from '../src/models/Job.js';
import { PhdPositionModel } from '../src/models/PhdPosition.js';
import { mockAdapter } from '../src/services/jobs/adapters/mock.js';
import { normalizePhdListing, type RawPhdListing } from '../src/services/phd/normalize.js';
import {
  assessPhdDeadline,
  classifyPhdFunding,
  classifyPhdResearchArea,
} from '../src/services/phd/metadata.js';
import { AppSettingModel } from '../src/models/AppSetting.js';
import { getSettings } from '../src/services/settingsService.js';
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
  funding: 'TV-L E13, 65%',
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
    expect(
      classifyPhdResearchArea('Doctoral position in data engineering and database systems').area,
    ).toBe('data');
    expect(classifyPhdResearchArea('Doctoral researcher in marine biology').area).toBe('other');
  });

  it('requires explicit funding evidence and rejects self-funded advertisements', () => {
    expect(classifyPhdFunding({ funding: 'TV-L E13, 65%, three years' }).status).toBe('funded');
    expect(
      classifyPhdFunding({ description: 'The position is fully funded for three years.' }).status,
    ).toBe('funded');
    expect(
      classifyPhdFunding({ description: 'Applicants must secure their own funding.' }).status,
    ).toBe('not_funded');
    expect(
      classifyPhdFunding({ funding: 'Tuition fees apply; this is a self-funded programme.' }).status,
    ).toBe('not_funded');
    expect(classifyPhdFunding({ description: 'Master degree required.' }).status).toBe('unknown');
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
    // Rolling admission is open only because the advertisement says so.
    expect(assessPhdDeadline({ deadline: null, rolling: true }).status).toBe('open');
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

  it('treats an advertised rolling admission without a deadline as open', async () => {
    const rolling = await seedPhd({
      sourceJobId: 'phd-rolling',
      url: 'https://example.org/phd/rolling',
      title: 'Doctoral Researcher in software engineering',
      description:
        'Applications are accepted on a rolling basis. English is the working language. Master degree in computer science and Python required.',
      postedAt: new Date(Date.now() - 200 * day),
    });
    expect(rolling.rollingAdmissions).toBe(true);
    expect(rolling.deadlineStatus).toBe('open');

    const openList = await request(app).get('/api/phd/positions?limit=50').expect(200);
    expect(openList.body.items.map((item: { id: string }) => item.id)).toContain(
      String(rolling._id),
    );

    const unknownList = await request(app)
      .get('/api/phd/positions?limit=50&deadlineStatus=unknown')
      .expect(200);
    expect(unknownList.body.items.map((item: { id: string }) => item.id)).not.toContain(
      String(rolling._id),
    );
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

describe('PhD funding and language filters', () => {
  it('filters by funding evidence and hides German-mandatory positions by default', async () => {
    const deadline = new Date(Date.now() + 45 * day);
    const funded = await seedPhd({
      sourceJobId: 'phd-funded',
      url: 'https://example.org/phd/funded',
      title: 'Funded PhD in knowledge graphs',
      funding: 'TV-L E13, 65%',
      applicationDeadline: deadline,
    });
    const unfunded = await seedPhd({
      sourceJobId: 'phd-unfunded',
      url: 'https://example.org/phd/unfunded',
      title: 'PhD in AI systems (funding not stated)',
      description:
        'English is the working language. Requirements: master degree in computer science and Python.',
      funding: '',
      applicationDeadline: deadline,
    });
    const germanOnly = await seedPhd({
      sourceJobId: 'phd-german-required',
      url: 'https://example.org/phd/german',
      title: 'Doktorand im Bereich Software Engineering',
      description:
        'German language skills are mandatory. Deutschkenntnisse sind zwingend erforderlich. Master degree in computer science required.',
      funding: 'TV-L E13, 65%',
      applicationDeadline: deadline,
    });

    const fundedOnly = await request(app)
      .get('/api/phd/positions?limit=50&funded=true')
      .expect(200);
    const fundedIds = fundedOnly.body.items.map((item: { id: string }) => item.id);
    expect(fundedIds).toContain(String(funded._id));
    expect(fundedIds).not.toContain(String(unfunded._id));

    const noFunding = await request(app)
      .get('/api/phd/positions?limit=50&funded=false')
      .expect(200);
    const unfundedIds = noFunding.body.items.map((item: { id: string }) => item.id);
    expect(unfundedIds).toContain(String(unfunded._id));
    expect(unfundedIds).not.toContain(String(funded._id));

    // Mandatory German is excluded from the default list even when the deadline is open.
    const normal = await request(app).get('/api/phd/positions?limit=50').expect(200);
    const normalIds = normal.body.items.map((item: { id: string }) => item.id);
    expect(normalIds).toContain(String(funded._id));
    expect(normalIds).not.toContain(String(germanOnly._id));

    const explicit = await request(app)
      .get('/api/phd/positions?limit=50&languageDecision=Excluded')
      .expect(200);
    expect(explicit.body.items.map((item: { id: string }) => item.id)).toEqual([
      String(germanOnly._id),
    ]);
  });
});

describe('three-month cap cannot be widened', () => {
  it('rejects a wider setting, clamps a stored wider value, and still hides old jobs', async () => {
    const { recent, old } = await seedJobsForDateRules();
    await getSettings(); // create the settings document with defaults
    await AppSettingModel.updateOne(
      { key: 'global' },
      { $set: { 'value.search.maxAgeMonths': 12 } },
    );

    const migrated = await getSettings();
    expect(migrated.search.maxAgeMonths).toBe(3);

    const list = await request(app).get('/api/jobs?limit=50').expect(200);
    const ids = list.body.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(String(recent._id));
    expect(ids).not.toContain(String(old._id));

    await request(app)
      .patch('/api/settings')
      .send({ search: { maxAgeMonths: 12 } })
      .expect(400);
    const accepted = await request(app)
      .patch('/api/settings')
      .send({ search: { maxAgeMonths: 3 } })
      .expect(200);
    expect(accepted.body.settings.search.maxAgeMonths).toBe(3);
  });
});

describe('quick posting-date windows', () => {
  async function seedPostingWindows() {
    const [sample] = await mockAdapter.searchJobs(criteria);
    const base = {
      ...sample,
      employer: 'Posting Window Examples GmbH',
      description: 'English is the working language.',
    };
    const seedAt = (sourceJobId: string, daysAgo: number) =>
      seedJob(
        {
          ...base,
          sourceJobId,
          url: `https://example.org/posting-windows/${sourceJobId}`,
          postedAt: new Date(Date.now() - daysAgo * day),
          expiresAt: null,
        },
        { fingerprint: `${sourceJobId}-fingerprint` },
      );
    return {
      twoDays: await seedAt('window-2d', 2),
      fiveDays: await seedAt('window-5d', 5),
      twentyDays: await seedAt('window-20d', 20),
      halfYear: await seedAt('window-180d', 180),
    };
  }

  it('narrows to the requested window and keeps every eligible date for "any date"', async () => {
    const { twoDays, fiveDays, twentyDays, halfYear } = await seedPostingWindows();
    const idsAt = async (query: string) => {
      const response = await request(app).get(`/api/jobs?limit=50&${query}`).expect(200);
      return response.body.items.map((item: { id: string }) => item.id);
    };

    const threeDays = await idsAt('postedWithinDays=3');
    expect(threeDays).toContain(String(twoDays._id));
    expect(threeDays).not.toContain(String(fiveDays._id));
    expect(threeDays).not.toContain(String(twentyDays._id));

    const sevenDays = await idsAt('postedWithinDays=7');
    expect(sevenDays).toContain(String(twoDays._id));
    expect(sevenDays).toContain(String(fiveDays._id));
    expect(sevenDays).not.toContain(String(twentyDays._id));

    // One month is sent as 30 days, matching the existing day-based windows.
    const oneMonth = await idsAt('postedWithinDays=30');
    expect(oneMonth).toContain(String(twentyDays._id));
    expect(oneMonth).not.toContain(String(halfYear._id));

    // "Any date" sends no window at all; the mandatory three-calendar-month cap still applies.
    const anyDate = await idsAt('sort=newest');
    expect(anyDate).toContain(String(twoDays._id));
    expect(anyDate).toContain(String(fiveDays._id));
    expect(anyDate).toContain(String(twentyDays._id));
    expect(anyDate).not.toContain(String(halfYear._id));
  });
});
