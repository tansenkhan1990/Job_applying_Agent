import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { CandidateProfileModel } from '../src/models/CandidateProfile.js';
import { ChatSessionModel } from '../src/models/ChatSession.js';
import { JobModel } from '../src/models/Job.js';
import { mockAdapter } from '../src/services/jobs/adapters/mock.js';
import {
  sendChatMessage,
  type ChatResponderInput,
} from '../src/services/ai/chat.js';
import { seedApprovedProfiles, seedJob } from './helpers.js';
import { chatSystemPrompt, coverLetterPrompt } from '../src/services/ai/prompts.js';
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
  maxAgeMonths: 3,
  maxJobs: 20,
};

async function seedFullStackJob() {
  const listings = await mockAdapter.searchJobs(criteria);
  const listing = listings.find((item) => item.sourceJobId === 'mock-fullstack-senior')!;
  return seedJob(listing, {
    fingerprint: 'job-workspace-fingerprint',
    postedAt: new Date(Date.now() - 10 * 86_400_000),
    discoveredAt: new Date(),
  });
}

describe('job dashboard filters and state', () => {
  it('saves and reviews a job and applies saved/reviewed/date filters', async () => {
    const job = await seedFullStackJob();

    await request(app)
      .patch(`/api/jobs/${String(job._id)}/state`)
      .send({ saved: true, reviewed: true })
      .expect(200);

    const saved = await request(app).get('/api/jobs?saved=true&reviewed=true').expect(200);
    expect(saved.body.total).toBe(1);
    expect(saved.body.items[0].saved).toBe(true);
    expect(saved.body.items[0].reviewedAt).toBeTruthy();

    const recent = await request(app).get('/api/jobs?postedWithinDays=30').expect(200);
    expect(recent.body.total).toBe(1);

    const old = await request(app).get('/api/jobs?postedWithinDays=1').expect(200);
    expect(old.body.total).toBe(0);

    const category = await request(app).get('/api/jobs?category=fullstack').expect(200);
    expect(category.body.total).toBe(1);

    const wrongCategory = await request(app).get('/api/jobs?category=ai').expect(200);
    expect(wrongCategory.body.total).toBe(0);
  });

  it('lists only postings inside the calendar-month window and recomputes old badges', async () => {
    const current = await seedFullStackJob();
    const listings = await mockAdapter.searchJobs(criteria);
    const sample = listings.find((item) => item.sourceJobId === 'mock-fullstack-senior')!;
    const oldJob = await seedJob(
      {
        ...sample,
        sourceJobId: 'mock-fullstack-old',
        url: 'https://example.com/mock-jobs/old-fullstack',
        applicationUrl: 'https://example.com/mock-jobs/old-fullstack/apply',
        postedAt: new Date(Date.now() - 120 * 86_400_000),
        expiresAt: null,
      },
      {
        fingerprint: 'job-workspace-old-fingerprint',
        discoveredAt: new Date(),
        // Simulate a stale classification stored before the rule changed.
        ageEligibility: 'Eligible',
      },
    );

    const list = await request(app).get('/api/jobs').expect(200);
    const ids = list.body.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(String(current._id));
    expect(ids).not.toContain(String(oldJob._id));

    const detail = await request(app).get(`/api/jobs/${String(oldJob._id)}`).expect(200);
    expect(detail.body.job.ageEligibility).toBe('Expired');
    expect(detail.body.job.ageReason).toMatch(/calendar months/);
  });

  it('sorts by match score after evaluating profiles', async () => {
    const job = await seedFullStackJob();
    await seedApprovedProfiles();
    await request(app).post(`/api/jobs/${String(job._id)}/match`).send({}).expect(200);

    const sorted = await request(app).get('/api/jobs?sort=score').expect(200);
    expect(sorted.body.total).toBe(1);
    expect(sorted.body.items[0].bestMatch).not.toBeNull();
    expect(sorted.body.items[0].bestMatch.score).toBeGreaterThan(0);
  });

  it('gives every listed job an explainable deterministic score without an AI call', async () => {
    await seedFullStackJob();
    await seedApprovedProfiles();

    const list = await request(app).get('/api/jobs').expect(200);
    expect(list.body.total).toBe(1);
    const match = list.body.items[0].bestMatch;
    expect(match).not.toBeNull();
    expect(match.score).toBeGreaterThan(0);
    expect(match.explanation).toMatch(/match/i);
    expect(match.scoreBreakdown).toBeTruthy();
    expect(match.evaluationSource).toBe('deterministic');
  });
});

