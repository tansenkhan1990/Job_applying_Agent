import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { JobModel } from '../src/models/Job.js';
import { ApplicationModel } from '../src/models/Application.js';
import { CandidateProfileModel } from '../src/models/CandidateProfile.js';
import { DocumentModel } from '../src/models/Document.js';
import { JobMatchModel } from '../src/models/JobMatch.js';
import { runDiscovery } from '../src/services/jobs/discovery.js';
import { duplicateKeyFor } from '../src/services/applications/service.js';
import { ensureDefaultProfiles } from '../src/services/profilesService.js';
import { seedApprovedProfiles, seedPendingProfile } from './helpers.js';
import { jobFingerprint } from '../src/services/jobs/normalize.js';
import { sha256 } from '../src/utils/hash.js';

const app = createApp();

async function seedMockJobs() {
  await seedApprovedProfiles();
  await CandidateProfileModel.updateMany(
    {},
    {
      $set: {
        yearsExperience: 7,
        languages: [
          { language: 'English', level: 'C2' },
          { language: 'German', level: 'B2' },
        ],
      },
    },
  );
  await runDiscovery({ trigger: 'manual', overrides: { sources: ['mock'] } });
  const fullStackJob = await JobModel.findOne({ sourceJobId: 'mock-fullstack-senior' });
  const aiJob = await JobModel.findOne({ sourceJobId: 'mock-ai-engineer-rag' });
  const platformJob = await JobModel.findOne({ sourceJobId: 'mock-platform-engineer' });
  const fullStackProfile = await CandidateProfileModel.findOne({ kind: 'full_stack' });
  const aiProfile = await CandidateProfileModel.findOne({ kind: 'ai_engineer' });
  const devopsProfile = await CandidateProfileModel.findOne({ kind: 'devops_cloud' });
  return {
    fullStackJob: fullStackJob!,
    aiJob: aiJob!,
    platformJob: platformJob!,
    fullStackProfile: fullStackProfile!,
    aiProfile: aiProfile!,
    devopsProfile: devopsProfile!,
  };
}

describe('health and validation', () => {
  it('reports MongoDB and documents health', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.checks.mongodb.ok).toBe(true);
    expect(response.body.checks.documents.readable).toBe(true);
    expect(response.body.checks.ai.configured).toBe(false);
  });

  it('rejects invalid request bodies with a consistent error envelope', async () => {
    const response = await request(app).post('/api/applications/prepare').send({});
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(response.body.error.details)).toBe(true);
  });

  it('rejects malformed JSON bodies', async () => {
    const response = await request(app)
      .post('/api/applications/prepare')
      .set('Content-Type', 'application/json')
      .send('{not-json');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  it('serves seeded career profiles', async () => {
    await ensureDefaultProfiles();
    const response = await request(app).get('/api/profiles');
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(3);
    expect(response.body.map((profile: { kind: string }) => profile.kind).sort()).toEqual([
      'ai_engineer',
      'devops_cloud',
      'full_stack',
    ]);
  });
});

