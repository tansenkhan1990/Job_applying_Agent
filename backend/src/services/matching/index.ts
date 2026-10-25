import { Types } from 'mongoose';
import { JobModel } from '../../models/Job.js';
import { JobMatchModel } from '../../models/JobMatch.js';
import { CandidateProfileModel } from '../../models/CandidateProfile.js';
import { DocumentModel } from '../../models/Document.js';
import { PROMPT_VERSIONS, type AppSettings } from '../../config/defaults.js';
import { env } from '../../config/env.js';
import { getSettings, resolveModel } from '../settingsService.js';
import { notFound, badRequest, AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { truncate } from '../../utils/text.js';
import { aiMatchEvaluationSchema, type AiMatchEvaluation } from '../ai/schemas.js';
import { completeStructured, aiConfigured } from '../ai/client.js';
import { matchPrompt } from '../ai/prompts.js';
import { assessDeterministically, type DeterministicAssessment } from './deterministic.js';
import type { JobDoc, ProfileDoc } from '../../types/models.js';

export interface MatchOptions {
  profileIds?: string[];
  profileKinds?: string[];
  force?: boolean;
}

function profilePromptPayload(profile: {
  name?: string;
  targetTitles?: string[];
  skills?: string[];
  experienceSummary?: string;
  yearsExperience?: number | null;
  location?: string;
  languages?: Array<{ language: string; level: string }>;
  experience?: Array<{ title: string; employer: string; startDate?: string; endDate?: string; summary?: string }>;
  education?: Array<{ degree: string; institution: string; year?: string }>;
  certifications?: string[];
  projects?: Array<{ name: string; summary: string; technologies?: string[] }>;
  publications?: string[];
}): string {
  return truncate(
    JSON.stringify(
      {
        name: profile.name || 'unknown',
        targetTitles: profile.targetTitles ?? [],
        skills: profile.skills ?? [],
        experienceSummary: profile.experienceSummary || 'not provided',
        yearsExperience: profile.yearsExperience ?? 'unknown',
        location: profile.location || 'unknown',
        languages: profile.languages ?? [],
        experience: profile.experience ?? [],
        education: profile.education ?? [],
        certifications: profile.certifications ?? [],
        projects: profile.projects ?? [],
        publications: profile.publications ?? [],
      },
      null,
      2,
    ),
    3_500,
  );
}

function capScore(score: number, assessment: DeterministicAssessment): number {
  let capped = score;
  if (assessment.requirements.some((item) => item.status === 'missing')) capped = Math.min(capped, 55);
  if (assessment.mandatoryUnknown.length > 0) capped = Math.min(capped, 75);
  return Math.max(0, Math.min(100, Math.round(capped)));
}

function mergeUnique(first: string[], second: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of [...first, ...second]) {
    const key = item.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item.trim());
  }
  return result;
}

async function evaluateWithAi(input: {
  job: JobDoc;
  profile: ProfileDoc;
  assessment: DeterministicAssessment;
  cvText: string;
  settings: AppSettings;
  model: string;
}): Promise<AiMatchEvaluation | null> {
  if (!input.job || !input.profile) return null;
  if (!aiConfigured()) return null;
  if (!input.model) return null;

  const prompt = matchPrompt({
    candidateProfile: profilePromptPayload(input.profile),
    cvText: truncate(input.cvText || 'CV text unavailable; use only the structured profile.', 7_000),
    jobTitle: input.job.title,
    employer: input.job.employer,
    location: input.job.location,
    description: truncate(input.job.description ?? '', 7_500),
    targetTitles: input.profile.targetTitles ?? [],
    skills: input.profile.skills ?? [],
    languageRequirement: input.assessment.languageRequirement,
    seniorityCriteria: input.settings.search.seniority,
  });

  try {
    const result = await completeStructured({
      model: input.model,
      task: 'job match evaluation',
      system: prompt.system,
      user: prompt.user,
      schema: aiMatchEvaluationSchema,
      temperature: 0.1,
      maxTokens: 1_800,
    });
    return result.data;
  } catch (error) {
    logger.warn(
      {
        jobId: String(input.job._id),
        profileId: String(input.profile._id),
        error: error instanceof Error ? error.message : 'unknown',
      },
      'AI matching failed; using deterministic assessment',
    );
    return null;
  }
}

