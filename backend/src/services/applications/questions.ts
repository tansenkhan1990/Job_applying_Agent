import { z } from 'zod';
import type { CandidateProfileRecord } from '../../models/CandidateProfile.js';
import type { JobDoc } from '../../types/models.js';
import { env } from '../../config/env.js';
import { aiConfigured, completeStructured } from '../ai/client.js';
import { screeningQuestionPrompt } from '../ai/prompts.js';
import { screeningQuestionsSchema } from '../ai/schemas.js';
import { getSettings, resolveModel } from '../settingsService.js';
import { logger } from '../../utils/logger.js';
import { sha256 } from '../../utils/hash.js';
import { truncate } from '../../utils/text.js';

export interface ExtractedQuestion {
  questionId: string;
  question: string;
  required: boolean;
  answer: string;
  status: 'answered' | 'requires_user' | 'unknown';
  source: 'job_description' | 'manual';
}

const SENSITIVE_QUESTION =
  /\b(visa|authoriz|authoris|work permit|right to work|salary|compensation|gehalt|clearance|criminal|conviction|disabilit|gender|ethnic|race|religio|marital|date of birth|notice period|kündigungsfrist)\b/i;

function heuristicQuestions(description: string): Array<{ question: string; required: boolean }> {
  if (!description) return [];
  const sentences = description
    .replace(/\s+/g, ' ')
    .split(/(?<=\?)\s+|(?<=\.)\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const results: Array<{ question: string; required: boolean }> = [];
  for (const sentence of sentences) {
    const isQuestion = sentence.endsWith('?');
    const isPrompt = /^(please (answer|provide|state|confirm|describe)|answer the following)/i.test(sentence);
    if (!isQuestion && !isPrompt) continue;
    const question = sentence.replace(/^(please\s+)?/i, '').trim().slice(0, 300);
    if (question.length < 12) continue;
    results.push({
      question,
      required: /\b(required|must|mandatory|please)\b/i.test(sentence),
    });
    if (results.length >= 5) break;
  }
  return results;
}

function buildQuestion(question: string, required: boolean, profile: CandidateProfileRecord): ExtractedQuestion {
  const questionId = sha256(question).slice(0, 16);
  const normalized = question.toLowerCase();

  if (SENSITIVE_QUESTION.test(question)) {
    return {
      questionId,
      question,
      required,
      answer: '',
      status: 'requires_user',
      source: 'job_description',
    };
  }

  if (/\b(how many years|years of (professional )?experience|jahre berufserfahrung)\b/.test(normalized)) {
    const mentionsTech = (profile.skills ?? []).some((skill) => normalized.includes(skill.toLowerCase()));
    if (!mentionsTech && profile.yearsExperience !== null && profile.yearsExperience !== undefined) {
      return {
        questionId,
        question,
        required,
        answer: String(profile.yearsExperience),
        status: 'answered',
        source: 'job_description',
      };
    }
  }

  return {
    questionId,
    question,
    required,
    answer: '',
    status: 'unknown',
    source: 'job_description',
  };
}

export async function extractScreeningQuestions(
  job: JobDoc,
  profile: CandidateProfileRecord,
): Promise<ExtractedQuestion[]> {
  const description = job.description ?? '';
  const questions: Array<{ question: string; required: boolean }> = [];

  const settings = await getSettings();
  const model = resolveModel(settings);

  if (aiConfigured() && model && /\?|please (answer|provide)/i.test(description)) {
    try {
      const prompt = screeningQuestionPrompt(job.title, truncate(description, 8_000));
      const result = await completeStructured({
        model,
        task: 'screening questions',
        system: prompt.system,
        user: prompt.user,
        schema: screeningQuestionsSchema,
        temperature: 0,
        maxTokens: 800,
      });
      questions.push(...result.data.questions);
    } catch (error) {
      logger.warn(
        { jobId: String(job._id), error: error instanceof Error ? error.message : 'unknown' },
        'AI screening question extraction failed; using heuristics',
      );
    }
  }

  if (questions.length === 0) questions.push(...heuristicQuestions(description));

  const seen = new Set<string>();
  const output: ExtractedQuestion[] = [];
  for (const item of questions) {
    const key = item.question.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(buildQuestion(item.question.trim(), item.required, profile));
    if (output.length >= 10) break;
  }
  return output;
}

export const answerSchemaForQuestion = z.string().max(3000);

export function unansweredRequired(
  questions: Array<{ required: boolean; status: string; answer: string }>,
): number {
  return questions.filter((question) => question.required && question.status !== 'answered').length;
}

export function isAiEnabledForQuestions(): boolean {
  return env.aiConfigured;
}
