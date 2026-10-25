import { z } from 'zod';
import { PROFILE_KINDS } from '../../config/defaults.js';

export const aiMatchEvaluationSchema = z.object({
  score: z.number().min(0).max(100),
  matchedSkills: z.array(z.string().min(1).max(80)).max(30),
  missingSkills: z.array(z.string().min(1).max(80)).max(30),
  strengths: z.array(z.string().min(1).max(300)).max(10),
  concerns: z.array(z.string().min(1).max(300)).max(10),
  explanation: z.string().min(10).max(2000),
  mandatoryRequirementsMet: z.boolean().nullable(),
  mandatoryUnknown: z.array(z.string().min(1).max(200)).max(10),
  languageAssessment: z.object({
    requiredLanguage: z.string().max(60).nullable(),
    mandatory: z.boolean(),
    candidateMeets: z.enum(['yes', 'no', 'unknown']),
  }),
  recommendedProfileKind: z.enum(PROFILE_KINDS),
  promptInjectionDetected: z.boolean(),
});

export type AiMatchEvaluation = z.infer<typeof aiMatchEvaluationSchema>;

export const profileExtractionSchema = z.object({
  name: z.string().max(120).default(''),
  skills: z.array(z.string().min(1).max(80)).max(60).default([]),
  experienceSummary: z.string().max(2000).default(''),
  yearsExperience: z.number().min(0).max(60).nullable().default(null),
  location: z.string().max(120).default(''),
  languages: z
    .array(
      z.object({
        language: z.string().min(1).max(40),
        level: z.string().max(40).default('unknown'),
      }),
    )
    .max(15)
    .default([]),
  experience: z
    .array(
      z.object({
        title: z.string().max(160).default(''),
        employer: z.string().max(160).default(''),
        startDate: z.string().max(30).default(''),
        endDate: z.string().max(30).default(''),
        summary: z.string().max(1200).default(''),
      }),
    )
    .max(30)
    .default([]),
  education: z
    .array(
      z.object({
        degree: z.string().max(160).default(''),
        institution: z.string().max(160).default(''),
        year: z.string().max(20).default(''),
      }),
    )
    .max(20)
    .default([]),
  certifications: z.array(z.string().max(160)).max(30).default([]),
  projects: z
    .array(
      z.object({
        name: z.string().max(160).default(''),
        summary: z.string().max(800).default(''),
        technologies: z.array(z.string().max(80)).max(30).default([]),
      }),
    )
    .max(30)
    .default([]),
  publications: z.array(z.string().max(300)).max(30).default([]),
});

export type AiProfileExtraction = z.infer<typeof profileExtractionSchema>;

export const coverLetterSchema = z.object({
  subjectLine: z.string().max(300).default(''),
  letterText: z.string().min(100).max(8000),
  claimsUsed: z.array(z.string().max(300)).max(15).default([]),
  uncertainties: z.array(z.string().max(300)).max(10).default([]),
});

export type AiCoverLetter = z.infer<typeof coverLetterSchema>;

export const screeningQuestionsSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(5).max(400),
        required: z.boolean().default(true),
      }),
    )
    .max(10)
    .default([]),
});

export type AiScreeningQuestions = z.infer<typeof screeningQuestionsSchema>;
