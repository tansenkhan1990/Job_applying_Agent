import { describe, expect, it } from 'vitest';
import {
  DEFAULT_JOB_FILTERS,
  buildJobListQuery,
  buildPhdListQuery,
  jobScoreRange,
  type JobFilters,
  type PhdQueryInput,
} from './listQuery';

function filters(overrides: Partial<JobFilters> = {}): JobFilters {
  return { ...DEFAULT_JOB_FILTERS, ...overrides };
}

function phd(overrides: Partial<PhdQueryInput> = {}): PhdQueryInput {
  return {
    search: '',
    topic: '',
    researchArea: '',
    institution: '',
    country: '',
    arrangement: '',
    deadlineGroup: 'open',
    deadlineWindow: '',
    scoreBand: '',
    language: '',
    funded: '',
    savedOnly: false,
    unreviewedOnly: false,
    letterFilter: 'all',
    sort: 'newest',
    page: 1,
    ...overrides,
  };
}

describe('job list query builder', () => {
  it('defaults to active, English-first results with no day-count narrowing', () => {
    const params = buildJobListQuery(DEFAULT_JOB_FILTERS, '', 1);
    expect(params.get('status')).toBe('active');
    expect(params.get('sort')).toBe('newest');
    expect(params.get('excludeGermanRequired')).toBe('true');
    expect(params.get('postedWithinDays')).toBeNull();
    expect(params.get('minScore')).toBeNull();
    expect(params.get('page')).toBe('1');
    expect(params.get('limit')).toBe('20');
  });

  it('combines text, category, location, arrangement, company and employment filters', () => {
    const params = buildJobListQuery(
      filters({
        category: 'ai',
        profileKind: 'ai_engineer',
        locationScope: 'outside_germany_remote',
        arrangement: 'remote',
        country: 'Netherlands',
        remoteFromGermany: 'true',
        employer: 'Example',
        employmentType: 'full-time',
        minSalary: '70000',
        seniority: 'senior',
      }),
      '  LLM engineer  ',
      2,
    );
    expect(params.get('q')).toBe('LLM engineer');
    expect(params.get('category')).toBe('ai');
    expect(params.get('profileKind')).toBe('ai_engineer');
    expect(params.get('locationScope')).toBe('outside_germany_remote');
    expect(params.get('workArrangement')).toBe('remote');
    expect(params.get('country')).toBe('Netherlands');
    expect(params.get('remoteEligibleFromGermany')).toBe('true');
    expect(params.get('employer')).toBe('Example');
    expect(params.get('employmentType')).toBe('full-time');
    expect(params.get('minSalary')).toBe('70000');
    expect(params.get('seniority')).toBe('senior');
    expect(params.get('page')).toBe('2');
  });

  it('maps match-score bands, saved, review, application and letter state together', () => {
    const params = buildJobListQuery(
      filters({
        scoreBand: '80-89',
        savedOnly: true,
        reviewFilter: 'unreviewed',
        appliedFilter: 'applied',
        letterFilter: 'no',
      }),
      '',
      1,
    );
    expect(params.get('minScore')).toBe('80');
    expect(params.get('maxScore')).toBe('89');
    expect(params.get('saved')).toBe('true');
    expect(params.get('reviewed')).toBe('false');
    expect(params.get('applied')).toBe('true');
    expect(params.get('hasCoverLetter')).toBe('false');
    expect(jobScoreRange('below-70')).toEqual({ max: '69' });
    expect(jobScoreRange('90-100')).toEqual({ min: '90', max: '100' });
  });

  it('sends no application filter by default and narrows on request', () => {
    expect(buildJobListQuery(DEFAULT_JOB_FILTERS, '', 1).get('applied')).toBeNull();
    expect(buildJobListQuery(filters({ appliedFilter: 'not_applied' }), '', 1).get('applied')).toBe(
      'false',
    );
  });

  it('maps relative and custom posting-date ranges', () => {
    // "Any date" is the absence of a window; the backend three-month cap still applies.
    expect(buildJobListQuery(filters({ postedWindow: '' }), '', 1).get('postedWithinDays')).toBeNull();
    expect(
      buildJobListQuery(filters({ postedWindow: '3' }), '', 1).get('postedWithinDays'),
    ).toBe('3');

    const recent = buildJobListQuery(filters({ postedWindow: '7' }), '', 1);
    expect(recent.get('postedWithinDays')).toBe('7');
    expect(buildJobListQuery(filters({ postedWindow: '30' }), '', 1).get('postedWithinDays')).toBe(
      '30',
    );

    const custom = buildJobListQuery(
      filters({ postedWindow: 'custom', postedFrom: '2026-09-01', postedTo: '2026-10-01' }),
      '',
      1,
    );
    expect(custom.get('postedAfter')).toBe('2026-09-01');
    expect(custom.get('postedBefore')).toBe('2026-10-01');
    expect(custom.get('postedWithinDays')).toBeNull();

    // The three-month option is the backend's default window, not a 90-day count.
    const threeMonths = buildJobListQuery(filters({ postedWindow: '3m' }), '', 1);
    expect(threeMonths.get('postedWithinDays')).toBeNull();
    expect(threeMonths.get('postedAfter')).toBeNull();
  });

  it('switches the unknown-date review view and the German-requirement opt-out', () => {
    const review = buildJobListQuery(
      filters({ dateEvidence: 'needs_review', languageFilter: 'all' }),
      '',
      1,
    );
    expect(review.get('ageEligibility')).toBe('Unknown');
    expect(review.get('excludeGermanRequired')).toBe('false');

    expect(
      buildJobListQuery(filters({ languageFilter: 'review' }), '', 1).get('languageDecision'),
    ).toBe('Needs Review');
    expect(
      buildJobListQuery(filters({ languageFilter: 'optional' }), '', 1).get('germanOptional'),
    ).toBe('true');
  });

  it('maps all four sort options', () => {
    for (const sort of ['newest', 'oldest', 'score', 'company', 'title'] as const) {
      expect(buildJobListQuery(filters({ sort }), '', 1).get('sort')).toBe(sort);
    }
  });
});

