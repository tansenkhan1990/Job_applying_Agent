import path from 'node:path';
import fs from 'node:fs/promises';
import type { Types } from 'mongoose';
import { ApplicationModel } from '../../models/Application.js';
import { AppSettingModel } from '../../models/AppSetting.js';
import { JobModel } from '../../models/Job.js';
import { CandidateProfileModel } from '../../models/CandidateProfile.js';
import { DocumentModel } from '../../models/Document.js';
import { CoverLetterModel } from '../../models/CoverLetter.js';
import { env } from '../../config/env.js';
import type { WorkflowStatus } from '../../config/defaults.js';
import { applyTransition } from '../applications/stateMachine.js';
import { assertApplicationEligible } from '../jobs/eligibility.js';
import { coverLetterPdfFilename, renderLetterPdf } from '../coverLetters/render.js';
import { AppError, badRequest, conflict, notFound } from '../../utils/errors.js';
import type { ApplicationDoc, JobDoc, ProfileDoc } from '../../types/models.js';

const RUNNER_STALE_MS = 2 * 60_000;
const RUNNER_ONLINE_MS = 20_000;
const MAX_EVENTS = 60;

export interface AssistantControl {
  pauseRequested: boolean;
  stopRequested: boolean;
  status: WorkflowStatus;
  fieldsDetected: number;
  fieldsFilled: number;
  filesUploaded: number;
}

export interface ProgressInput {
  runnerId: string;
  status?: 'AWAITING_REVIEW' | 'NEEDS_INPUT';
  pauseReason?: string;
  fieldsDetected?: number;
  fieldsFilled?: number;
  filesUploaded?: number;
  unanswered?: string[];
  reviewFields?: Array<{ label: string; reason: string; fieldType?: string }>;
  validationErrors?: string[];
  pageUrl?: string;
  pageTitle?: string;
  message?: string;
}

function workflowOf(application: ApplicationDoc) {
  if (!application.workflow) {
    application.set('workflow', {});
  }
  return application.workflow!;
}

function pushEvent(application: ApplicationDoc, type: string, message: string): void {
  const wf = workflowOf(application);
  wf.events.push({ at: new Date(), type, message });
  if (wf.events.length > MAX_EVENTS) {
    wf.events.splice(0, wf.events.length - MAX_EVENTS);
  }
  wf.updatedAt = new Date();
}

function workflowStatus(application: ApplicationDoc): WorkflowStatus {
  return (application.workflow?.status ?? 'DISCOVERED') as WorkflowStatus;
}

function languageBlocked(job: JobDoc): boolean {
  return job.languageDecision === 'Excluded' || job.languageRequirement === 'german_required';
}

async function loadApplication(id: string): Promise<ApplicationDoc> {
  const application = await ApplicationModel.findById(id);
  if (!application) throw notFound('Application');
  return application;
}

function contactFromText(cvText: string, profile: ProfileDoc) {
  const email = cvText.match(/[\w.+-]+@[\w-]+\.[\w.-]{2,}/)?.[0] ?? '';
  const phone =
    cvText.match(/\+\d[\d\s().-]{7,}\d/)?.[0]?.replace(/\s+/g, ' ').trim() ??
    cvText.match(/\(?\d{2,4}\)?[\d\s-]{6,}\d/)?.[0]?.replace(/\s+/g, ' ').trim() ??
    '';
  const linkedin = cvText.match(/https?:\/\/[^\s]*linkedin\.com\/[^\s)]+/i)?.[0] ?? '';
  const github = cvText.match(/https?:\/\/[^\s]*github\.com\/[^\s)]+/i)?.[0] ?? '';
  const websites = [...cvText.matchAll(/https?:\/\/[^\s)]+/gi)]
    .map((match) => match[0])
    .filter((url) => !/linkedin\.com|github\.com/i.test(url));
  const parts = (profile.name ?? '').trim().split(/\s+/).filter(Boolean);
  return {
    fullName: profile.name ?? '',
    firstName: parts[0] ?? '',
    lastName: parts.length > 1 ? parts[parts.length - 1] : '',
    email,
    phone,
    location: profile.location ?? '',
    linkedin,
    github,
    website: websites[0] ?? '',
  };
}

