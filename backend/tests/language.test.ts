import { describe, expect, it } from 'vitest';
import { classifyLanguage } from '../src/services/jobs/language.js';
import { normalizeListing } from '../src/services/jobs/normalize.js';

function classify(description: string, title = 'Senior Software Engineer') {
  return classifyLanguage({ title, location: 'Berlin, Germany', description });
}

describe('English-first language classification', () => {
  it('marks an English-required, non-German job as Eligible', () => {
    const result = classify(
      'You will build services with TypeScript. English is required and is the working language of the team.',
    );
    expect(result.languageDecision).toBe('Eligible');
    expect(result.englishRequired).toBe(true);
    expect(result.germanRequired).not.toBe(true);
    expect(result.languageEvidence.toLowerCase()).toContain('english');
    expect(result.languageConfidence).toBeGreaterThan(60);
  });

  it('marks German as optional/preferred as Eligible', () => {
    const result = classify(
      'Our engineering team works in English. German is a plus but not required for this role.',
    );
    expect(result.languageDecision).toBe('Eligible');
    expect(result.germanRequired).not.toBe(true);
    expect(result.languageReason.toLowerCase()).toMatch(/optional|not required/);
  });

  it('excludes a job requiring B2 German', () => {
    const result = classify(
      'Für diese Position sind Deutschkenntnisse auf B2-Niveau erforderlich. Sie arbeiten mit Kunden.',
    );
    expect(result.germanRequired).toBe(true);
    expect(result.languageDecision).toBe('Excluded');
    expect(result.languageEvidence.toLowerCase()).toMatch(/deutsch|b2/);
    expect(result.languageConfidence).toBeGreaterThanOrEqual(90);
  });

  it('marks an ambiguous language requirement as Needs Review', () => {
    const result = classify(
      'Join our international team in Berlin. We work with modern technologies and value communication.',
    );
    expect(result.languageDecision).toBe('Needs Review');
    expect(result.germanRequired).toBeNull();
    expect(result.languageConfidence).toBeLessThanOrEqual(55);
  });

  it('keeps "German is not required" explicitly eligible', () => {
    const result = classify(
      'English is our working language. German is not required for this position.',
    );
    expect(result.languageDecision).toBe('Eligible');
    expect(result.germanRequired).toBe(false);
    expect(result.languageRequirement).toBe('german_not_required');
  });

  it('does not let an unrelated "English is not required" negate a mandatory German clause', () => {
    const result = classify(
      'Sehr gute Deutschkenntnisse sind zwingend erforderlich. Englisch ist nicht erforderlich.',
    );
    expect(result.germanRequired).toBe(true);
    expect(result.languageDecision).toBe('Excluded');
  });

  it('flags another mandatory language for review', () => {
    const result = classify(
      'Vous travaillerez avec nos clients. French is required and fluent French is mandatory.',
    );
    expect(result.languageDecision).toBe('Needs Review');
    expect(result.languageReason).toMatch(/another mandatory language/i);
  });

  it('carries the classification into the normalized listing', () => {
    const listing = normalizeListing({
      source: 'test',
      sourceJobId: 'language-1',
      sourceLabel: 'Test',
      url: 'https://example.com/language-1',
      applicationUrl: '',
      employer: 'Example',
      title: 'Senior Software Engineer',
      location: 'Berlin',
      remote: false,
      employmentType: '',
      salary: '',
      tags: [],
      description: 'English is our working language. German is optional.',
      postedAt: new Date(),
      expiresAt: null,
    });
    expect(listing.languageDecision).toBe('Eligible');
    expect(listing.germanOptional).toBe(true);
    expect(listing.jobLanguage).toBe('Mixed');
  });
});
