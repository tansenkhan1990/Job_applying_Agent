import { describe, expect, it } from 'vitest';
import { CandidateProfileModel } from '../src/models/CandidateProfile.js';
import { JobModel } from '../src/models/Job.js';
import { JobMatchModel } from '../src/models/JobMatch.js';
import { mockAdapter } from '../src/services/jobs/adapters/mock.js';
import { normalizeListing } from '../src/services/jobs/normalize.js';
import { assessDeterministically } from '../src/services/matching/deterministic.js';
import { matchJob } from '../src/services/matching/index.js';
import { aiMatchEvaluationSchema, coverLetterSchema, profileExtractionSchema } from '../src/services/ai/schemas.js';
import { checkGrounding } from '../src/services/coverLetters/grounding.js';
import { jobFingerprint } from '../src/services/jobs/normalize.js';
import { ensureDefaultProfiles } from '../src/services/profilesService.js';
import { seedApprovedProfiles, seedJob, CV_TEXT } from './helpers.js';
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

const matchCriteria = {
  seniority: ['mid', 'senior'] as Array<'mid' | 'senior'>,
  countries: ['Germany'],
  remoteScope: ['Germany', 'European Union'],
};

describe('deterministic scoring', () => {
  it('scores a strong full-stack match highly and explains the evidence', async () => {
    await ensureDefaultProfiles();
    await CandidateProfileModel.updateOne(
      { kind: 'full_stack' },
      { $set: { yearsExperience: 7, languages: [{ language: 'German', level: 'B2' }] } },
    );
    const profile = await CandidateProfileModel.findOne({ kind: 'full_stack' });
    const sample = (await mockAdapter.searchJobs(criteria)).find(
      (item) => item.sourceJobId === 'mock-fullstack-senior',
    )!;
    const job = normalizeListing(sample);
    const assessment = assessDeterministically(job, profile!, matchCriteria);

    expect(assessment.score).toBeGreaterThanOrEqual(80);
    expect(assessment.matchedSkills).toEqual(
      expect.arrayContaining(['TypeScript', 'React', 'Node.js', 'PostgreSQL']),
    );
    expect(assessment.explanation).toMatch(/Rule-based assessment/);
    expect(assessment.requirements.some((requirement) => requirement.label === 'Location')).toBe(true);
  });

  it('caps a German-mandatory role when the profile lists no German', async () => {
    await ensureDefaultProfiles();
    await CandidateProfileModel.updateOne(
      { kind: 'full_stack' },
      { $set: { languages: [{ language: 'English', level: 'C2' }] } },
    );
    const profile = await CandidateProfileModel.findOne({ kind: 'full_stack' });
    const sample = (await mockAdapter.searchJobs(criteria)).find(
      (item) => item.sourceJobId === 'mock-backend-german',
    );
    const job = normalizeListing({
      ...sample!,
      title: 'Senior Full Stack Engineer',
      tags: ['TypeScript', 'React', 'Node.js'],
      description: `${sample!.description} TypeScript, React and Node.js.`,
    });
    const assessment = assessDeterministically(job, profile!, matchCriteria);
    expect(assessment.languageRequirement).toBe('german_required');
    expect(assessment.requirements.find((item) => item.label === 'German language')?.status).toBe('missing');
    expect(assessment.score).toBeLessThanOrEqual(45);
  });

  it('marks unverified work authorization as a manual-review requirement', async () => {
    await ensureDefaultProfiles();
    const profile = await CandidateProfileModel.findOne({ kind: 'full_stack' });
    const job = normalizeListing({
      source: 'test',
      sourceJobId: 'req-1',
      sourceLabel: 'Test',
      url: 'https://example.com/1',
      applicationUrl: '',
      employer: 'Example',
      title: 'Full Stack Developer',
      location: 'Berlin',
      remote: false,
      employmentType: '',
      salary: '',
      tags: [],
      description: 'TypeScript and React. You must be legally authorized to work in the EU.',
      postedAt: new Date(),
      expiresAt: null,
    });
    const assessment = assessDeterministically(job, profile!, matchCriteria);
    expect(assessment.mandatoryUnknown.join(' ')).toMatch(/work authorization/i);
    expect(assessment.reviewRequired).toBe(true);
  });
});

