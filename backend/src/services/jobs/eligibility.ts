import { ApplicationModel } from '../../models/Application.js';
import { JobModel } from '../../models/Job.js';
import { JobMatchModel } from '../../models/JobMatch.js';
import { CandidateProfileModel } from '../../models/CandidateProfile.js';
import { getSettings } from '../settingsService.js';
import { verifyJobAvailability } from './verify.js';
import { assessJobAge, type AgeEligibility } from './age.js';
import { conflict, notFound } from '../../utils/errors.js';
import type { ApplicationDoc, JobDoc } from '../../types/models.js';

export interface EligibilityBlocker {
  code: string;
  message: string;
}

export interface EligibilityResult {
  eligible: boolean;
  checkedAt: Date;
  ageEligibility: AgeEligibility;
  eligibleAfter: Date | null;
  ageReason: string;
  blockers: EligibilityBlocker[];
  warnings: string[];
}

function sortUnique(messages: string[]): string[] {
  return [...new Set(messages.filter(Boolean))];
}

async function persistAge(job: JobDoc, result: EligibilityResult): Promise<void> {
  const changed =
    job.ageEligibility !== result.ageEligibility ||
    String(job.eligibleAfter ?? '') !== String(result.eligibleAfter ?? '');
  job.ageEligibility = result.ageEligibility;
  job.eligibleAfter = result.eligibleAfter;
  job.ageCheckAt = result.checkedAt;
  job.ageReason = result.ageReason;
  if (changed || result.checkedAt) {
    await JobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          ageEligibility: result.ageEligibility,
          eligibleAfter: result.eligibleAfter,
          ageCheckAt: result.checkedAt,
          ageReason: result.ageReason,
        },
      },
    );
  }
}

/**
 * Full eligibility gate for starting the supervised application assistant.
 * Recomputes the posting age from the original posting date and optionally checks that the
 * listing is still reachable. This runs immediately before browser automation starts; it
 * never relies on the age classification stored at discovery time.
 */
export async function evaluateJobEligibility(
  job: JobDoc,
  options: { verifyAvailability?: boolean } = {},
): Promise<EligibilityResult> {
  const settings = await getSettings();
  const checkedAt = new Date();
  const age = assessJobAge({
    postedAt: job.postedAt,
    postedLocalDate: job.postedLocalDate,
    expiresAt: job.expiresAt,
    status: job.status,
    months: settings.search.minAgeMonths,
    now: checkedAt,
  });
  const blockers: EligibilityBlocker[] = [];
  const warnings: string[] = [];

  if (job.status !== 'active') {
    blockers.push({
      code: 'JOB_INACTIVE',
      message: `The vacancy is marked "${job.status}" and is not accepting applications.`,
    });
  }

  if (age.ageEligibility === 'Expired') {
    blockers.push({ code: 'AGE_EXPIRED', message: age.ageReason });
  } else if (age.ageEligibility === 'Too Recent') {
    blockers.push({ code: 'AGE_TOO_RECENT', message: age.ageReason });
  } else if (age.ageEligibility === 'Unknown') {
    blockers.push({ code: 'AGE_UNKNOWN', message: age.ageReason });
  }

  if (job.languageDecision === 'Excluded' || job.languageRequirement === 'german_required') {
    blockers.push({
      code: 'LANGUAGE_EXCLUDED',
      message: `German is mandatory for this posting. ${job.languageReason}`.trim(),
    });
  } else if (job.languageDecision === 'Needs Review') {
    warnings.push(`Language needs your review: ${job.languageReason}`);
  }

  if (options.verifyAvailability) {
    const availability = await verifyJobAvailability(String(job._id));
    if (availability.status === 'unavailable') {
      blockers.push({
        code: 'JOB_UNAVAILABLE',
        message: `The listing no longer appears available: ${availability.evidence}`,
      });
    } else if (availability.status === 'unknown') {
      warnings.push(`Availability could not be confirmed: ${availability.evidence}`);
    }
  }

  const result: EligibilityResult = {
    eligible: blockers.length === 0,
    checkedAt,
    ageEligibility: age.ageEligibility,
    eligibleAfter: age.eligibleAfter,
    ageReason: age.ageReason,
    blockers,
    warnings: sortUnique(warnings),
  };
  await persistAge(job, result);
  return result;
}

