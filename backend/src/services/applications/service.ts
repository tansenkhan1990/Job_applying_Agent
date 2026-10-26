import { randomUUID } from 'node:crypto';
import type { Types } from 'mongoose';
import { ApplicationModel } from '../../models/Application.js';
import { JobModel } from '../../models/Job.js';
import { JobMatchModel } from '../../models/JobMatch.js';
import { CandidateProfileModel } from '../../models/CandidateProfile.js';
import { DocumentModel } from '../../models/Document.js';
import { CoverLetterModel } from '../../models/CoverLetter.js';
import type { ApplicationStatus } from '../../config/defaults.js';
import { env } from '../../config/env.js';
import { getSettings } from '../settingsService.js';
import { matchJob } from '../matching/index.js';
import { generateCoverLetter, saveCoverLetterVersion } from '../coverLetters/generate.js';
import { coverLetterPdfFilename } from '../coverLetters/render.js';
import { extractScreeningQuestions, unansweredRequired } from './questions.js';
import { resolveSubmissionAdapter } from './submission.js';
import { applyTransition } from './stateMachine.js';
import { verifyJobAvailability } from '../jobs/verify.js';
import { assessJobAge, jobAgeCutoff } from '../jobs/age.js';
import { AppError, conflict, notFound, badRequest } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { sha256 } from '../../utils/hash.js';
import { normalizeForMatch } from '../../utils/text.js';
import type { ApplicationDoc, JobDoc, ProfileDoc } from '../../types/models.js';

const ACTIVE_DUPLICATE_STATUSES: ApplicationStatus[] = ['READY_FOR_REVIEW', 'APPROVED'];
const SUBMITTED_STATUSES: ApplicationStatus[] = ['SUBMITTED', 'SUBMITTING'];

export function duplicateKeyFor(employer: string, title: string): string {
  return sha256(`${normalizeForMatch(employer)}|${normalizeForMatch(title)}`);
}

/**
 * The application record is the durable applied-jobs registry: it keeps employer, job title,
 * URL and `appliedAt` even when the listing disappears or the employer reposts the role
 * under a new source/id. A vacancy that was applied to is therefore never applied to again,
 * regardless of how much time has passed.
 */
async function findPriorApplication(input: {
  jobId: Types.ObjectId;
  duplicateKey: string;
  canonicalUrl?: string;
  excludeApplicationId?: Types.ObjectId;
}): Promise<ApplicationDoc | null> {
  // The same canonical URL can be stored as separate job documents if a source changes
  // its external id. Match those too, not only the referenced job and employer/title.
  const relatedJobs = input.canonicalUrl
    ? await JobModel.find({ canonicalUrl: input.canonicalUrl }).select('_id').lean()
    : [];
  const jobIds = [input.jobId, ...relatedJobs.map((related) => related._id)];

  return ApplicationModel.findOne({
    ...(input.excludeApplicationId ? { _id: { $ne: input.excludeApplicationId } } : {}),
    $and: [
      { $or: [{ job: { $in: jobIds } }, { duplicateKey: input.duplicateKey }] },
      { $or: [{ status: { $in: SUBMITTED_STATUSES } }, { appliedAt: { $ne: null } }] },
    ],
  });
}

function priorApplicationMessage(prior: ApplicationDoc): string {
  const appliedOn = prior.appliedAt ?? prior.submission?.attemptedAt ?? prior.createdAt;
  const date = appliedOn ? appliedOn.toISOString().slice(0, 10) : 'an earlier date';
  return `This vacancy was already applied to on ${date} (${prior.status}). Previously applied vacancies are never submitted again, even months later or when the role is reposted under a different listing.`;
}

