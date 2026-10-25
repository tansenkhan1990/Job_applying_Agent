import { describe, expect, it } from 'vitest';
import {
  canonicalizeUrl,
  detectCountry,
  detectLanguageRequirement,
  detectSeniority,
  detectWorkArrangement,
  jobFingerprint,
  normalizeListing,
} from '../src/services/jobs/normalize.js';
import { extractJsonObject, stripHtml } from '../src/utils/text.js';
import { applyDeterministicFilters, titleRelevance } from '../src/services/jobs/filters.js';
import { extractYearsRequirement, skillPresent } from '../src/services/matching/deterministic.js';
import type { JobSearchCriteria } from '../src/services/jobs/types.js';

const criteria: JobSearchCriteria = {
  countries: ['Germany'],
  remoteScope: ['Germany', 'European Union'],
  languages: ['English'],
  workArrangements: ['remote', 'hybrid', 'onsite'],
  seniority: ['mid', 'senior'],
  targetTitles: ['Full Stack Developer', 'AI Engineer', 'DevOps Engineer'],
  profileKinds: ['full_stack', 'ai_engineer', 'devops_cloud'],
  includeKeywords: [],
  excludeKeywords: ['unpaid'],
  excludeInternships: true,
  excludeUnpaid: true,
  freshnessDays: 30,
  maxJobs: 40,
};

function listing(overrides: Partial<Parameters<typeof normalizeListing>[0]> = {}) {
  return normalizeListing({
    source: 'test',
    sourceJobId: '1',
    sourceLabel: 'Test',
    url: 'https://Example.com/jobs/1?utm_source=x&ref=y',
    applicationUrl: 'https://example.com/jobs/1',
    employer: 'Example GmbH',
    title: 'Senior Full Stack Developer',
    location: 'Berlin, Germany',
    remote: false,
    employmentType: 'full-time',
    salary: '',
    tags: [],
    description: 'React, TypeScript and Node.js. English working language.',
    postedAt: new Date(),
    expiresAt: null,
    ...overrides,
  });
}

describe('text helpers', () => {
  it('extracts JSON from fenced or prose-wrapped model output', () => {
    expect(extractJsonObject('```json\n{"score": 90}\n```')).toEqual({ score: 90 });
    expect(extractJsonObject('Here is the result: {"score": 80, "nested": {"a": "b}"}} trailing')).toEqual({
      score: 80,
      nested: { a: 'b}' },
    });
    expect(() => extractJsonObject('no object here')).toThrow();
  });

  it('strips HTML and decodes entities', () => {
    expect(stripHtml('<p>Hello &amp; welcome</p><ul><li>One</li></ul>')).toContain('Hello & welcome');
    expect(stripHtml('A&nbsp;B')).toBe('A B');
  });
});

describe('job normalization', () => {
  it('canonicalizes URLs and removes tracking parameters', () => {
    expect(canonicalizeUrl('http://www.Example.com/jobs/1/?utm_source=x&ref=y#apply')).toBe(
      'https://example.com/jobs/1',
    );
  });

  it('derives fingerprints independently of casing and company suffixes', () => {
    expect(jobFingerprint('Example GmbH', 'Senior Engineer', 'Berlin')).toBe(
      jobFingerprint('example', 'SENIOR ENGINEER', 'berlin'),
    );
  });

  it('detects location, work arrangement and seniority', () => {
    expect(detectCountry('München, Germany')).toBe('Germany');
    expect(detectCountry('Remote – European Union')).toBe('European Union');
    expect(detectWorkArrangement('Engineer', 'Berlin', 'Hybrid role, 2 days in office', false)).toBe('hybrid');
    expect(detectWorkArrangement('Engineer', 'Remote', 'Fully remote', true)).toBe('remote');
    expect(detectSeniority('Senior Platform Engineer', '')).toBe('senior');
    expect(detectSeniority('Working Student Frontend', '')).toBe('junior');
  });

  it('distinguishes mandatory German from preferred German', () => {
    expect(detectLanguageRequirement('Sehr gute Deutschkenntnisse (C1) sind zwingend erforderlich.')).toBe(
      'german_required',
    );
    expect(detectLanguageRequirement('You must be fluent in German for this role.')).toBe('german_required');
    expect(detectLanguageRequirement('German is a plus but English is our working language.')).toBe(
      'german_preferred',
    );
    expect(detectLanguageRequirement('English is our working language.')).toBe('english_ok');
    expect(detectLanguageRequirement('Join our international team.')).toBe('unknown');
  });

  it('extracts years-of-experience requirements', () => {
    expect(extractYearsRequirement('You have 5+ years of experience with TypeScript')).toBe(5);
    expect(extractYearsRequirement('At least 3 years of professional experience')).toBe(3);
    expect(extractYearsRequirement('No explicit requirement here')).toBeNull();
  });

  it('matches skills with aliases', () => {
    expect(skillPresent('We use Node.js and K8s', 'Node.js')).toBe(true);
    expect(skillPresent('Experience with RAG pipelines', 'Retrieval-Augmented Generation')).toBe(true);
    expect(skillPresent('Rust and Go', 'Python')).toBe(false);
  });
});

describe('deterministic discovery filters', () => {
  it('keeps a German-mandatory role instead of excluding it for mentioning German', () => {
    const job = listing({
      description: 'Senior Full Stack Developer. Deutschkenntnisse C1 sind zwingend erforderlich.',
    });
    expect(job.languageRequirement).toBe('german_required');
    const outcome = applyDeterministicFilters(job, criteria);
    expect(outcome.included).toBe(true);
    expect(outcome.flags).toContain('german_required');
  });

  it('excludes internships, unpaid roles, stale jobs and wrong locations', () => {
    expect(
      applyDeterministicFilters(
        listing({ title: 'Full Stack Developer Intern', description: 'Internship, unpaid.' }),
        criteria,
      ).included,
    ).toBe(false);
    expect(
      applyDeterministicFilters(
        listing({ description: 'React role. Commission only, no base salary.' }),
        criteria,
      ).reasons,
    ).toContain('unpaid_excluded');
    expect(
      applyDeterministicFilters(
        listing({ postedAt: new Date(Date.now() - 90 * 86_400_000) }),
        criteria,
      ).reasons,
    ).toContain('older_than_freshness_window');
    expect(
      applyDeterministicFilters(
        listing({ title: 'AI Engineer', location: 'Remote – USA only', remote: true, country: 'Other' }),
        criteria,
      ).reasons,
    ).toContain('location_mismatch');
    expect(
      applyDeterministicFilters(
        listing({ title: 'Sales Representative', description: 'Sales role.' }),
        criteria,
      ).reasons,
    ).toContain('title_not_relevant');
  });

  it('scores title relevance broadly for engineering roles', () => {
    expect(titleRelevance('Senior Full Stack Engineer', ['Full Stack Developer'])).toBeGreaterThan(0.5);
    expect(titleRelevance('Cloud Platform Engineer', ['DevOps Engineer'])).toBeGreaterThan(0);
    expect(titleRelevance('Accountant', ['Full Stack Developer'])).toBe(0);
  });
});