describe('standalone job cover letters', () => {
  it('generates, edits, and versions a letter without creating an application', async () => {
    const job = await seedFullStackJob();
    await seedApprovedProfiles();
    const profile = await CandidateProfileModel.findOne({ kind: 'full_stack' });

    const generated = await request(app)
      .post(`/api/jobs/${String(job._id)}/cover-letter`)
      .send({ profileId: String(profile!._id) })
      .expect(201);
    expect(generated.body.letter.source).toBe('template');
    expect(generated.body.letter.letterType).toBe('job');
    expect(generated.body.letter.version).toBe(1);
    expect(generated.body.letter.letterText.length).toBeGreaterThan(100);

    const list = await request(app).get(`/api/jobs/${String(job._id)}/cover-letters`).expect(200);
    expect(list.body).toHaveLength(1);

    const withLetter = await request(app).get('/api/jobs?hasCoverLetter=true').expect(200);
    expect(withLetter.body.total).toBe(1);
    const withoutLetter = await request(app).get('/api/jobs?hasCoverLetter=false').expect(200);
    expect(withoutLetter.body.total).toBe(0);

    const editedText = `${generated.body.letter.letterText}\n\nAdditional paragraph added by the candidate.`;
    const edited = await request(app)
      .patch(`/api/jobs/${String(job._id)}/cover-letters/${generated.body.letter.id}`)
      .send({ letterText: editedText })
      .expect(200);
    expect(edited.body.letter.editedByUser).toBe(true);
    expect(edited.body.letter.version).toBe(1);
    expect(edited.body.letter.revisions).toHaveLength(1);
    expect(edited.body.letter.revisions[0].text).toBe(generated.body.letter.letterText);
    expect(edited.body.letter.generatedText).toBe(generated.body.letter.letterText);

    const regenerated = await request(app)
      .post(`/api/jobs/${String(job._id)}/cover-letter`)
      .send({ profileId: String(profile!._id), instructions: 'More concise.' })
      .expect(201);
    expect(regenerated.body.letter.version).toBe(2);
  });

  it('offers all three CVs and letters and remembers the chosen pair per job', async () => {
    const job = await seedFullStackJob();
    await seedApprovedProfiles();

    const options = await request(app)
      .get(`/api/jobs/${String(job._id)}/cover-letter/options`)
      .expect(200);
    expect(options.body.profiles).toHaveLength(3);
    expect(options.body.profiles.every((item: { cvReady: boolean }) => item.cvReady)).toBe(true);
    expect(
      options.body.profiles.every((item: { referenceReady: boolean }) => item.referenceReady),
    ).toBe(true);
    expect(options.body.profiles.filter((item: { recommended: boolean }) => item.recommended)).toHaveLength(1);
    const ranks = options.body.profiles.map((item: { rank: number }) => item.rank);
    expect([...ranks].sort((a: number, b: number) => a - b)).toEqual([1, 2, 3]);
    expect(
      options.body.profiles.find((item: { recommended: boolean }) => item.recommended).rank,
    ).toBe(1);
    expect(options.body.selectedCvProfileId).toMatch(/^[a-f0-9]{24}$/);
    expect(options.body.selectedReferenceProfileId).toMatch(/^[a-f0-9]{24}$/);
    expect(options.body.selectionRationale).toMatch(/Selected .* CV/);
    expect(options.body.jobChangedSinceLetter).toBe(false);

    // The first letter uses the recommended pair and only documented, job-relevant evidence.
    const autoLetter = await request(app)
      .post(`/api/jobs/${String(job._id)}/cover-letter`)
      .send({})
      .expect(201);
    expect(autoLetter.body.letter.profile).toBe(options.body.selectedCvProfileId);
    expect(autoLetter.body.letter.referenceProfile).toBe(
      options.body.selectedReferenceProfileId,
    );
    expect(autoLetter.body.letter.version).toBe(1);
    const autoText = autoLetter.body.letter.letterText as string;
    expect(autoText).toContain(job.title);
    expect(autoText).toContain(job.employer);
    expect(autoLetter.body.letter.referenceLetterDocument).toBeTruthy();
    const selectedProfile = await CandidateProfileModel.findById(options.body.selectedCvProfileId);
    const evidencedSkills = selectedProfile!.skills.filter((skill) => autoText.includes(skill));
    expect(evidencedSkills.length).toBeGreaterThan(0);
    expect(
      evidencedSkills.some((skill) =>
        (job.description ?? '').toLowerCase().includes(skill.toLowerCase()),
      ),
    ).toBe(true);
    expect(autoLetter.body.letter.grounding.unsupportedNumbers).toEqual([]);

    const devops = await CandidateProfileModel.findOne({ kind: 'devops_cloud' });
    const patched = await request(app)
      .patch(`/api/jobs/${String(job._id)}/letter-preferences`)
      .send({ cvProfileId: String(devops!._id), referenceProfileId: String(devops!._id) })
      .expect(200);
    expect(patched.body.selectedCvProfileId).toBe(String(devops!._id));
    expect(patched.body.selectedReferenceProfileId).toBe(String(devops!._id));
    expect(patched.body.preferencesSaved).toBe(true);

    const stored = await JobModel.findById(job._id);
    expect(String(stored!.letterPreferences?.cvProfile)).toBe(String(devops!._id));

    const generated = await request(app)
      .post(`/api/jobs/${String(job._id)}/cover-letter`)
      .send({})
      .expect(201);
    expect(generated.body.letter.profile).toBe(String(devops!._id));
    expect(generated.body.letter.referenceProfile).toBe(String(devops!._id));
    const roles = generated.body.letter.sourceDocuments.map(
      (entry: { role: string }) => entry.role,
    );
    expect(roles).toContain('selected_cv');
    expect(roles).toContain('reference_letter');
    expect(roles.filter((role: string) => role === 'other_cv')).toHaveLength(2);
    expect(generated.body.letter.selectionRationale.length).toBeGreaterThan(20);
    expect(generated.body.letter.version).toBe(2);

    // A material description change is reported so the candidate knows the letter may be stale.
    await JobModel.updateOne(
      { _id: job._id },
      { $set: { description: `${job.description}\n\nNewly added responsibility: lead a platform team.` } },
    );
    const changed = await request(app)
      .get(`/api/jobs/${String(job._id)}/cover-letter/options`)
      .expect(200);
    expect(changed.body.jobChangedSinceLetter).toBe(true);
  });

  it('reports a missing job description instead of pretending to analyse it', async () => {
    const job = await seedFullStackJob();
    await seedApprovedProfiles();
    await JobModel.updateOne({ _id: job._id }, { $set: { description: '' } });

    const options = await request(app)
      .get(`/api/jobs/${String(job._id)}/cover-letter/options`)
      .expect(200);
    expect(options.body.limitations.join(' ')).toMatch(/job description is empty or unavailable/i);

    const generated = await request(app)
      .post(`/api/jobs/${String(job._id)}/cover-letter`)
      .send({})
      .expect(201);
    const letter = generated.body.letter;
    expect(letter.uncertainties.join(' ')).toMatch(/job description is empty or unavailable/i);
    expect(
      letter.uncertainties.filter((entry: string) =>
        /job description is empty or unavailable/i.test(entry),
      ),
    ).toHaveLength(1);
    expect(letter.letterText).toMatch(/did not include a job description/i);
    expect(letter.letterText).not.toMatch(/role's focus on/i);
  });
});

describe('AI prompt output contracts', () => {
  it('asks chat for prose and structured tasks for JSON', () => {
    expect(chatSystemPrompt('job')).not.toMatch(/valid JSON/i);
    expect(chatSystemPrompt('phd')).not.toMatch(/valid JSON/i);
    expect(chatSystemPrompt('job')).toMatch(/plain, readable prose/i);
    expect(coverLetterPrompt({
      candidateProfile: '{}',
      cvText: '',
      originalCoverLetter: '',
      jobTitle: '',
      employer: '',
      location: '',
      description: '',
      matchedSkills: [],
      concerns: [],
    }).system).toMatch(/valid JSON/i);
  });
});

describe('per-job AI chat', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    env.OPENROUTER_API_KEY = '';
    env.aiConfigured = false;
  });

  function responder(seen: ChatResponderInput[]) {
    return async (input: ChatResponderInput) => {
      seen.push(input);
      return { content: `Grounded answer ${seen.length}`, model: 'test/chat-model' };
    };
  }

  it('keeps conversations separate per job and carries follow-up history', async () => {
    const listings = await mockAdapter.searchJobs({ ...criteria, maxJobs: 20 });
    const jobA = await seedFullStackJob();
    const jobB = await seedJob(
      listings.find((item) => item.sourceJobId === 'mock-ai-engineer-rag')!,
      { fingerprint: 'job-chat-b-fingerprint' },
    );
    await seedApprovedProfiles();
    await request(app).patch('/api/settings').send({ ai: { model: 'test/chat-model' } }).expect(200);

    const seen: ChatResponderInput[] = [];
    const first = await sendChatMessage({
      target: { type: 'job', job: jobA },
      content: 'Which CV is the best fit?',
      responder: responder(seen),
    });
    expect(first.session.targetType).toBe('job');
    expect(String(first.session.job)).toBe(String(jobA._id));
    expect(first.session.phdPosition).toBeNull();
    expect(first.session.messages).toHaveLength(2);
    expect(first.session.messages[1].sources).toContain('job description');
    expect(first.session.contextSnapshot?.targetContentHash).toBeTruthy();

    // The context sent to the model is grounded in this job and the candidate documents.
    expect(seen[0].context).toContain(jobA.title);
    expect(seen[0].context).toMatch(/DOCUMENT RANKING/);
    expect(seen[0].context).toMatch(/selected|Selected|SELECTION RATIONALE/);
    expect(seen[0].system).toMatch(/untrusted data/i);
    expect(seen[0].system).toMatch(/recommendations|inferences/i);
    expect(seen[0].system).toMatch(/unknown/i);
    expect(seen[0].history).toEqual([]);

    const followUp = await sendChatMessage({
      target: { type: 'job', job: jobA },
      content: 'Why that one?',
      sessionId: String(first.session._id),
      responder: responder(seen),
    });
    expect(followUp.session.messages).toHaveLength(4);
    expect(seen[1].history.map((message) => message.content)).toEqual([
      'Which CV is the best fit?',
      'Grounded answer 1',
    ]);

    const other = await sendChatMessage({
      target: { type: 'job', job: jobB },
      content: 'Why am I a good match?',
      responder: responder(seen),
    });
    expect(String(other.session.job)).toBe(String(jobB._id));
    // A different job never receives the first job's transcript.
    expect(seen[2].history).toEqual([]);
    expect(seen[2].context).toContain(jobB.title);

    await expect(
      sendChatMessage({
        target: { type: 'job', job: jobB },
        content: 'Show me the other conversation',
        sessionId: String(first.session._id),
        responder: responder(seen),
      }),
    ).rejects.toThrow(/Chat session/);

    // Sessions and messages persist with the correct job association.
    expect(await ChatSessionModel.countDocuments({ job: jobA._id })).toBe(1);
    const reloaded = await ChatSessionModel.findOne({ job: jobA._id });
    expect(reloaded!.messages).toHaveLength(4);
    expect(reloaded!.aiModel).toBe('test/chat-model');
  });

  it('serves chat over HTTP and never mixes two jobs\u2019 transcripts', async () => {
    const listings = await mockAdapter.searchJobs({ ...criteria, maxJobs: 20 });
    const jobA = await seedFullStackJob();
    const jobB = await seedJob(
      listings.find((item) => item.sourceJobId === 'mock-ai-engineer-rag')!,
      { fingerprint: 'job-chat-http-b-fingerprint' },
    );
    await seedApprovedProfiles();
    await request(app).patch('/api/settings').send({ ai: { model: 'test/chat-model' } }).expect(200);

    env.OPENROUTER_API_KEY = 'test-key';
    env.aiConfigured = true;
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          model: 'test/chat-model',
          choices: [
            {
              message: { content: 'Your TypeScript and React work is evidenced in the selected CV.' },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const reply = await request(app)
      .post(`/api/jobs/${String(jobA._id)}/chat/messages`)
      .send({ content: 'Which of my skills match?' })
      .expect(201);
    expect(reply.body.reply).toContain('TypeScript');
    expect(reply.body.model).toBe('test/chat-model');
    expect(reply.body.session.messages).toHaveLength(2);
    expect(reply.body.sources).toContain('job description');

    const followUp = await request(app)
      .post(`/api/jobs/${String(jobA._id)}/chat/messages`)
      .send({ content: 'And which required skills are missing?', sessionId: reply.body.session.id })
      .expect(201);
    expect(followUp.body.session.messages).toHaveLength(4);

    const providerBody = JSON.parse(String((fetchMock.mock.calls[1][1] as { body: string }).body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(
      providerBody.messages.some(
        (message) => message.role === 'user' && message.content === 'Which of my skills match?',
      ),
    ).toBe(true);
    expect(providerBody.messages.some((message) => message.role === 'assistant')).toBe(true);

    const stored = await request(app).get(`/api/jobs/${String(jobA._id)}/chat`).expect(200);
    expect(stored.body.session.id).toBe(reply.body.session.id);
    const otherJob = await request(app).get(`/api/jobs/${String(jobB._id)}/chat`).expect(200);
    expect(otherJob.body.session).toBeNull();

    await request(app).delete(`/api/jobs/${String(jobA._id)}/chat`).expect(200);
    const cleared = await request(app).get(`/api/jobs/${String(jobA._id)}/chat`).expect(200);
    expect(cleared.body.session).toBeNull();
  });

  it('errors clearly instead of inventing an answer when no model is configured', async () => {
    const job = await seedFullStackJob();
    await seedApprovedProfiles();
    const response = await request(app)
      .post(`/api/jobs/${String(job._id)}/chat/messages`)
      .send({ content: 'Which skills are missing?' })
      .expect(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
    expect(response.body.error.message).toMatch(/model/i);
    expect(await ChatSessionModel.countDocuments()).toBe(0);
  });
});

describe('dashboard summary', () => {
  it('reports date-window job and PhD totals without application workflow data', async () => {
    await seedFullStackJob();
    await seedApprovedProfiles();

    const summary = await request(app).get('/api/dashboard/summary').expect(200);
    expect(summary.body.totals.eligibleByDate).toBe(1);
    expect(summary.body.totals.savedJobs).toBe(0);
    expect(summary.body.totals.openPhd).toBe(0);
    expect(summary.body.ai.configured).toBe(false);
    expect(summary.body.sourceFailures).toEqual([]);
    expect(summary.body.recentRuns).toEqual([]);
    expect(summary.body.applicationsByStatus).toBeUndefined();
    expect(summary.body.topMatches === undefined || Array.isArray(summary.body.topMatches)).toBe(true);
  });
});