function answersHash(questions: Array<{ questionId: string; answer: string }>): string {
  return sha256(
    JSON.stringify(
      [...questions]
        .map((item) => ({ id: item.questionId, answer: item.answer.trim() }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ),
  );
}

function setApprovalCleared(app: ApplicationDoc): void {
  app.set('approval', {
    approvedAt: null,
    approvedBy: '',
    applicationVersion: null,
    cvHash: '',
    coverLetterHash: '',
    confirmedAnswersHash: '',
    note: '',
  });
}

function requireApprovedProfile(profile: ProfileDoc): void {
  if (profile.status !== 'approved') {
    throw conflict(
      'The candidate profile must be reviewed and approved before preparing an application.',
      { profileId: String(profile._id), status: profile.status },
    );
  }
}

async function resolveProfile(input: {
  profileId?: string;
  profileKind?: string;
}, job: JobDoc): Promise<ProfileDoc> {
  if (input.profileId) {
    const profile = await CandidateProfileModel.findById(input.profileId);
    if (!profile) throw notFound('Candidate profile');
    return profile;
  }
  if (input.profileKind) {
    const profile = await CandidateProfileModel.findOne({ kind: input.profileKind });
    if (!profile) throw notFound('Candidate profile');
    return profile;
  }
  // Prefer the highest-scoring match whose profile was actually approved. Picking the
  // highest score regardless of status sent draft profiles to requireApprovedProfile even
  // when another matched profile was ready to use.
  const existing = await JobMatchModel.find({ job: job._id }).sort({ score: -1 });
  for (const match of existing) {
    const profile = await CandidateProfileModel.findById(match.profile);
    if (profile?.status === 'approved') return profile;
  }

  const matches = await matchJob(String(job._id));
  const sorted = [...matches].sort((a, b) => b.score - a.score);
  for (const match of sorted) {
    const profile = await CandidateProfileModel.findById(match.profile);
    if (profile?.status === 'approved') return profile;
  }
  if (sorted.length === 0) throw badRequest('No profile could be matched to this job');

  const fallback = await CandidateProfileModel.findById(sorted[0].profile);
  if (!fallback) throw notFound('Candidate profile');
  throw conflict(
    'No matched candidate profile is approved. Approve a profile or choose an approved profile explicitly before preparing an application.',
    { profileId: String(fallback._id), kind: fallback.kind, status: fallback.status },
  );
}

export interface PrepareResult {
  application: ApplicationDoc;
  created: boolean;
  warnings: string[];
}

export async function prepareApplication(input: {
  jobId: string;
  profileId?: string;
  profileKind?: string;
}): Promise<PrepareResult> {
  const settings = await getSettings();
  const job = await JobModel.findById(input.jobId);
  if (!job) throw notFound('Job');
  if (job.status !== 'active') {
    throw conflict(`This vacancy is marked "${job.status}" and cannot be prepared.`);
  }

  const profile = await resolveProfile(input, job);
  requireApprovedProfile(profile);

  if (!profile.cvDocument) {
    throw conflict('No CV document is mapped to this profile. Map one on the Documents page.');
  }
  const cv = await DocumentModel.findById(profile.cvDocument).select('+text');
  if (!cv || cv.missing) throw conflict('The mapped CV document is unavailable. Rescan the documents folder.');
  if (cv.status === 'needs_ocr') {
    throw conflict('The mapped CV has no extractable text (scanned PDF). Run OCR and rescan.');
  }
  if (!cv.text || cv.text.trim().length < 50) {
    throw conflict('The mapped CV contains too little text to prepare an application.');
  }

  const existingActive = await ApplicationModel.findOne({
    job: job._id,
    profile: profile._id,
    status: { $in: ACTIVE_DUPLICATE_STATUSES },
  });
  if (existingActive) {
    logger.info({ applicationId: String(existingActive._id) }, 'Returning existing prepared application');
    return { application: existingActive, created: false, warnings: ['A prepared application already exists.'] };
  }

  const duplicateKey = duplicateKeyFor(job.employer, job.title);
  const priorApplication = await findPriorApplication({
    jobId: job._id,
    duplicateKey,
    canonicalUrl: job.canonicalUrl,
  });
  if (priorApplication) {
    throw conflict(priorApplicationMessage(priorApplication), {
      applicationId: String(priorApplication._id),
      status: priorApplication.status,
      appliedAt: priorApplication.appliedAt ?? priorApplication.submission?.attemptedAt ?? null,
    });
  }

  const [match] = await matchJob(String(job._id), { profileIds: [String(profile._id)] });
  if (!match) throw badRequest('Matching did not return a result for this profile.');

  const letter = await generateCoverLetter({ job, profile, match });
  const savedLetter = await saveCoverLetterVersion({ job, profile, letter, version: 1 });
  const questions = await extractScreeningQuestions(job, profile);

  const warnings: string[] = [];
  if (settings.application.mode === 'prepare_only') {
    warnings.push('Application mode is "prepare only"; submission is disabled in Settings.');
  }
  if (!letter.grounding.passed) {
    warnings.push('The generated cover letter has grounding warnings; review it carefully before approving.');
  }
  if (match.score < settings.application.minScoreToPrepare) {
    warnings.push(
      `Match score ${match.score} is below the configured preparation threshold (${settings.application.minScoreToPrepare}). Review carefully.`,
    );
  }

  const age = assessJobAge({
    postedAt: job.postedAt,
    postedLocalDate: job.postedLocalDate,
    expiresAt: job.expiresAt,
    status: job.status,
    months: settings.search.maxAgeMonths,
  });
  const initialWorkflowStatus =
    age.ageEligibility === 'Unknown'
      ? 'NEEDS_REVIEW'
      : age.ageEligibility === 'Expired'
        ? 'EXPIRED'
        : job.languageDecision === 'Excluded' || job.languageDecision === 'Needs Review'
          ? 'LANGUAGE_REVIEW'
          : 'READY_TO_APPLY';
  const coverLetterDocument = profile.coverLetterDocument
    ? await DocumentModel.findById(profile.coverLetterDocument)
    : null;

  const application = await ApplicationModel.create({
    job: job._id,
    profile: profile._id,
    match: match._id,
    employer: job.employer,
    jobTitle: job.title,
    jobUrl: job.url,
    applicationUrl: job.applicationUrl || job.url,
    source: job.source,
    jobLocation: job.location,
    workArrangement: job.workArrangement,
    postedAt: job.postedAt,      ageEligibility: age.ageEligibility,
      eligibleAfter: age.eligibleAfter,
      ageReason: age.ageReason,
      discoveredAt: job.discoveredAt,
    jobDescriptionSnapshot: (job.description ?? '').slice(0, 8_000),
    languageSnapshot: {
      jobLanguage: job.jobLanguage,
      englishRequired: job.englishRequired,
      germanRequired: job.germanRequired,
      germanOptional: job.germanOptional,
      languageDecision: job.languageDecision,
      languageConfidence: job.languageConfidence,
      languageEvidence: job.languageEvidence,
      languageReason: job.languageReason,
    },
    matchScore: match.score,
    matchExplanation: match.explanation,
    profileKind: profile.kind,
    selectedCvFilename: cv.filename,
    selectedCoverLetterFilename: coverLetterPdfFilename(job.employer),
    sourceCoverLetterFilename: coverLetterDocument?.filename ?? '',
    preparationStartedAt: new Date(),
    status: 'READY_FOR_REVIEW',
    version: 1,
    selectedCvDocument: cv._id,
    selectedCoverLetterDocument: profile.coverLetterDocument ?? null,
    cvHash: cv.contentHash,
    coverLetterHash: savedLetter.contentHash,
    currentLetter: savedLetter._id,
    screeningQuestions: questions,
    idempotencyKey: `${String(job._id)}:${String(profile._id)}:${randomUUID()}`,
    duplicateKey,
    workflow: {
      status: initialWorkflowStatus,
      updatedAt: new Date(),
      events: [
        {
          at: new Date(),
          type: 'prepared',
          from: 'DISCOVERED',
          to: initialWorkflowStatus,
          source: 'system',
          message:
            initialWorkflowStatus === 'READY_TO_APPLY'
              ? 'Application prepared; language and posting age are eligible.'
              : `Application prepared with workflow ${initialWorkflowStatus}: ${age.ageReason} ${job.languageReason}`,
        },
      ],
    },
    statusHistory: [
      { from: '', to: 'MATCHED', at: new Date(), reason: 'Application prepared from a validated match' },
      { from: 'MATCHED', to: 'READY_FOR_REVIEW', at: new Date(), reason: 'Cover letter and screening questions prepared' },
    ],
  });

  await CoverLetterModel.updateOne({ _id: savedLetter._id }, { $set: { application: application._id } });

  logger.info(
    {
      applicationId: String(application._id),
      jobId: String(job._id),
      profileId: String(profile._id),
      score: match.score,
      letterSource: letter.source,
    },
    'Application prepared',
  );

  return { application, created: true, warnings };
}

export async function getApplicationById(id: string): Promise<ApplicationDoc> {
  const application = await ApplicationModel.findById(id);
  if (!application) throw notFound('Application');
  return application;
}

export async function getApplicationDetail(id: string) {
  const application = await ApplicationModel.findById(id)
    .populate('job')
    .populate('profile')
    .populate('selectedCvDocument')
    .populate('selectedCoverLetterDocument')
    .populate('currentLetter')
    .populate('match');
  if (!application) throw notFound('Application');
  return application;
}

export async function approveApplication(
  id: string,
  input: {
    confirmed: true;
    confirmedAnswers?: Array<{ questionId: string; answer: string }>;
    note?: string;
  },
) {
  const application = await getApplicationById(id);
  if (application.status !== 'READY_FOR_REVIEW') {
    throw conflict(`Only applications in READY_FOR_REVIEW can be approved (current: ${application.status}).`);
  }

  if (input.confirmedAnswers?.length) {
    for (const submitted of input.confirmedAnswers) {
      const question = application.screeningQuestions.find(
        (item) => item.questionId === submitted.questionId,
      );
      if (!question) {
        throw badRequest(`Unknown screening question id: ${submitted.questionId}`);
      }
      question.answer = submitted.answer.trim();
      question.status = submitted.answer.trim() ? 'answered' : 'unknown';
    }
  }

  const unanswered = application.screeningQuestions.filter(
    (question) => question.required && question.status !== 'answered',
  );
  if (unanswered.length > 0) {
    throw conflict('All mandatory screening questions must be answered before approval.', {
      unanswered: unanswered.map((question) => ({
        questionId: question.questionId,
        question: question.question,
      })),
    });
  }

  const job = await JobModel.findById(application.job);
  if (!job) throw notFound('Job');
  if (job.status !== 'active') throw conflict('The vacancy is no longer active.');

  const cv = await DocumentModel.findById(application.selectedCvDocument);
  if (!cv) throw conflict('The selected CV document no longer exists.');
  if (cv.contentHash !== application.cvHash) {
    throw conflict(
      'The CV changed since this application was prepared. Rescan documents and prepare the application again.',
    );
  }

  const profile = await CandidateProfileModel.findById(application.profile);
  if (!profile) throw notFound('Candidate profile');
  if (String(profile.cvDocument) !== String(application.selectedCvDocument)) {
    throw conflict('The profile CV mapping changed since preparation. Prepare the application again.');
  }

  const letter = await CoverLetterModel.findById(application.currentLetter);
  if (!letter) throw conflict('The prepared cover letter is missing.');
  if (letter.contentHash !== application.coverLetterHash) {
    throw conflict('The cover letter changed after preparation. Reload and approve again.');
  }

  setApprovalCleared(application);
  const approval = {
    approvedAt: new Date(),
    approvedBy: 'local-user',
    applicationVersion: application.version,
    cvHash: application.cvHash,
    coverLetterHash: application.coverLetterHash,
    confirmedAnswersHash: answersHash(application.screeningQuestions),
    note: input.note ?? '',
  };
  application.set('approval', approval);
  applyTransition(application, 'APPROVED', 'Explicit local user approval recorded', 'user');
  await application.save();

  logger.info(
    {
      applicationId: String(application._id),
      version: application.version,
      cvHash: application.cvHash.slice(0, 12),
      letterHash: application.coverLetterHash.slice(0, 12),
    },
    'Application approved by user',
  );

  return application;
}

async function assertApprovalValid(application: ApplicationDoc): Promise<{ job: JobDoc }> {
  const approval = application.approval;
  if (!approval?.approvedAt || approval.applicationVersion === null) {
    throw conflict('This application has no approval record. Explicit approval is required before submission.');
  }
  if (approval.applicationVersion !== application.version) {
    throw conflict('The application changed after approval. Review and approve the current version again.', {
      approvedVersion: approval.applicationVersion,
      currentVersion: application.version,
    });
  }
  if (application.status !== 'APPROVED') {
    throw conflict(`Only APPROVED applications can be submitted (current: ${application.status}).`);
  }

  const job = await JobModel.findById(application.job);
  if (!job) throw notFound('Job');
  if (job.status !== 'active') throw conflict('The vacancy is no longer active.');

  const cv = await DocumentModel.findById(application.selectedCvDocument);
  if (!cv || cv.contentHash !== approval.cvHash) {
    throw conflict('The CV changed after approval. Prepare and approve the application again.');
  }
  if (cv.status !== 'processed') {
    throw conflict('The selected CV is not in a processed state.');
  }

  const letter = await CoverLetterModel.findById(application.currentLetter);
  if (!letter || letter.contentHash !== approval.coverLetterHash) {
    throw conflict('The cover letter changed after approval. Review and approve again.');
  }

  if (answersHash(application.screeningQuestions) !== approval.confirmedAnswersHash) {
    throw conflict('Screening answers changed after approval. Review and approve again.');
  }

  const unanswered = application.screeningQuestions.filter(
    (question) => question.required && question.status !== 'answered',
  );
  if (unanswered.length > 0) {
    throw conflict('Mandatory screening questions are unanswered.');
  }

  return { job };
}

export async function submitApplication(id: string) {
  const settings = await getSettings();
  if (settings.application.mode === 'prepare_only') {
    throw conflict('Application mode is "prepare only". Change it in Settings to enable submissions.');
  }

  let application = await getApplicationById(id);

  if (application.status === 'SUBMITTED') {
    throw conflict('This application has already been submitted.');
  }
  if (application.submission?.confirmed) {
    throw conflict('A confirmed submission already exists for this application.');
  }
  if (application.status === 'SUBMITTING') {
    const lastAttempt = application.submission?.lastAttemptAt;
    if (lastAttempt && Date.now() - lastAttempt.getTime() < 10 * 60_000) {
      throw conflict('A submission attempt is already in progress. Do not retry blindly.');
    }
  }

  const { job } = await assertApprovalValid(application);

  const duplicate = await findPriorApplication({
    jobId: application.job,
    duplicateKey: application.duplicateKey,
    excludeApplicationId: application._id,
  });
  if (duplicate) {
    throw conflict(priorApplicationMessage(duplicate), {
      applicationId: String(duplicate._id),
      status: duplicate.status,
      appliedAt: duplicate.appliedAt ?? duplicate.submission?.attemptedAt ?? null,
    });
  }

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todayCount = await ApplicationModel.countDocuments({
    status: 'SUBMITTED',
    updatedAt: { $gte: startOfDay },
  });
  if (todayCount >= settings.application.maxDailyApplications) {
    throw conflict(
      `Daily application limit reached (${settings.application.maxDailyApplications}). Increase it deliberately in Settings if needed.`,
    );
  }

  const availability = await verifyJobAvailability(String(job._id));
  const refreshedJob = await JobModel.findById(job._id);
  if (!refreshedJob || refreshedJob.status !== 'active') {
    applyTransition(application, 'FAILED', `Vacancy unavailable: ${availability.evidence}`);
    application.set('submission', {
      ...(application.submission ?? {}),
      attemptedAt: new Date(),
      adapter: '',
      confirmed: false,
      confirmationId: '',
      message: `The vacancy could not be verified as available: ${availability.evidence}`,
      evidence: availability.evidence,
      simulated: false,
      manualInstructions: '',
      attempts: (application.submission?.attempts ?? 0) + 1,
      lastAttemptAt: new Date(),
    });
    await application.save();
    throw conflict('The vacancy is not available. Submission was blocked.', {
      evidence: availability.evidence,
    });
  }

  application.set('submission', {
    ...(application.submission ?? {}),
    attemptedAt: new Date(),
    adapter: '',
    confirmed: false,
    confirmationId: '',
    message: '',
    evidence: `Availability check: ${availability.status} (${availability.evidence})`,
    simulated: false,
    manualInstructions: '',
    attempts: (application.submission?.attempts ?? 0) + 1,
    lastAttemptAt: new Date(),
  });
  applyTransition(application, 'SUBMITTING', 'Approval verified; submission started');
  await application.save();

  const adapter = resolveSubmissionAdapter(refreshedJob, settings);
  let outcome;
  try {
    outcome = await adapter.submit({ application, job: refreshedJob, settings });
  } catch (error) {
    outcome = {
      outcome: 'failed' as const,
      adapter: adapter.id,
      message: error instanceof Error ? error.message : 'Submission adapter failed',
      evidence: 'Adapter threw an error; outcome unknown, verify manually before retrying.',
    };
  }

  application = (await ApplicationModel.findById(id)) ?? application;

  if (outcome.outcome === 'submitted') {
    applyTransition(application, 'SUBMITTED', outcome.message);
    application.set('appliedAt', new Date());
    application.set('submission', {
      ...(application.submission ?? {}),
      attemptedAt: new Date(),
      adapter: outcome.adapter,
      confirmed: true,
      confirmationId: outcome.confirmationId ?? '',
      message: outcome.message,
      evidence: outcome.evidence,
      simulated: outcome.simulated === true,
      manualInstructions: '',
      attempts: application.submission?.attempts ?? 1,
      lastAttemptAt: new Date(),
    });
  } else if (outcome.outcome === 'manual_required') {
    applyTransition(application, 'NEEDS_MANUAL_ACTION', outcome.message);
    application.set('submission', {
      ...(application.submission ?? {}),
      attemptedAt: new Date(),
      adapter: outcome.adapter,
      confirmed: false,
      confirmationId: '',
      message: outcome.message,
      evidence: `${outcome.evidence}\n${availability.evidence}`,
      simulated: false,
      manualInstructions: outcome.manualInstructions ?? '',
      attempts: application.submission?.attempts ?? 1,
      lastAttemptAt: new Date(),
    });
  } else {
    applyTransition(application, 'FAILED', outcome.message);
    application.set('submission', {
      ...(application.submission ?? {}),
      attemptedAt: new Date(),
      adapter: outcome.adapter,
      confirmed: false,
      confirmationId: '',
      message: outcome.message,
      evidence: outcome.evidence,
      simulated: false,
      manualInstructions: '',
      attempts: application.submission?.attempts ?? 1,
      lastAttemptAt: new Date(),
    });
  }

  await application.save();
  logger.info(
    {
      applicationId: String(application._id),
      adapter: outcome.adapter,
      outcome: outcome.outcome,
      simulated: outcome.simulated === true,
    },
    'Application submission processed',
  );

  return application;
}

export async function confirmManualSubmission(id: string, input: { note?: string }) {
  const application = await getApplicationById(id);
  if (application.status !== 'NEEDS_MANUAL_ACTION') {
    throw conflict('Manual confirmation is only available while the application needs manual action.');
  }
  if (application.submission?.confirmed) {
    throw conflict('Submission is already confirmed.');
  }

  applyTransition(
    application,
    'SUBMITTED',
    'User confirmed completing the employer form manually',
    'user',
  );
  application.set('appliedAt', new Date());
  application.set('submission', {
    ...(application.submission ?? {}),
    confirmed: true,
    adapter: 'manual_user_confirmation',
    confirmationId: `manual-${Date.now()}`,
    message: 'The user confirmed that the application was submitted through the employer website.',
    evidence: input.note
      ? `User attestation: ${input.note}`
      : 'User attestation recorded locally; no automated confirmation was available.',
    manualInstructions: '',
    lastAttemptAt: new Date(),
    attempts: application.submission?.attempts ?? 1,
  });
  await application.save();
  return application;
}

export async function cancelApplication(id: string, reason = '') {
  const application = await getApplicationById(id);
  if (application.status === 'SUBMITTING') {
    throw conflict('A submission is in progress; wait for the outcome before cancelling.');
  }
  if (application.status === 'WITHDRAWN') return application;
  applyTransition(application, 'WITHDRAWN', reason || 'Application withdrawn locally', 'user');
  await application.save();
  return application;
}

function resetForRevision(application: ApplicationDoc, reason: string) {
  if (application.status === 'APPROVED') {
    applyTransition(application, 'READY_FOR_REVIEW', reason);
  } else if (application.status === 'NEEDS_MANUAL_ACTION') {
    applyTransition(application, 'READY_FOR_REVIEW', reason);
  }
  setApprovalCleared(application);
  application.version += 1;
}

export async function editCoverLetter(
  id: string,
  input: { letterText: string; subjectLine?: string },
) {
  const application = await getApplicationById(id);
  if (['SUBMITTING', 'SUBMITTED', 'WITHDRAWN'].includes(application.status)) {
    throw conflict(`Cannot edit a letter for an application in ${application.status}.`);
  }
  const job = await JobModel.findById(application.job);
  const profile = await CandidateProfileModel.findById(application.profile);
  if (!job || !profile) throw notFound('Linked job or profile');

  const latest = await CoverLetterModel.findOne({ application: application._id }).sort({ version: -1 });
  const version = (latest?.version ?? 0) + 1;
  const letter = await CoverLetterModel.create({
    job: job._id,
    profile: profile._id,
    application: application._id,
    version,
    subjectLine: input.subjectLine ?? latest?.subjectLine ?? `Application for ${job.title}`,
    letterText: input.letterText,
    contentHash: sha256(input.letterText),
    source: 'edited',
    model: 'user-edited',
    promptVersion: latest?.promptVersion ?? '',
    grounding: latest?.grounding ?? { passed: false },
    cvDocument: profile.cvDocument ?? null,
    coverLetterDocument: profile.coverLetterDocument ?? null,
    wordCount: input.letterText.trim().split(/\s+/).length,
  });

  resetForRevision(application, 'Cover letter edited by user; approval invalidated');
  application.currentLetter = letter._id;
  application.coverLetterHash = letter.contentHash;
  await application.save();
  return { application, letter };
}

export async function regenerateCoverLetter(id: string, instructions?: string) {
  const application = await getApplicationById(id);
  if (['SUBMITTING', 'SUBMITTED', 'WITHDRAWN'].includes(application.status)) {
    throw conflict(`Cannot regenerate a letter for an application in ${application.status}.`);
  }
  const job = await JobModel.findById(application.job);
  const profile = await CandidateProfileModel.findById(application.profile);
  const match = await JobMatchModel.findById(application.match);
  if (!job || !profile) throw notFound('Linked job or profile');

  const generated = await generateCoverLetter({ job, profile, match, instructions });
  const latest = await CoverLetterModel.findOne({ application: application._id }).sort({ version: -1 });
  const saved = await saveCoverLetterVersion({
    job,
    profile,
    applicationId: String(application._id),
    letter: generated,
    version: (latest?.version ?? 0) + 1,
  });

  resetForRevision(application, 'Cover letter regenerated; approval invalidated');
  application.currentLetter = saved._id;
  application.coverLetterHash = saved.contentHash;
  await application.save();
  return { application, letter: saved };
}

export async function answerQuestion(
  id: string,
  input: { questionId: string; answer: string; status?: 'answered' | 'requires_user' | 'unknown' },
) {
  const application = await getApplicationById(id);
  if (['SUBMITTING', 'SUBMITTED', 'WITHDRAWN'].includes(application.status)) {
    throw conflict(`Cannot change answers for an application in ${application.status}.`);
  }
  const question = application.screeningQuestions.find((item) => item.questionId === input.questionId);
  if (!question) throw notFound('Screening question');

  question.answer = input.answer.trim();
  question.status = input.status ?? (input.answer.trim() ? 'answered' : 'unknown');
  if (question.status !== 'answered' && question.answer) {
    throw badRequest('A question marked as not answered must not contain an answer.');
  }

  resetForRevision(application, 'Screening answer updated; approval invalidated');
  await application.save();
  return application;
}

export async function listApplications(query: {
  status?: string;
  workflowStatus?: string;
  ageEligibility?: string;
  profileId?: string;
  employer?: string;
  jobTitle?: string;
  languageDecision?: string;
  from?: string;
  to?: string;
  page: number;
  limit: number;
  skip: number;
}) {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.workflowStatus) filter['workflow.status'] = query.workflowStatus;
  if (query.ageEligibility) filter.ageEligibility = query.ageEligibility;
  if (query.profileId) filter.profile = query.profileId;
  if (query.employer) filter.employer = { $regex: query.employer, $options: 'i' };
  if (query.jobTitle) filter.jobTitle = { $regex: query.jobTitle, $options: 'i' };
  if (query.languageDecision) filter['languageSnapshot.languageDecision'] = query.languageDecision;
  if (query.from || query.to) {
    // Filter on the original posting date, not on when the record was created.
    const range: Record<string, Date> = {};
    if (query.from) range.$gte = new Date(query.from);
    if (query.to) range.$lte = new Date(query.to);
    filter.postedAt = range;
  }

  const [items, total] = await Promise.all([
    ApplicationModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(query.skip)
      .limit(query.limit)
      .populate('profile', 'kind label status')
      .populate('match', 'score'),
    ApplicationModel.countDocuments(filter),
  ]);

  return { items, total };
}

export async function listApplicationQueue(query: { page: number; limit: number; skip: number }) {
  const filter = {
    ageEligibility: 'Eligible',
    status: { $nin: ['SUBMITTED', 'WITHDRAWN', 'SUBMITTING'] },
    'workflow.status': {
      $in: ['READY_TO_APPLY', 'ASSISTANT_RUNNING', 'AWAITING_REVIEW', 'NEEDS_INPUT'],
    },
  };
  const [items, total] = await Promise.all([
    ApplicationModel.find(filter)
      .sort({ 'workflow.startRequestedAt': -1, createdAt: -1 })
      .skip(query.skip)
      .limit(query.limit)
      .populate('job', 'title employer location workArrangement postedAt ageEligibility ageReason languageDecision languageRequirement source url applicationUrl')
      .populate('profile', 'kind label name status cvDocument coverLetterDocument')
      .populate('match', 'score explanation')
      .populate('selectedCvDocument', 'filename relativePath')
      .populate('selectedCoverLetterDocument', 'filename relativePath'),
    ApplicationModel.countDocuments(filter),
  ]);
  return { items, total };
}

export async function dashboardSummary() {
  const [totalJobs, activeJobs, applications, pendingApproval, submitted, failed, manual, runs] =
    await Promise.all([
      JobModel.countDocuments({}),
      JobModel.countDocuments({ status: 'active' }),
      ApplicationModel.countDocuments({}),
      ApplicationModel.countDocuments({ status: 'READY_FOR_REVIEW' }),
      ApplicationModel.countDocuments({ status: 'SUBMITTED' }),
      ApplicationModel.countDocuments({ status: 'FAILED' }),
      ApplicationModel.countDocuments({ status: 'NEEDS_MANUAL_ACTION' }),
      JobMatchModel.find({}).sort({ score: -1 }).limit(5).lean(),
    ]);

  const relevant = await JobMatchModel.countDocuments({ score: { $gte: 80 } });
  const settings = await getSettings();
  const cutoff = jobAgeCutoff(settings.search.maxAgeMonths);
  const now = new Date();
  const eligibleFilter = {
    postedAt: { $gt: cutoff },
    status: 'active',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  };
  const [eligibleByAge, tooRecent, unknownPostingDate, expiredByAge, preparedAwaitingReview, assistantActive] =
    await Promise.all([
      JobModel.countDocuments(eligibleFilter),
      JobModel.countDocuments({ ageEligibility: 'Too Recent' }),
      JobModel.countDocuments({ postedAt: null }),
      JobModel.countDocuments({
        $or: [
          { postedAt: { $lte: cutoff } },
          { expiresAt: { $lt: now } },
          { status: { $in: ['expired', 'unavailable'] } },
        ],
      }),
      ApplicationModel.countDocuments({
        'workflow.status': { $in: ['READY_TO_APPLY', 'AWAITING_REVIEW', 'NEEDS_INPUT'] },
      }),
      ApplicationModel.countDocuments({ 'workflow.status': 'ASSISTANT_RUNNING' }),
    ]);
  const recentRuns = await (await import('../../models/SearchRun.js')).SearchRunModel.find({})
    .sort({ startedAt: -1 })
    .limit(5)
    .lean();

  const byStatus = await ApplicationModel.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);

  return {
    totals: {
      totalJobs,
      activeJobs,
      relevant,
      applications,
      pendingApproval,
      submitted,
      failed,
      manual,
      eligibleByAge,
      tooRecent,
      unknownPostingDate,
      expiredByAge,
      eligibleNotApplied: eligibleByAge,
      preparedAwaitingReview,
      assistantActive,
    },
    applicationsByStatus: Object.fromEntries(byStatus.map((item) => [item._id, item.count])),
    topMatches: runs,
    recentRuns,
    ai: { configured: env.aiConfigured },
  };
}