describe('application workflow', () => {
  it('refuses to prepare an application with an unapproved profile', async () => {
    const { profile } = await seedPendingProfile('ai_engineer');
    const sample = await runDiscovery({ trigger: 'manual', overrides: { sources: ['mock'] } });
    expect(sample.status).toBe('completed');
    const job = await JobModel.findOne({ sourceJobId: 'mock-ai-engineer-rag' });

    const response = await request(app)
      .post('/api/applications/prepare')
      .send({ jobId: String(job?._id), profileId: String(profile?._id) });
    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/approved/i);
  });

  it('enforces approval, blocks duplicate submissions and exports history', async () => {
    const { fullStackJob, fullStackProfile } = await seedMockJobs();

    const prepared = await request(app)
      .post('/api/applications/prepare')
      .send({ jobId: String(fullStackJob._id), profileId: String(fullStackProfile._id) });
    expect(prepared.status).toBe(201);
    const applicationId = prepared.body.application.id;
    expect(prepared.body.application.status).toBe('READY_FOR_REVIEW');
    // Populated nested documents must also expose `id` and drop `_id`.
    expect(prepared.body.application.job.id).toBe(String(fullStackJob._id));
    expect(prepared.body.application.profile.id).toBe(String(fullStackProfile._id));
    expect(prepared.body.application.job._id).toBeUndefined();
    expect(prepared.body.application.profile._id).toBeUndefined();
    expect(prepared.body.application.screeningQuestions.length).toBeGreaterThan(0);

    // No approval yet.
    const blocked = await request(app).post(`/api/applications/${applicationId}/submit`).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/approval/i);

    // Approval is rejected while a mandatory question is unanswered.
    const incomplete = await request(app)
      .post(`/api/applications/${applicationId}/approve`)
      .send({ confirmed: true });
    expect(incomplete.status).toBe(409);
    expect(incomplete.body.error.details.unanswered.length).toBeGreaterThan(0);

    const question = incomplete.body.error.details.unanswered[0];
    const answered = await request(app)
      .post(`/api/applications/${applicationId}/questions/answer`)
      .send({ questionId: question.questionId, answer: '7' });
    expect(answered.status).toBe(200);
    expect(answered.body.version).toBe(2);

    const approved = await request(app)
      .post(`/api/applications/${applicationId}/approve`)
      .send({ confirmed: true });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('APPROVED');
    expect(approved.body.approval.applicationVersion).toBe(2);
    expect(approved.body.approval.approvedAt).toBeTruthy();

    const submitted = await request(app)
      .post(`/api/applications/${applicationId}/submit`)
      .send({ confirmed: true });
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe('SUBMITTED');
    expect(submitted.body.submission.confirmed).toBe(true);
    expect(submitted.body.submission.simulated).toBe(true);
    expect(submitted.body.submission.attempts).toBe(1);
    // The applied job is stored permanently with the date it was submitted.
    expect(submitted.body.appliedAt).toBeTruthy();

    const listed = await request(app).get('/api/jobs?limit=50');
    const listedJob = listed.body.items.find(
      (item: { id: string }) => item.id === String(fullStackJob._id),
    );
    expect(listedJob.application.status).toBe('SUBMITTED');

    const again = await request(app)
      .post(`/api/applications/${applicationId}/submit`)
      .send({ confirmed: true });
    expect(again.status).toBe(409);

    const reprepare = await request(app)
      .post('/api/applications/prepare')
      .send({ jobId: String(fullStackJob._id), profileId: String(fullStackProfile._id) });
    expect(reprepare.status).toBe(409);

    const csv = await request(app).get('/api/applications/export.csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('SUBMITTED');
    expect(csv.text).toContain('Example Commerce GmbH');

    const count = await ApplicationModel.countDocuments({});
    expect(count).toBe(1);
  });

  it('prefers an approved profile when the highest-scoring match is still draft', async () => {
    const { fullStackJob, devopsProfile } = await seedMockJobs();
    await CandidateProfileModel.updateOne(
      { _id: devopsProfile._id },
      { $set: { status: 'draft' } },
    );

    await request(app).post(`/api/jobs/${fullStackJob._id}/match`).send({});
    await JobMatchModel.updateOne(
      { job: fullStackJob._id, profile: devopsProfile._id },
      { $set: { score: 99 } },
    );

    const prepared = await request(app)
      .post('/api/applications/prepare')
      .send({ jobId: String(fullStackJob._id) });
    expect(prepared.status).toBe(201);
    expect(prepared.body.application.profileKind).not.toBe('devops_cloud');
    expect(['full_stack', 'ai_engineer']).toContain(prepared.body.application.profileKind);
  });

  it('invalidates approval after the cover letter is edited', async () => {
    const { aiJob, aiProfile } = await seedMockJobs();

    const prepared = await request(app)
      .post('/api/applications/prepare')
      .send({ jobId: String(aiJob._id), profileId: String(aiProfile._id) });
    expect(prepared.status).toBe(201);
    const id = prepared.body.application.id;

    const approved = await request(app)
      .post(`/api/applications/${id}/approve`)
      .send({ confirmed: true });
    expect(approved.status).toBe(200);

    const edited = await request(app)
      .patch(`/api/applications/${id}/cover-letter`)
      .send({
        letterText:
          'Dear Hiring Manager,\n\nI am applying for this role. My verified experience includes Python, RAG pipelines and LLM APIs, which I have used in production work described in my CV.\n\nSincerely,\nJane Example',
      });
    expect(edited.status).toBe(200);
    expect(edited.body.application.status).toBe('READY_FOR_REVIEW');
    expect(edited.body.application.version).toBe(2);
    expect(edited.body.letter.source).toBe('edited');

    const blocked = await request(app).post(`/api/applications/${id}/submit`).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/no approval record/i);

    const approvedAgain = await request(app)
      .post(`/api/applications/${id}/approve`)
      .send({ confirmed: true });
    expect(approvedAgain.status).toBe(200);
  });

  it('invalidates approval when the CV document changes', async () => {
    const { platformJob, devopsProfile } = await seedMockJobs();
    const prepared = await request(app)
      .post('/api/applications/prepare')
      .send({ jobId: String(platformJob._id), profileId: String(devopsProfile._id) });
    expect(prepared.status).toBe(201);
    const id = prepared.body.application.id;

    await request(app).post(`/api/applications/${id}/approve`).send({ confirmed: true });
    await DocumentModel.updateOne(
      { _id: devopsProfile.cvDocument },
      { $set: { contentHash: sha256('changed cv content') } },
    );

    const blocked = await request(app).post(`/api/applications/${id}/submit`).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/CV changed/i);
  });

  it('falls back to explicit manual action and requires user confirmation', async () => {
    const { platformJob, devopsProfile } = await seedMockJobs();
    const settings = await request(app)
      .patch('/api/settings')
      .send({ application: { allowMockSubmission: false } });
    expect(settings.status).toBe(200);

    const prepared = await request(app)
      .post('/api/applications/prepare')
      .send({ jobId: String(platformJob._id), profileId: String(devopsProfile._id) });
    expect(prepared.status).toBe(201);
    const id = prepared.body.application.id;

    const approved = await request(app)
      .post(`/api/applications/${id}/approve`)
      .send({ confirmed: true });
    expect(approved.status).toBe(200);

    const manual = await request(app).post(`/api/applications/${id}/submit`).send({});
    expect(manual.status).toBe(200);
    expect(manual.body.status).toBe('NEEDS_MANUAL_ACTION');
    expect(manual.body.submission.confirmed).toBe(false);
    expect(manual.body.submission.manualInstructions).toContain('example.com');

    const confirmed = await request(app)
      .post(`/api/applications/${id}/confirm-manual`)
      .send({ confirmed: true, note: 'Employer confirmation email received.' });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('SUBMITTED');
    expect(confirmed.body.submission.adapter).toBe('manual_user_confirmation');
    expect(confirmed.body.submission.confirmed).toBe(true);
  });

  it('blocks a second application for the same employer and title', async () => {
    const { fullStackJob, fullStackProfile } = await seedMockJobs();
    const prepared = await request(app)
      .post('/api/applications/prepare')
      .send({ jobId: String(fullStackJob._id), profileId: String(fullStackProfile._id) });
    const id = prepared.body.application.id;
    const question = prepared.body.application.screeningQuestions[0];
    await request(app)
      .post(`/api/applications/${id}/questions/answer`)
      .send({ questionId: question.questionId, answer: '7' });
    await request(app).post(`/api/applications/${id}/approve`).send({ confirmed: true });
    await request(app).post(`/api/applications/${id}/submit`).send({});

    const duplicateJob = await JobModel.create({
      source: 'arbeitnow',
      sourceJobId: 'duplicate-1',
      sourceLabel: 'Arbeitnow',
      url: 'https://example.com/other-listing',
      canonicalUrl: 'https://example.com/other-listing',
      applicationUrl: 'https://example.com/other-listing',
      employer: fullStackJob.employer,
      title: fullStackJob.title,
      location: fullStackJob.location,
      country: 'Germany',
      remote: false,
      workArrangement: 'hybrid',
      employmentType: 'full-time',
      salary: '',
      tags: [],
      description: 'Same role, different listing.',
      postedAt: new Date(),
      expiresAt: null,
      status: 'active',
      fingerprint: jobFingerprint(fullStackJob.employer, fullStackJob.title, fullStackJob.location),
      discoveredAt: new Date(),
      lastVerifiedAt: new Date(),
    });

    const blocked = await request(app)
      .post('/api/applications/prepare')
      .send({ jobId: String(duplicateJob._id), profileId: String(fullStackProfile._id) });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/already applied to/i);
  });

  it('blocks duplicates by canonical job URL even under a different title', async () => {
    const { fullStackJob, fullStackProfile } = await seedMockJobs();
    const appliedAt = new Date(Date.now() - 5 * 86_400_000);

    await ApplicationModel.create({
      job: fullStackJob._id,
      profile: fullStackProfile._id,
      employer: fullStackJob.employer,
      jobTitle: fullStackJob.title,
      jobUrl: fullStackJob.url,
      applicationUrl: fullStackJob.applicationUrl,
      source: fullStackJob.source,
      status: 'SUBMITTED',
      appliedAt,
      duplicateKey: 'some-other-employer-title-key',
      idempotencyKey: 'same-url-application',
      submission: { attemptedAt: appliedAt, adapter: 'manual_user_confirmation', confirmed: true },
    });

    const sameUrlJob = await JobModel.create({
      source: 'remotive',
      sourceJobId: 'same-url-different-id',
      sourceLabel: 'Remotive',
      url: `${fullStackJob.url}?ref=repost`,
      canonicalUrl: fullStackJob.canonicalUrl,
      applicationUrl: fullStackJob.applicationUrl,
      employer: 'A Different Employer GmbH',
      title: 'Platform Engineer',
      location: fullStackJob.location,
      country: 'Germany',
      remote: false,
      workArrangement: 'hybrid',
      employmentType: 'full-time',
      salary: '',
      tags: [],
      description: 'Same canonical URL, different source id and title.',
      postedAt: new Date(Date.now() - 200 * 86_400_000),
      ageEligibility: 'Eligible',
      expiresAt: null,
      status: 'active',
      fingerprint: jobFingerprint('A Different Employer GmbH', 'Platform Engineer', fullStackJob.location),
      discoveredAt: new Date(),
      lastVerifiedAt: new Date(),
    });

    const blocked = await request(app)
      .post('/api/applications/prepare')
      .send({ jobId: String(sameUrlJob._id), profileId: String(fullStackProfile._id) });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/already applied to/i);
  });

  it('never re-applies to a vacancy that was applied to months ago', async () => {
    const { fullStackJob, fullStackProfile } = await seedMockJobs();
    const appliedAt = new Date(Date.now() - 100 * 86_400_000);

    await ApplicationModel.create({
      job: fullStackJob._id,
      profile: fullStackProfile._id,
      employer: fullStackJob.employer,
      jobTitle: fullStackJob.title,
      jobUrl: fullStackJob.url,
      applicationUrl: fullStackJob.applicationUrl,
      source: fullStackJob.source,
      status: 'SUBMITTED',
      appliedAt,
      duplicateKey: duplicateKeyFor(fullStackJob.employer, fullStackJob.title),
      idempotencyKey: 'historical-application',
      submission: {
        attemptedAt: appliedAt,
        adapter: 'manual_user_confirmation',
        confirmed: true,
        confirmationId: 'old-confirmation',
      },
    });

    // The employer reposts the same role under a new listing id.
    const reposted = await JobModel.create({
      source: 'arbeitnow',
      sourceJobId: 'reposted-after-months',
      sourceLabel: 'Arbeitnow',
      url: 'https://example.com/reposted-listing',
      canonicalUrl: 'https://example.com/reposted-listing',
      applicationUrl: 'https://example.com/reposted-listing',
      employer: fullStackJob.employer,
      title: fullStackJob.title,
      location: fullStackJob.location,
      country: 'Germany',
      remote: false,
      workArrangement: 'hybrid',
      employmentType: 'full-time',
      salary: '',
      tags: [],
      description: 'The same role, posted again months later.',
      postedAt: new Date(),
      expiresAt: null,
      status: 'active',
      fingerprint: jobFingerprint(fullStackJob.employer, fullStackJob.title, fullStackJob.location),
      discoveredAt: new Date(),
      lastVerifiedAt: new Date(),
    });

    const blocked = await request(app)
      .post('/api/applications/prepare')
      .send({ jobId: String(reposted._id), profileId: String(fullStackProfile._id) });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/already applied to/i);
    expect(blocked.body.error.details.appliedAt).toBeTruthy();
  });
});