describe('AI response validation', () => {
  it('accepts a valid match evaluation and rejects out-of-range or missing fields', () => {
    const valid = {
      score: 82,
      matchedSkills: ['TypeScript'],
      missingSkills: [],
      strengths: ['Relevant experience'],
      concerns: [],
      explanation: 'The CV shows TypeScript and React work in comparable roles.',
      mandatoryRequirementsMet: true,
      mandatoryUnknown: [],
      languageAssessment: { requiredLanguage: 'English', mandatory: false, candidateMeets: 'yes' },
      recommendedProfileKind: 'full_stack',
      promptInjectionDetected: false,
    };
    expect(aiMatchEvaluationSchema.safeParse(valid).success).toBe(true);
    expect(aiMatchEvaluationSchema.safeParse({ ...valid, score: 120 }).success).toBe(false);
    expect(aiMatchEvaluationSchema.safeParse({ ...valid, score: 'high' }).success).toBe(false);
    expect(
      aiMatchEvaluationSchema.safeParse({ ...valid, recommendedProfileKind: 'sales' }).success,
    ).toBe(false);
  });

  it('applies safe defaults for optional profile extraction fields', () => {
    const parsed = profileExtractionSchema.parse({
      name: 'Jane',
      skills: ['TypeScript'],
      experienceSummary: 'Engineer',
      yearsExperience: 6,
    });
    expect(parsed.experience).toEqual([]);
    expect(parsed.languages).toEqual([]);
    expect(parsed.certifications).toEqual([]);
  });

  it('rejects placeholder-only or too-short letters', () => {
    expect(coverLetterSchema.safeParse({ letterText: 'too short' }).success).toBe(false);
    expect(
      coverLetterSchema.safeParse({
        letterText: 'x'.repeat(200),
        subjectLine: 'Application',
      }).success,
    ).toBe(true);
  });
});

describe('cover letter grounding', () => {
  it('passes when technologies and numbers come from the verified sources', () => {
    const result = checkGrounding({
      letterText: `Dear Hiring Manager,\n\nI build TypeScript and React applications with Node.js. In my current role I worked with PostgreSQL and Docker for over 4 years.\n\nSincerely,\nJane Example`,
      subjectLine: 'Application for Full Stack Engineer',
      sources: [CV_TEXT],
    });
    expect(result.unsupportedTerms).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('flags invented technologies and metrics', () => {
    const result = checkGrounding({
      letterText: `Dear Hiring Manager,\n\nI have 12 years of experience with Rust and Kubernetes, improving throughput by 45%.\n\nSincerely,\nJane`,
      subjectLine: 'Application',
      sources: [CV_TEXT],
    });
    expect(result.unsupportedTerms).toEqual(expect.arrayContaining(['rust', 'kubernetes']));
    expect(result.unsupportedNumbers.join(' ')).toMatch(/45%/);
    expect(result.passed).toBe(false);
  });

  it('flags unresolved placeholders', () => {
    const result = checkGrounding({
      letterText: `Dear [Hiring Manager],\n\nI am excited to apply to [Company] for this role. My background includes TypeScript and React, which I have used extensively in professional work.\n\nSincerely,`,
      sources: [CV_TEXT],
    });
    expect(result.passed).toBe(false);
  });
});

describe('match persistence', () => {
  it('persists profile-specific matches with deterministic metadata when no AI key is set', async () => {
    await seedApprovedProfiles();
    const sample = (await mockAdapter.searchJobs(criteria)).find(
      (item) => item.sourceJobId === 'mock-fullstack-senior',
    )!;
    const fingerprint = jobFingerprint(sample.employer, sample.title, sample.location);
    const job = await seedJob(sample, { fingerprint });

    const matches = await matchJob(String(job._id));
    expect(matches.length).toBe(3);
    const fullStack = matches.find((match) => match.profileKind === 'full_stack');
    expect(fullStack?.evaluationSource).toBe('deterministic');
    expect(fullStack?.model).toBe('deterministic');
    expect(fullStack?.promptVersion).toBe('deterministic-v1');
    expect(fullStack?.score).toBeGreaterThan(50);
    expect(await JobMatchModel.countDocuments({})).toBe(3);

    await matchJob(String(job._id));
    expect(await JobMatchModel.countDocuments({})).toBe(3);
  });
});