export async function assistantConfiguration() {
  const configured = env.BROWSER_RUNNER_TOKEN.trim().length > 0;
  const doc = await AppSettingModel.findOne({ key: 'global' }).lean();
  const runner = (doc as unknown as { runner?: { id?: string; lastSeenAt?: Date | null } } | null)
    ?.runner;
  const lastSeenAt = runner?.lastSeenAt ?? null;
  const online = Boolean(
    configured && lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < RUNNER_ONLINE_MS,
  );
  return {
    configured,
    online,
    lastSeenAt,
    runnerId: runner?.id ?? '',
    instructions: configured
      ? 'Start the host runner in a terminal: cd backend && npm run runner. It opens a visible Chromium window and waits for queued applications.'
      : 'Set BROWSER_RUNNER_TOKEN in .env and restart the backend, then run the host runner (cd backend && npm run runner).',
  };
}

export async function runnerHeartbeat(input: { runnerId: string; version?: string }) {
  if (!env.BROWSER_RUNNER_TOKEN) {
    throw new AppError(503, 'RUNNER_DISABLED', 'Browser runner API is disabled (BROWSER_RUNNER_TOKEN is empty).');
  }
  await AppSettingModel.findOneAndUpdate(
    { key: 'global' },
    {
      $set: {
        'runner.id': input.runnerId,
        'runner.lastSeenAt': new Date(),
        'runner.version': input.version ?? '',
      },
    },
    { upsert: true },
  );
  return { ok: true };
}

export async function startAssistant(
  id: string,
  input: { confirmedLanguage?: boolean },
) {
  const application = await loadApplication(id);
  // Mandatory re-check immediately before starting the assistant. This recomputes the
  // calendar-month age from postedAt and re-checks language, availability and duplicates.
  await assertApplicationEligible(application, { verifyAvailability: true });
  const job = await JobModel.findById(application.job);
  if (!job) throw notFound('Job');
  if (!['READY_FOR_REVIEW', 'APPROVED', 'NEEDS_MANUAL_ACTION', 'FAILED'].includes(application.status)) {
    throw conflict(`The assistant cannot start for an application in ${application.status}.`);
  }
  if (job.status !== 'active') throw conflict('The vacancy is no longer active.');
  if (languageBlocked(job)) {
    throw conflict(
      'This vacancy mandates German and is excluded from the English-first assistant. Apply manually only if the original listing says otherwise.',
      { languageDecision: job.languageDecision, languageReason: job.languageReason },
    );
  }
  if (job.languageDecision === 'Needs Review' && input.confirmedLanguage !== true) {
    throw conflict(
      'The language requirement is ambiguous. Confirm that the original listing accepts English before starting the assistant.',
      { languageDecision: job.languageDecision, languageReason: job.languageReason },
    );
  }
  const status = workflowStatus(application);
  if (status === 'ASSISTANT_RUNNING') throw conflict('The assistant is already running for this application.');
  if (status === 'AWAITING_REVIEW') {
    throw conflict('The form is already filled and waiting for your review.');
  }

  if (!application.selectedCvDocument) throw conflict('No CV is selected for this application.');
  const cv = await DocumentModel.findById(application.selectedCvDocument);
  if (!cv || cv.missing) throw conflict('The selected CV is missing. Rescan documents first.');
  const letter = await CoverLetterModel.findById(application.currentLetter);
  if (!letter) throw conflict('The tailored cover letter is missing.');

  const wf = workflowOf(application);
  const previousStatus = wf.status;
  wf.status = 'READY_TO_APPLY';
  wf.startRequestedAt = new Date();
  wf.pauseRequested = false;
  wf.stopRequested = false;
  wf.runnerId = '';
  wf.runnerSeenAt = null;
  wf.lastError = '';
  wf.validationErrors = [];
  wf.unanswered = [];
  application.set('workflow.reviewFields', []);
  wf.fieldsDetected = 0;
  wf.fieldsFilled = 0;
  wf.filesUploaded = 0;
  wf.pageUrl = '';
  wf.pageTitle = '';
  wf.confirmation = {
    confirmedAt: null,
    method: '',
    evidence: '',
    confirmationId: '',
  };
  application.set('workflow.events', [
    ...(wf.events ?? []),
    {
      at: new Date(),
      type: 'start_requested',
      from: previousStatus,
      to: 'READY_TO_APPLY',
      source: 'user',
      message: 'User queued a human-supervised assistant session.',
    },
  ]);
  await application.save();
  return application;
}

