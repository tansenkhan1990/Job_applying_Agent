import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { ApplicationModel } from '../src/models/Application.js';
import { JobModel } from '../src/models/Job.js';
import { CandidateProfileModel } from '../src/models/CandidateProfile.js';
import { mockAdapter } from '../src/services/jobs/adapters/mock.js';
import { updateSettings } from '../src/services/settingsService.js';
import { jobFingerprint } from '../src/services/jobs/normalize.js';
import { seedApprovedProfiles, seedJob } from './helpers.js';
import type { JobSearchCriteria } from '../src/services/jobs/types.js';

const app = createApp();
const criteria: JobSearchCriteria = {
  countries: ['Germany'],
  remoteScope: ['Germany', 'European Union'],
  languages: ['English'],
  workArrangements: ['remote', 'hybrid', 'onsite'],
  seniority: ['mid', 'senior'],
  targetTitles: ['Full Stack Developer', 'AI Engineer', 'DevOps Engineer'],
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

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
const runnerHeaders = { 'x-runner-token': 'test-runner-token', 'x-runner-id': 'test-runner' };

async function seedJobVariant(options: {
  sourceJobId: string;
  postedAt: Date | null;
  daysOldSource?: string;
}) {
  await seedApprovedProfiles();
  await updateSettings({ application: { minScoreToPrepare: 0 } });
  const listings = await mockAdapter.searchJobs(criteria);
  const sample = listings.find((item) => item.sourceJobId === options.sourceJobId)!;
  return seedJob(
    {
      ...sample,
      sourceJobId: `${options.sourceJobId}-${Math.random().toString(36).slice(2, 8)}`,
      postedAt: options.postedAt,
      expiresAt: null,
    },
    {
      fingerprint: jobFingerprint(sample.employer, sample.title, `${sample.location}-${Math.random()}`),
    },
  );
}

async function prepareOldJob() {
  const job = await seedJobVariant({
    sourceJobId: 'mock-fullstack-senior',
    postedAt: daysAgo(120),
  });
  const profile = await CandidateProfileModel.findOne({ kind: 'full_stack' });
  const prepared = await request(app)
    .post('/api/applications/prepare')
    .send({ jobId: String(job._id), profileId: String(profile?._id) });
  expect(prepared.status).toBe(201);
  return { job, applicationId: prepared.body.application.id as string };
}

describe('posting-age eligibility and supervised assistant', () => {
  it('stores snapshots and exposes an eligible application in the queue', async () => {
    const { job, applicationId } = await prepareOldJob();
    const stored = await ApplicationModel.findById(applicationId);
    expect(stored?.ageEligibility).toBe('Eligible');
    expect(stored?.postedAt?.toISOString().slice(0, 10)).toBe(job.postedAt?.toISOString().slice(0, 10));
    expect(stored?.eligibleAfter).toBeInstanceOf(Date);
    expect(stored?.ageReason).toMatch(/calendar months/);
    expect(stored?.preparationStartedAt).toBeInstanceOf(Date);
    const storedJob = await JobModel.findById(job._id);
    expect(storedJob?.ageEligibility).toBe('Eligible');
    expect(storedJob?.ageCheckAt).toBeInstanceOf(Date);
    expect(stored?.jobDescriptionSnapshot.length).toBeGreaterThan(20);
    expect(stored?.languageSnapshot.languageDecision).toBe('Eligible');
    expect(stored?.workflow?.status).toBe('READY_TO_APPLY');

    const queue = await request(app).get('/api/applications/queue?limit=50');
    expect(queue.status).toBe(200);
    expect(queue.body.items.map((item: { id: string }) => item.id)).toContain(applicationId);
  });

  it('filters the tracker by job title, language and posting-date range', async () => {
    const { applicationId } = await prepareOldJob();
    const listings = await mockAdapter.searchJobs(criteria);
    const aiSample = listings.find((item) => item.sourceJobId === 'mock-ai-engineer-rag')!;
    const olderJob = await seedJob(
      {
        ...aiSample,
        sourceJobId: `ai-${Math.random().toString(36).slice(2, 8)}`,
        postedAt: daysAgo(200),
        expiresAt: null,
      },
      { fingerprint: jobFingerprint(aiSample.employer, aiSample.title, `ai-${Math.random()}`) },
    );
    const aiProfile = await CandidateProfileModel.findOne({ kind: 'ai_engineer' });
    const older = await request(app)
      .post('/api/applications/prepare')
      .send({ jobId: String(olderJob._id), profileId: String(aiProfile?._id) });
    expect(older.status).toBe(201);
    const olderId = older.body.application.id as string;

    const byTitle = await request(app).get('/api/applications?jobTitle=AI%20Engineer');
    expect(byTitle.status).toBe(200);
    const titleIds = byTitle.body.items.map((item: { id: string }) => item.id);
    expect(titleIds).toContain(olderId);
    expect(titleIds).not.toContain(applicationId);

    const byLanguage = await request(app).get('/api/applications?languageDecision=Eligible');
    const languageIds = byLanguage.body.items.map((item: { id: string }) => item.id);
    expect(languageIds).toContain(olderId);
    expect(languageIds).toContain(applicationId);

    const cutoff = daysAgo(150).toISOString().slice(0, 10);
    const byPosted = await request(app).get(`/api/applications?from=${cutoff}`);
    const postedIds = byPosted.body.items.map((item: { id: string }) => item.id);
    expect(postedIds).toContain(applicationId);
    expect(postedIds).not.toContain(olderId);
  });

  it('keeps too-recent applications out of the queue and blocks the assistant', async () => {
    const job = await seedJobVariant({
      sourceJobId: 'mock-fullstack-senior',
      postedAt: daysAgo(20),
    });
    const profile = await CandidateProfileModel.findOne({ kind: 'full_stack' });
    const prepared = await request(app)
      .post('/api/applications/prepare')
      .send({ jobId: String(job._id), profileId: String(profile?._id) });
    expect(prepared.status).toBe(201);
    const id = prepared.body.application.id;
    expect(prepared.body.application.workflow.status).toBe('TOO_RECENT');

    const queue = await request(app).get('/api/applications/queue?limit=50');
    expect(queue.body.items.map((item: { id: string }) => item.id)).not.toContain(id);

    const started = await request(app).post(`/api/applications/${id}/assistant/start`).send({});
    expect(started.status).toBe(409);
    expect(
      started.body.error.details.blockers.some(
        (blocker: { code: string }) => blocker.code === 'AGE_TOO_RECENT',
      ),
    ).toBe(true);
  });

  it('blocks jobs with an unknown posting date', async () => {
    const job = await seedJobVariant({ sourceJobId: 'mock-fullstack-senior', postedAt: null });
    const profile = await CandidateProfileModel.findOne({ kind: 'full_stack' });
    const prepared = await request(app)
      .post('/api/applications/prepare')
      .send({ jobId: String(job._id), profileId: String(profile?._id) });
    expect(prepared.status).toBe(201);
    expect(prepared.body.application.workflow.status).toBe('NEEDS_REVIEW');
    expect(prepared.body.application.ageEligibility).toBe('Unknown');

    const started = await request(app)
      .post(`/api/applications/${prepared.body.application.id}/assistant/start`)
      .send({});
    expect(started.status).toBe(409);
    expect(
      started.body.error.details.blockers.some(
        (blocker: { code: string }) => blocker.code === 'AGE_UNKNOWN',
      ),
    ).toBe(true);
  });

  it('blocks German-mandatory jobs', async () => {
    const job = await seedJobVariant({
      sourceJobId: 'mock-backend-german',
      postedAt: daysAgo(120),
    });
    const profile = await CandidateProfileModel.findOne({ kind: 'full_stack' });
    const prepared = await request(app)
      .post('/api/applications/prepare')
      .send({ jobId: String(job._id), profileId: String(profile?._id) });
    expect(prepared.status).toBe(201);
    const id = prepared.body.application.id;
    expect(prepared.body.application.workflow.status).toBe('LANGUAGE_REVIEW');

    const started = await request(app).post(`/api/applications/${id}/assistant/start`).send({});
    expect(started.status).toBe(409);
    expect(
      started.body.error.details.blockers.some(
        (blocker: { code: string }) => blocker.code === 'LANGUAGE_EXCLUDED',
      ),
    ).toBe(true);
  });

  it('queues a session, records a filled form for review, and never marks it submitted automatically', async () => {
    const { applicationId } = await prepareOldJob();

    const started = await request(app)
      .post(`/api/applications/${applicationId}/assistant/start`)
      .send({});
    expect(started.status).toBe(202);
    expect(started.body.application.workflow.status).toBe('READY_TO_APPLY');
    expect(started.body.application.workflow.startRequestedAt).toBeTruthy();

    const claimed = await request(app).get('/api/automation/next').set(runnerHeaders);
    expect(claimed.status).toBe(200);
    expect(claimed.body.applicationId).toBe(applicationId);
    expect(claimed.body.files.cv).toContain('/files/cv');

    const progress = await request(app)
      .post(`/api/automation/applications/${applicationId}/progress`)
      .set(runnerHeaders)
      .send({
        runnerId: 'test-runner',
        status: 'AWAITING_REVIEW',
        fieldsDetected: 12,
        fieldsFilled: 7,
        filesUploaded: 2,
        unanswered: ['Salary expectation'],
        reviewFields: [
          { label: 'Salary expectation', reason: 'Sensitive question', fieldType: 'text' },
        ],
        message: 'Application form filled — please review before submitting.',
      });
    expect(progress.status).toBe(200);

    const afterFill = await ApplicationModel.findById(applicationId);
    expect(afterFill?.workflow?.status).toBe('AWAITING_REVIEW');
    expect(afterFill?.workflow?.fieldsFilled).toBe(7);
    expect(afterFill?.status).not.toBe('SUBMITTED');
    expect(afterFill?.appliedAt ?? null).toBeNull();

    const missingEvidence = await request(app)
      .post(`/api/applications/${applicationId}/confirm-outcome`)
      .send({ confirmed: true, outcome: 'submitted' });
    expect(missingEvidence.status).toBe(400);

    const confirmed = await request(app)
      .post(`/api/applications/${applicationId}/confirm-outcome`)
      .send({
        confirmed: true,
        outcome: 'submitted',
        evidence: 'Confirmation page: application received, reference 42.',
        confirmationId: '42',
      });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('SUBMITTED');
    expect(confirmed.body.appliedAt).toBeTruthy();
    expect(confirmed.body.workflow.status).toBe('SUBMITTED');
    expect(confirmed.body.submission.confirmed).toBe(true);

    const again = await request(app)
      .post(`/api/applications/${applicationId}/confirm-outcome`)
      .send({
        confirmed: true,
        outcome: 'submitted',
        evidence: 'Duplicate confirmation attempt.',
      });
    expect(again.status).toBe(409);
  });

  it('serves the selected CV and tailored cover letter only to the runner token', async () => {
    const { applicationId } = await prepareOldJob();
    await request(app).post(`/api/applications/${applicationId}/assistant/start`).send({});

    const forbidden = await request(app).get(
      `/api/automation/applications/${applicationId}/files/cover-letter`,
    );
    expect(forbidden.status).toBe(401);

    const letter = await request(app)
      .get(`/api/automation/applications/${applicationId}/files/cover-letter`)
      .set(runnerHeaders);
    expect(letter.status).toBe(200);
    expect(letter.headers['content-type']).toContain('application/pdf');

    // The metadata must name the exact PDF the runner uploads, not a different source file.
    const detail = await request(app).get(`/api/applications/${applicationId}`);
    expect(detail.body.selectedCoverLetterFilename).toMatch(/-cover-letter\.pdf$/);
    expect(String(letter.headers['content-disposition'])).toContain(
      detail.body.selectedCoverLetterFilename,
    );
  });
});