describe('PhD list query builder', () => {
  it('defaults to verified-open positions sorted by newest', () => {
    const params = buildPhdListQuery(phd());
    expect(params.get('deadlineStatus')).toBeNull();
    expect(params.get('sort')).toBe('newest');
    expect(params.get('page')).toBe('1');
    expect(params.get('limit')).toBe('20');
  });

  it('combines research area, institution, country, topic and deadline filters', () => {
    const params = buildPhdListQuery(
      phd({
        search: 'Berlin',
        topic: 'knowledge graph',
        researchArea: 'cybersecurity',
        institution: 'Example University',
        country: 'Germany',
        deadlineGroup: 'unknown',
        deadlineWindow: '30',
      }),
    );
    expect(params.get('q')).toBe('Berlin');
    expect(params.get('topic')).toBe('knowledge graph');
    expect(params.get('researchArea')).toBe('cybersecurity');
    expect(params.get('institution')).toBe('Example University');
    expect(params.get('country')).toBe('Germany');
    expect(params.get('deadlineStatus')).toBe('unknown');
    expect(params.get('deadlineWithinDays')).toBe('30');
  });

  it('leaves the work arrangement open unless one is requested', () => {
    expect(buildPhdListQuery(phd()).get('workArrangement')).toBeNull();
    expect(buildPhdListQuery(phd({ arrangement: 'onsite' })).get('workArrangement')).toBe('onsite');
    expect(buildPhdListQuery(phd({ arrangement: 'hybrid' })).get('workArrangement')).toBe('hybrid');
  });

  it('maps funding, language, score, saved, review and letter filters', () => {
    const params = buildPhdListQuery(
      phd({
        funded: 'true',
        language: 'Eligible',
        scoreBand: '60-79',
        savedOnly: true,
        unreviewedOnly: true,
        letterFilter: 'true',
      }),
    );
    expect(params.get('funded')).toBe('true');
    expect(params.get('languageDecision')).toBe('Eligible');
    expect(params.get('minScore')).toBe('60');
    expect(params.get('maxScore')).toBe('79');
    expect(params.get('saved')).toBe('true');
    expect(params.get('reviewed')).toBe('false');
    expect(params.get('hasCoverLetter')).toBe('true');

    expect(buildPhdListQuery(phd({ scoreBand: 'below-60' })).get('maxScore')).toBe('59');
    expect(buildPhdListQuery(phd({ scoreBand: '80-100' })).get('minScore')).toBe('80');
  });

  it('maps deadline and institution sorting', () => {
    for (const sort of ['deadline', 'score', 'institution', 'newest', 'oldest', 'title'] as const) {
      expect(buildPhdListQuery(phd({ sort })).get('sort')).toBe(sort);
    }
  });
});