export async function claimNextSession(runnerId: string) {
  if (!env.BROWSER_RUNNER_TOKEN) {
    throw new AppError(503, 'RUNNER_DISABLED', 'Browser runner API is disabled (BROWSER_RUNNER_TOKEN is empty).');
  }
  const staleBefore = new Date(Date.now() - RUNNER_STALE_MS);
  const application = await ApplicationModel.findOneAndUpdate(
    {
      'workflow.startRequestedAt': { $ne: null },
      'workflow.status': 'READY_TO_APPLY',
      'workflow.stopRequested': { $ne: true },
      $or: [
        { 'workflow.runnerId': '' },
        { 'workflow.runnerId': null },
        { 'workflow.runnerSeenAt': { $lt: staleBefore } },
        { 'workflow.runnerSeenAt': null },
      ],
    },
    {
      $set: {
        'workflow.status': 'ASSISTANT_RUNNING',
        'workflow.runnerId': runnerId,
        'workflow.runnerSeenAt': new Date(),
        'workflow.startedAt': new Date(),
      },
      $push: {
        'workflow.events': {
          at: new Date(),
          type: 'runner_claimed',
          message: `Runner ${runnerId} opened the application page.`,
        },
      },
    },
    { new: true, sort: { 'workflow.startRequestedAt': 1 } },
  );

  if (!application) return null;

  const job = await JobModel.findById(application.job);
  const profile = await CandidateProfileModel.findById(application.profile);
  const cv = await DocumentModel.findById(application.selectedCvDocument).select('+text');
  const letter = await CoverLetterModel.findById(application.currentLetter);
  if (!job || !profile || !cv || !letter) {
    workflowOf(application).status = 'NEEDS_INPUT';
    workflowOf(application).lastError = 'A selected CV, profile or cover letter is missing.';
    await application.save();
    return null;
  }

  return {
    applicationId: String(application._id),
    applicationUrl: job.applicationUrl || job.url,
    job: {
      id: String(job._id),
      title: job.title,
      employer: job.employer,
      location: job.location,
      url: job.url,
      applicationUrl: job.applicationUrl || job.url,
      source: job.source,
      description: job.description,
      languageDecision: job.languageDecision,
      languageReason: job.languageReason,
    },
    profile: {
      id: String(profile._id),
      name: profile.name,
      location: profile.location,
      languages: profile.languages ?? [],
      yearsExperience: profile.yearsExperience ?? null,
      skills: profile.skills ?? [],
      education: profile.education ?? [],
      experience: profile.experience ?? [],
    },
    candidate: contactFromText(cv.text ?? '', profile),
    coverLetter: {
      subjectLine: letter.subjectLine,
      letterText: letter.letterText,
    },
    screeningQuestions: application.screeningQuestions.map((question) => ({
      questionId: question.questionId,
      question: question.question,
      required: question.required,
      answer: question.status === 'answered' ? question.answer : '',
    })),
    files: {
      cv: `/automation/applications/${String(application._id)}/files/cv`,
      coverLetter: `/automation/applications/${String(application._id)}/files/cover-letter`,
    },
  };
}

export async function getAssistantControl(id: string, runnerId?: string): Promise<AssistantControl> {
  const application = await loadApplication(id);
  if (runnerId && application.workflow?.runnerId && application.workflow.runnerId !== runnerId) {
    throw conflict('This session is owned by a different browser runner.');
  }
  const wf = workflowOf(application);
  wf.runnerSeenAt = new Date();
  await application.save();
  return {
    pauseRequested: wf.pauseRequested ?? false,
    stopRequested: wf.stopRequested ?? false,
    status: wf.status as WorkflowStatus,
    fieldsDetected: wf.fieldsDetected ?? 0,
    fieldsFilled: wf.fieldsFilled ?? 0,
    filesUploaded: wf.filesUploaded ?? 0,
  };
}

