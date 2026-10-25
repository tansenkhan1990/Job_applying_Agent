import { describe, expect, it } from 'vitest';
import { CandidateProfileModel } from '../src/models/CandidateProfile.js';
import { JobModel } from '../src/models/Job.js';
import { mockAdapter } from '../src/services/jobs/adapters/mock.js';
import { generateCoverLetter } from '../src/services/coverLetters/generate.js';
import { renderLetterDocx, renderLetterPdf } from '../src/services/coverLetters/render.js';
import { normalizeListing } from '../src/services/jobs/normalize.js';
import { ensureDefaultProfiles } from '../src/services/profilesService.js';
import { seedApprovedProfiles, seedJob } from './helpers.js';
import type { JobSearchCriteria } from '../src/services/jobs/types.js';

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
  freshnessDays: 30,
  maxJobs: 20,
};

describe('cover letter generation', () => {
  it('produces a grounded template letter when AI is not configured', async () => {
    await seedApprovedProfiles();
    const profile = await CandidateProfileModel.findOne({ kind: 'full_stack' });
    const sample = (await mockAdapter.searchJobs(criteria)).find(
      (item) => item.sourceJobId === 'mock-fullstack-senior',
    )!;
    const job = await seedJob(sample, { fingerprint: 'test-fingerprint' });

    const letter = await generateCoverLetter({ job, profile: profile!, match: null });
    expect(letter.source).toBe('template');
    expect(letter.letterText).toContain('Dear Hiring Manager');
    expect(letter.letterText.length).toBeGreaterThan(120);
    expect(letter.letterText).not.toMatch(/\[(company|role|your name)\]/i);
    expect(letter.grounding.unsupportedNumbers).toEqual([]);
    expect(letter.uncertainties.join(' ')).toMatch(/template/i);
  });

  it('does not use a fabricated name when the profile has none', async () => {
    await ensureDefaultProfiles();
    const profile = await CandidateProfileModel.findOne({ kind: 'full_stack' });
    const sample = (await mockAdapter.searchJobs(criteria)).find(
      (item) => item.sourceJobId === 'mock-fullstack-senior',
    )!;
    const job = await seedJob(sample, { fingerprint: 'test-fingerprint-2' });

    const letter = await generateCoverLetter({ job, profile: profile!, match: null });
    expect(letter.letterText).not.toMatch(/Jane|John|\[/);
    expect(letter.subjectLine).toContain(job.title);
  });
});

describe('cover letter rendering', () => {
  it('renders a PDF with a valid header', async () => {
    const buffer = await renderLetterPdf({
      subjectLine: 'Application for Engineer',
      letterText: 'Dear Hiring Manager,\n\nI am applying.\n\nSincerely,\nJane',
      candidateName: 'Jane Example',
    });
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(500);
  });

  it('renders a DOCX (zip) file', async () => {
    const buffer = await renderLetterDocx({
      subjectLine: 'Application for Engineer',
      letterText: 'Dear Hiring Manager,\n\nI am applying.',
    });
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    expect(buffer.length).toBeGreaterThan(500);
  });
});