export function applicationsToCsv(
  items: Array<{
    _id: unknown;
    employer: string;
    jobTitle: string;
    status: string;
    source: string;
    jobUrl: string;
    createdAt: Date;
    updatedAt: Date;
    postedAt?: Date | null;
    ageEligibility?: string;
    appliedAt?: Date | null;
    preparationStartedAt?: Date | null;
    workflow?: { status?: string };
    submission?: { confirmed?: boolean; simulated?: boolean; adapter?: string; confirmationId?: string; message?: string };
  }>,
): string {
  const header = [
    'id',
    'employer',
    'job_title',
    'status',
    'workflow_status',
    'age_eligibility',
    'posted_at',
    'source',
    'job_url',
    'preparation_started_at',
    'applied_at',
    'created_at',
    'updated_at',
    'submission_confirmed',
    'simulated',
    'adapter',
    'confirmation_id',
    'message',
  ];
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return `"${text.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  };
  const rows = items.map((item) =>
    [
      String(item._id),
      item.employer,
      item.jobTitle,
      item.status,
      item.workflow?.status ?? '',
      item.ageEligibility ?? '',
      item.postedAt?.toISOString?.() ?? '',
      item.source,
      item.jobUrl,
      item.preparationStartedAt?.toISOString?.() ?? '',
      item.appliedAt?.toISOString?.() ?? '',
      item.createdAt?.toISOString?.() ?? '',
      item.updatedAt?.toISOString?.() ?? '',
      item.submission?.confirmed ? 'yes' : 'no',
      item.submission?.simulated ? 'yes' : 'no',
      item.submission?.adapter ?? '',
      item.submission?.confirmationId ?? '',
      item.submission?.message ?? '',
    ]
      .map(escape)
      .join(','),
  );
  return [header.join(','), ...rows].join('\n');
}

export async function assertSubmissionAllowedConfig() {
  const settings = await getSettings();
  if (settings.application.mode !== 'approval_required') {
    throw new AppError(409, 'CONFLICT', 'Submission is disabled by the current application mode.');
  }
}