export async function recordProgress(id: string, input: ProgressInput) {
  const application = await loadApplication(id);
  const wf = workflowOf(application);
  if (wf.runnerId && wf.runnerId !== input.runnerId) {
    throw conflict('This session is owned by a different browser runner.');
  }
  if (wf.status !== 'ASSISTANT_RUNNING' && wf.status !== 'NEEDS_INPUT') {
    throw conflict(`Cannot record assistant progress while the workflow is ${wf.status}.`);
  }

  wf.runnerSeenAt = new Date();
  if (typeof input.fieldsDetected === 'number') wf.fieldsDetected = input.fieldsDetected;
  if (typeof input.fieldsFilled === 'number') wf.fieldsFilled = input.fieldsFilled;
  if (typeof input.filesUploaded === 'number') wf.filesUploaded = input.filesUploaded;
  if (input.unanswered) wf.unanswered = input.unanswered.slice(0, 30);
  if (input.reviewFields) {
    application.set(
      'workflow.reviewFields',
      input.reviewFields.slice(0, 30).map((field) => ({
        label: field.label.slice(0, 200),
        reason: field.reason.slice(0, 300),
        fieldType: field.fieldType ?? '',
      })),
    );
  }
  if (input.validationErrors) wf.validationErrors = input.validationErrors.slice(0, 30);
  if (input.pageUrl) wf.pageUrl = input.pageUrl.slice(0, 500);
  if (input.pageTitle) wf.pageTitle = input.pageTitle.slice(0, 300);

  if (input.status === 'AWAITING_REVIEW' || input.status === 'NEEDS_INPUT') {
    wf.status = input.status;
    wf.pauseRequested = false;
  }
  wf.updatedAt = new Date();
  pushEvent(
    application,
    input.status ? 'paused' : 'progress',
    input.message ??
      (input.status === 'AWAITING_REVIEW'
        ? 'Form filled; waiting for the user to review and submit manually.'
        : 'Assistant progress updated.'),
  );
  await application.save();
  return application;
}

export async function requestAssistantControl(
  id: string,
  action: 'pause' | 'resume' | 'stop',
) {
  const application = await loadApplication(id);
  const wf = workflowOf(application);
  if (wf.status !== 'ASSISTANT_RUNNING' && wf.status !== 'NEEDS_INPUT') {
    throw conflict(`The assistant is not active (workflow: ${wf.status}).`);
  }
  if (action === 'pause') {
    wf.pauseRequested = true;
    pushEvent(application, 'pause_requested', 'User requested the assistant to pause.');
  } else if (action === 'resume') {
    wf.pauseRequested = false;
    wf.stopRequested = false;
    pushEvent(application, 'resume_requested', 'User resumed the assistant.');
  } else {
    wf.stopRequested = true;
    wf.pauseRequested = true;
    pushEvent(application, 'stop_requested', 'User asked the assistant to stop safely.');
  }
  wf.updatedAt = new Date();
  await application.save();
  return application;
}

export async function getFormSummary(id: string) {
  const application = await loadApplication(id);
  const job = await JobModel.findById(application.job);
  const profile = await CandidateProfileModel.findById(application.profile);
  const wf = workflowOf(application);
  return {
    applicationId: String(application._id),
    job: job ? { id: String(job._id), title: job.title, employer: job.employer } : null,
    profile: profile ? { id: String(profile._id), name: profile.name } : null,
    workflow: {
      status: wf.status,
      startedAt: wf.startedAt,
      updatedAt: wf.updatedAt,
      completedAt: wf.completedAt,
      runnerId: wf.runnerId,
      pauseRequested: wf.pauseRequested,
      stopRequested: wf.stopRequested,
      fieldsDetected: wf.fieldsDetected,
      fieldsFilled: wf.fieldsFilled,
      filesUploaded: wf.filesUploaded,
      unanswered: wf.unanswered,
      reviewFields: wf.reviewFields,
      validationErrors: wf.validationErrors,
      lastError: wf.lastError,
      pageUrl: wf.pageUrl,
      pageTitle: wf.pageTitle,
      confirmation: wf.confirmation,
      events: wf.events.slice(-30),
    },
    selectedDocuments: {
      cv: application.selectedCvDocument ?? null,
      coverLetter: application.selectedCoverLetterDocument ?? null,
      letterVersion: application.coverLetterHash ? application.version : null,
    },
  };
}