export async function assertJobEligible(
  job: JobDoc,
  options: { verifyAvailability?: boolean } = {},
): Promise<EligibilityResult> {
  const result = await evaluateJobEligibility(job, options);
  if (!result.eligible) {
    throw conflict('This job is not eligible for the application workflow.', {
      ageEligibility: result.ageEligibility,
      ageReason: result.ageReason,
      blockers: result.blockers,
    });
  }
  return result;
}

/**
 * Application-level gate used by the queue and the assistant start endpoint.
 * Includes the job checks, the stored document state and duplicate protection.
 */
export async function evaluateApplicationEligibility(
  application: ApplicationDoc,
  options: { verifyAvailability?: boolean } = {},
): Promise<EligibilityResult> {
  const job = await JobModel.findById(application.job);
  if (!job) throw notFound('Job');

  const base = await evaluateJobEligibility(job, options);
  const blockers = [...base.blockers];
  const warnings = [...base.warnings];

  if (application.status === 'SUBMITTED' || application.appliedAt) {
    blockers.push({
      code: 'ALREADY_SUBMITTED',
      message: 'This application is already recorded as submitted. It will never be submitted again.',
    });
  }
  if (['SUBMITTING', 'WITHDRAWN'].includes(application.status)) {
    blockers.push({
      code: 'APPLICATION_STATE',
      message: `The application is in state ${application.status}.`,
    });
  }

  const duplicate = await ApplicationModel.findOne({
    _id: { $ne: application._id },
    $and: [
      { $or: [{ job: application.job }, { duplicateKey: application.duplicateKey }] },
      { $or: [{ status: { $in: ['SUBMITTED', 'SUBMITTING'] } }, { appliedAt: { $ne: null } }] },
    ],
  });
  if (duplicate) {
    blockers.push({
      code: 'DUPLICATE_APPLICATION',
      message: `Another application for this employer/title was already submitted on ${
        duplicate.appliedAt?.toISOString().slice(0, 10) ?? 'an earlier date'
      }.`,
    });
  }

  if (application.match) {
    const match = await JobMatchModel.findById(application.match);
    if (match) {
      const settings = await getSettings();
      if (match.score < settings.application.minScoreToPrepare) {
        blockers.push({
          code: 'MATCH_BELOW_THRESHOLD',
          message: `The stored match score (${match.score}) is below the preparation threshold (${settings.application.minScoreToPrepare}).`,
        });
      }
    } else {
      warnings.push('The stored match record is missing; the profile fit could not be re-checked.');
    }
  } else {
    warnings.push('No match record is linked to this application.');
  }

  const profile = await CandidateProfileModel.findById(application.profile);
  if (!profile) {
    blockers.push({ code: 'PROFILE_MISSING', message: 'The candidate profile no longer exists.' });
  } else if (profile.status !== 'approved') {
    blockers.push({
      code: 'PROFILE_NOT_APPROVED',
      message: 'The candidate profile is not approved.',
    });
  }

  return {
    ...base,
    eligible: blockers.length === 0,
    blockers,
    warnings: sortUnique(warnings),
  };
}

export async function assertApplicationEligible(
  application: ApplicationDoc,
  options: { verifyAvailability?: boolean } = {},
): Promise<EligibilityResult> {
  const result = await evaluateApplicationEligibility(application, options);
  if (!result.eligible) {
    throw conflict('This application is not eligible to start the assistant.', {
      ageEligibility: result.ageEligibility,
      ageReason: result.ageReason,
      blockers: result.blockers,
      warnings: result.warnings,
    });
  }
  return result;
}