export async function matchJob(jobId: string, options: MatchOptions = {}) {
  const job = await JobModel.findById(jobId);
  if (!job) throw notFound('Job');

  const settings = await getSettings();
  const model = resolveModel(settings);

  const filter: Record<string, unknown> = {};
  if (options.profileIds?.length) filter._id = { $in: options.profileIds };
  else if (options.profileKinds?.length) filter.kind = { $in: options.profileKinds };
  else filter.kind = { $in: settings.search.profileKinds };

  const profiles = await CandidateProfileModel.find(filter);
  if (profiles.length === 0) throw badRequest('No matching candidate profiles found');

  const results = [];

  for (const profile of profiles) {
    const assessment = assessDeterministically(job, profile, settings.search);
    const cvDoc = profile.cvDocument
      ? await DocumentModel.findById(profile.cvDocument).select('+text')
      : null;
    const cvText = cvDoc?.text ?? '';

    const ai = await evaluateWithAi({ job, profile, assessment, cvText, settings, model });

    let score = assessment.score;
    let explanation = assessment.explanation;
    let matchedSkills = assessment.matchedSkills;
    let missingSkills = assessment.missingSkills;
    let strengths = assessment.strengths;
    let concerns = [...assessment.concerns];
    let mandatoryUnknown = [...assessment.mandatoryUnknown];
    let promptInjectionDetected = false;
    let reviewRequired = assessment.reviewRequired;
    let languageAssessment = assessment.languageAssessment;
    let aiScore: number | null = null;

    if (ai) {
      aiScore = Math.round(ai.score);
      score = capScore(Math.round(ai.score * 0.6 + assessment.score * 0.4), assessment);
      promptInjectionDetected = ai.promptInjectionDetected;
      reviewRequired = reviewRequired || ai.promptInjectionDetected;
      matchedSkills = mergeUnique(ai.matchedSkills, assessment.matchedSkills);
      missingSkills = mergeUnique(ai.missingSkills, assessment.missingSkills);
      strengths = mergeUnique(ai.strengths, assessment.strengths).slice(0, 6);
      concerns = mergeUnique(ai.concerns, assessment.concerns).slice(0, 8);
      mandatoryUnknown = mergeUnique(ai.mandatoryUnknown, assessment.mandatoryUnknown);
      explanation = ai.explanation;
      languageAssessment = {
        requiredLanguage: ai.languageAssessment.requiredLanguage ?? '',
        mandatory: ai.languageAssessment.mandatory,
        candidateMeets: ai.languageAssessment.candidateMeets,
      };
      if (ai.recommendedProfileKind && ai.recommendedProfileKind !== profile.kind) {
        concerns = mergeUnique(concerns, [
          `The AI evaluator considered "${ai.recommendedProfileKind}" a closer profile for this vacancy.`,
        ]).slice(0, 8);
      }
      if (ai.mandatoryRequirementsMet === false) {
        score = Math.min(score, 55);
        reviewRequired = true;
      }
      if (ai.mandatoryRequirementsMet === null || mandatoryUnknown.length > 0) {
        score = Math.min(score, 75);
        reviewRequired = true;
      }
      if (promptInjectionDetected) {
        concerns = mergeUnique(concerns, [
          'The job text contains instructions aimed at the AI. They were ignored and this match needs manual review.',
        ]).slice(0, 8);
        score = Math.min(score, 50);
      }
    } else if (!aiConfigured() || !model) {
      concerns = mergeUnique(concerns, [
        'AI evaluation is unavailable, so this score uses deterministic rules only.',
      ]).slice(0, 8);
    } else {
      concerns = mergeUnique(concerns, [
        'AI evaluation failed; this score uses deterministic rules only.',
      ]).slice(0, 8);
    }

    if (mandatoryUnknown.length > 0) score = Math.min(score, 75);
    if (assessment.requirements.some((item) => item.status === 'missing')) score = Math.min(score, 55);

    const eligibleForPreparation =
      score >= settings.application.minScoreToPrepare &&
      reviewRequired === false &&
      mandatoryUnknown.length === 0 &&
      Boolean(profile.cvDocument) &&
      profile.status === 'approved';

    const doc = await JobMatchModel.findOneAndUpdate(
      { job: job._id, profile: profile._id },
      {
        $set: {
          profileKind: profile.kind,
          jobTitle: job.title,
          employer: job.employer,
          score,
          deterministicScore: assessment.score,
          aiScore,
          scoreBreakdown: assessment.breakdown,
          matchedSkills: matchedSkills.slice(0, 30),
          missingSkills: missingSkills.slice(0, 30),
          strengths,
          concerns,
          explanation: explanation.slice(0, 2000),
          mandatoryRequirements: assessment.requirements.slice(0, 12),
          mandatoryUnknown: mandatoryUnknown.slice(0, 10),
          languageRequirement: assessment.languageRequirement,
          languageAssessment,
          promptInjectionDetected,
          recommendedCvDocument: profile.cvDocument ?? null,
          recommendedCoverLetterDocument: profile.coverLetterDocument ?? null,
          recommendedProfileKind: profile.kind,
          eligibleForPreparation,
          reviewRequired,
          model: ai ? model : 'deterministic',
          promptVersion: ai ? PROMPT_VERSIONS.match : 'deterministic-v1',
          evaluationSource: ai ? 'openrouter' : 'deterministic',
          evaluatedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    // Keep the job-level language classification in sync with the assessment.
    await JobModel.updateOne(
      { _id: job._id },
      { $set: { languageRequirement: assessment.languageRequirement } },
    );

    results.push(doc);
  }

  return results;
}

export async function matchJobsBatch(jobIds: string[], options: MatchOptions = {}) {
  const results: Array<{ jobId: string; matches: number; error?: string }> = [];
  for (const jobId of jobIds) {
    try {
      const matches = await matchJob(jobId, options);
      results.push({ jobId, matches: matches.length });
    } catch (error) {
      results.push({
        jobId,
        matches: 0,
        error: error instanceof AppError ? error.message : 'Matching failed',
      });
    }
  }
  return results;
}

export async function bestMatchForJob(jobId: string) {
  return JobMatchModel.findOne({ job: jobId }).sort({ score: -1 });
}

export function toObjectId(id: string): Types.ObjectId {
  return new Types.ObjectId(id);
}