export async function confirmAssistantOutcome(
  id: string,
  input: {
    outcome: 'submitted' | 'applied_manually' | 'failed' | 'skipped';
    confirmationId?: string;
    evidence?: string;
    note?: string;
  },
) {
  const application = await loadApplication(id);
  const wf = workflowOf(application);
  const allowed: WorkflowStatus[] = ['ASSISTANT_RUNNING', 'AWAITING_REVIEW', 'NEEDS_INPUT'];
  if (!allowed.includes(wf.status as WorkflowStatus)) {
    throw conflict(
      `Outcome confirmation is only available while the assistant is running or awaiting review (current: ${wf.status}).`,
    );
  }

  if (input.outcome === 'submitted' || input.outcome === 'applied_manually') {
    if (application.status === 'SUBMITTED') {
      throw conflict('This application is already recorded as submitted.');
    }
    if (!input.evidence?.trim() && !input.confirmationId?.trim()) {
      throw badRequest(
        'Provide confirmation evidence (for example a confirmation number, email note, or what the page showed) before marking the application submitted.',
      );
    }
    const evidence = input.evidence?.trim() || `User-provided confirmation id: ${input.confirmationId}`;
    application.statusHistory.push({
      from: application.status,
      to: 'SUBMITTED',
      at: new Date(),
      reason: 'User confirmed the outcome of the supervised browser session',
    });
    application.status = 'SUBMITTED';
    application.appliedAt = new Date();
    const lastHistory = application.statusHistory[application.statusHistory.length - 1];
    if (lastHistory) lastHistory.source = 'user';
    application.set('submission', {
      ...(application.submission ?? {}),
      attemptedAt: new Date(),
      adapter: input.outcome === 'applied_manually' ? 'manual_user_confirmation' : 'supervised_browser_user_confirmation',
      confirmed: true,
      confirmationId: input.confirmationId?.trim() ?? '',
      message:
        input.outcome === 'applied_manually'
          ? 'The user completed and submitted the application manually in the browser.'
          : 'The user confirmed submitting the filled application in the visible browser.',
      evidence,
      simulated: false,
      manualInstructions: '',
      attempts: (application.submission?.attempts ?? 0) + 1,
      lastAttemptAt: new Date(),
    });
    wf.status = input.outcome === 'applied_manually' ? 'APPLIED_MANUALLY' : 'SUBMITTED';
  } else if (input.outcome === 'failed') {
    wf.status = 'SUBMISSION_FAILED';
    wf.lastError = input.evidence?.trim() || input.note?.trim() || 'The user reported a failed submission.';
  } else {
    wf.status = 'SKIPPED';
    if (application.status !== 'WITHDRAWN' && application.status !== 'SUBMITTED') {
      applyTransition(application, 'WITHDRAWN', 'User skipped this job after the assistant session.');
    }
  }

  wf.completedAt = new Date();
  wf.updatedAt = new Date();
  wf.confirmation = {
    confirmedAt: new Date(),
    method: input.outcome,
    evidence: input.evidence?.trim() ?? '',
    confirmationId: input.confirmationId?.trim() ?? '',
  };
  pushEvent(
    application,
    'outcome_confirmed',
    input.note?.trim() || `User recorded outcome: ${input.outcome}.`,
  );
  await application.save();
  return application;
}

export async function readCvFile(applicationId: string) {
  const application = await loadApplication(applicationId);
  const cv = await DocumentModel.findById(application.selectedCvDocument);
  if (!cv) throw notFound('Selected CV');
  const root = path.resolve(env.documentsPath);
  const absolute = path.resolve(root, cv.relativePath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw badRequest('The selected CV path is outside the documents folder.');
  }
  const data = await fs.readFile(absolute);
  const extension = path.extname(absolute).toLowerCase();
  return {
    data,
    filename: cv.filename || path.basename(absolute),
    contentType:
      extension === '.pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
}

export async function readCoverLetterFile(applicationId: string) {
  const application = await loadApplication(applicationId);
  const letter = await CoverLetterModel.findById(application.currentLetter);
  if (!letter) throw notFound('Cover letter');
  const profile = await CandidateProfileModel.findById(application.profile);
  const data = await renderLetterPdf({
    subjectLine: letter.subjectLine,
    letterText: letter.letterText,
    candidateName: profile?.name ?? '',
  });
  return {
    data,
    filename: coverLetterPdfFilename(application.employer),
    contentType: 'application/pdf',
  };
}

export function objectIdString(value: Types.ObjectId | string): string {
  return String(value);
}
