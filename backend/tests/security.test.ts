import { describe, expect, it } from 'vitest';
import { normalizeListing } from '../src/services/jobs/normalize.js';
import { applyDeterministicFilters } from '../src/services/jobs/filters.js';
import { assertNavigableApplicationUrl, isSafeRemoteUrl } from '../src/utils/urlSafety.js';
import { verifyJobAvailability } from '../src/services/jobs/verify.js';
import { JobModel } from '../src/models/Job.js';
import type { JobSearchCriteria } from '../src/services/jobs/types.js';

const criteria: JobSearchCriteria = {
  countries: ['Germany'],
  remoteScope: ['Germany', 'European Union'],
  languages: ['English'],
  workArrangements: ['remote', 'hybrid', 'onsite'],
  seniority: ['mid', 'senior'],
  targetTitles: ['Full Stack Developer', 'AI Engineer'],
  profileKinds: ['full_stack', 'ai_engineer', 'devops_cloud'],
  includeKeywords: [],
  excludeKeywords: [],
  excludeInternships: true,
  excludeUnpaid: true,
  excludeGermanRequired: true,
  freshnessDays: 365,
  minAgeMonths: 3,
  maxJobs: 20,
};

function listing(overrides: Record<string, unknown> = {}) {
  return normalizeListing({
    source: 'test',
    sourceJobId: 'remote-restriction',
    sourceLabel: 'Test',
    url: 'https://jobs.example.com/roles/42',
    applicationUrl: 'https://jobs.example.com/roles/42/apply',
    employer: 'Example GmbH',
    title: 'Senior Full Stack Engineer',
    location: 'Remote',
    remote: true,
    employmentType: 'full-time',
    salary: '',
    tags: [],
    description: 'English is our working language. Build TypeScript services.',
    postedAt: new Date(Date.now() - 200 * 86_400_000),
    expiresAt: null,
    ...overrides,
  });
}

describe('application URL safety', () => {
  it('only accepts absolute http(s) pages', () => {
    expect(assertNavigableApplicationUrl('https://example.com/apply').hostname).toBe('example.com');
    expect(assertNavigableApplicationUrl('http://example.com/apply').protocol).toBe('http:');
    expect(() => assertNavigableApplicationUrl('javascript:alert(1)')).toThrow(/non-http/i);
    expect(() => assertNavigableApplicationUrl('file:///etc/passwd')).toThrow(/non-http/i);
    expect(() => assertNavigableApplicationUrl('not a url')).toThrow(/valid absolute/i);
    expect(() => assertNavigableApplicationUrl('https://user:pass@example.com/apply')).toThrow(
      /credentials/i,
    );
  });

  it('blocks loopback and private targets unless local testing is explicitly enabled', () => {
    expect(() => assertNavigableApplicationUrl('http://127.0.0.1:8080/apply')).toThrow(/private/i);
    expect(() => assertNavigableApplicationUrl('http://localhost:8080/apply')).toThrow(/private/i);
    expect(() => assertNavigableApplicationUrl('http://192.168.1.10/apply')).toThrow(/private/i);
    expect(
      assertNavigableApplicationUrl('http://127.0.0.1:8080/apply', { allowLocal: true }).port,
    ).toBe('8080');
  });

  it('discards unsafe application URLs during normalization', () => {
    const fallback = listing({ applicationUrl: 'javascript:alert(1)' });
    expect(fallback.applicationUrl).toBe('https://jobs.example.com/roles/42');

    const unsafeUrl = listing({ applicationUrl: 'file:///etc/passwd' });
    expect(unsafeUrl.applicationUrl).toBe('https://jobs.example.com/roles/42');
  });

  it('never fetches private listing URLs when verifying availability', async () => {
    expect(isSafeRemoteUrl('https://example.com/job')).toBe(true);
    expect(isSafeRemoteUrl('http://169.254.169.254/latest/meta-data')).toBe(false);

    const job = await JobModel.create({
      source: 'arbeitnow',
      sourceJobId: 'ssrf-check',
      sourceLabel: 'Arbeitnow',
      url: 'http://169.254.169.254/latest/meta-data',
      canonicalUrl: 'http://169.254.169.254/latest/meta-data',
      employer: 'Example',
      title: 'Senior Engineer',
      location: 'Berlin',
      description: 'English working language.',
      postedAt: new Date(Date.now() - 200 * 86_400_000),
      status: 'active',
      fingerprint: 'ssrf-fingerprint',
    });

    const availability = await verifyJobAvailability(String(job._id));
    expect(availability.status).toBe('unknown');
    expect(availability.evidence).toMatch(/not a public http/i);
  });
});

describe('remote location restrictions', () => {
  it('excludes a remote listing whose description restricts applicants to a non-EU country', () => {
    const job = listing({
      location: 'Remote',
      description:
        'English is our working language. This is a fully remote role, but candidates must be based in the United States. No international applicants.',
    });
    const outcome = applyDeterministicFilters(job, criteria);
    expect(outcome.included).toBe(false);
    expect(outcome.reasons).toContain('location_mismatch');
  });

  it('keeps an EU remote listing that only asks for Germany-based applicants', () => {
    const job = listing({
      location: 'Remote (EU)',
      description:
        'English is our working language. This is a remote role and candidates must be based in Germany.',
    });
    expect(applyDeterministicFilters(job, criteria).included).toBe(true);
  });
});
