import { z } from 'zod';
import { PROFILE_KINDS, SENIORITY_LEVELS, WORK_ARRANGEMENTS } from './config/defaults.js';

export const objectIdSchema = z
  .string()
  .regex(/^[a-fA-F0-9]{24}$/, 'Expected a 24-character MongoDB id');

export const profileKindSchema = z.enum(PROFILE_KINDS);
export const workArrangementSchema = z.enum([...WORK_ARRANGEMENTS, 'unknown']);
export const senioritySchema = z.enum(SENIORITY_LEVELS);

export const searchCriteriaSchema = z.object({
  countries: z.array(z.string().min(1).max(80)).max(20),
  remoteScope: z.array(z.string().min(1).max(80)).max(20),
  languages: z.array(z.string().min(1).max(40)).max(10),
  workArrangements: z.array(z.enum(WORK_ARRANGEMENTS)).max(3),
  profileKinds: z.array(profileKindSchema).max(3),
  seniority: z.array(senioritySchema).max(4),
  minRelevanceScore: z.number().min(0).max(100),
  maxJobsPerRun: z.number().int().min(1).max(200),
  freshnessDays: z.number().int().min(30).max(3650),
  // Hard product rule: professional jobs older than three calendar months are never shown.
  maxAgeMonths: z.number().int().min(1).max(3),
  excludeInternships: z.boolean(),
  excludeUnpaid: z.boolean(),
  excludeGermanRequired: z.boolean(),
  excludeKeywords: z.array(z.string().min(1).max(80)).max(50),
  includeKeywords: z.array(z.string().min(1).max(80)).max(50),
  targetTitles: z.array(z.string().min(2).max(120)).max(50),
  sources: z.record(z.string(), z.boolean()),
});

export const phdSearchCriteriaSchema = z.object({
  countries: z.array(z.string().min(1).max(80)).max(20),
  includeEuRemote: z.boolean(),
  excludeGermanRequired: z.boolean(),
  maxPositionsPerRun: z.number().int().min(1).max(200),
});

export const settingsSchema = z.object({
  ai: z.object({
    model: z.string().max(200),
    temperature: z.number().min(0).max(1),
    maxOutputTokens: z.number().int().min(256).max(8000),
  }),
  search: searchCriteriaSchema,
  phd: phdSearchCriteriaSchema,
  schedule: z.object({
    enabled: z.boolean(),
    intervalMinutes: z.number().int().min(15).max(1440),
    runOnStartup: z.boolean(),
  }),
  sources: z.record(z.string(), z.object({ enabled: z.boolean() })),
});

export const settingsPatchSchema = z
  .object({
    ai: settingsSchema.shape.ai.partial().optional(),
    search: searchCriteriaSchema.partial().optional(),
    phd: phdSearchCriteriaSchema.partial().optional(),
    schedule: settingsSchema.shape.schedule.partial().optional(),
    sources: z.record(z.string(), z.object({ enabled: z.boolean() })).optional(),
  })
  .strict();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const profileUpdateSchema = z
  .object({
    name: z.string().max(120).optional(),
    targetTitles: z.array(z.string().min(2).max(120)).max(30).optional(),
    skills: z.array(z.string().min(1).max(80)).max(100).optional(),
    experienceSummary: z.string().max(4000).optional(),
    yearsExperience: z.number().min(0).max(60).nullable().optional(),
    location: z.string().max(120).optional(),
    status: z.enum(['draft', 'approved']).optional(),
    languages: z
      .array(
        z.object({
          language: z.string().min(2).max(40),
          level: z.string().max(40).default('unknown'),
        }),
      )
      .max(15)
      .optional(),
    experience: z
      .array(
        z.object({
          title: z.string().min(1).max(160),
          employer: z.string().min(1).max(160),
          startDate: z.string().max(30).optional(),
          endDate: z.string().max(30).optional(),
          summary: z.string().max(1200).optional(),
        }),
      )
      .max(30)
      .optional(),
    education: z
      .array(
        z.object({
          degree: z.string().max(160),
          institution: z.string().max(160),
          year: z.string().max(20).optional(),
        }),
      )
      .max(20)
      .optional(),
    certifications: z.array(z.string().max(160)).max(30).optional(),
    projects: z
      .array(
        z.object({
          name: z.string().max(160),
          summary: z.string().max(800),
          technologies: z.array(z.string().max(80)).max(30).optional(),
        }),
      )
      .max(30)
      .optional(),
    publications: z.array(z.string().max(300)).max(30).optional(),
    workPreferences: z
      .object({
        countries: z.array(z.string().max(80)).max(20).optional(),
        remote: z.boolean().optional(),
        hybrid: z.boolean().optional(),
        onsite: z.boolean().optional(),
        languages: z.array(z.string().max(40)).max(10).optional(),
      })
      .optional(),
  })
  .strict();

export const documentMappingSchema = z
  .object({
    docType: z.enum(['cv', 'cover_letter', 'unknown']),
    profileKind: z.enum([...PROFILE_KINDS, 'unassigned']),
    mappingReviewed: z.boolean().optional(),
  })
  .strict();

export const jobSearchSchema = z
  .object({
    sources: z.array(z.string().min(1).max(40)).max(10).optional(),
    keywords: z.array(z.string().min(1).max(80)).max(10).optional(),
    maxJobs: z.number().int().min(1).max(200).optional(),
  })
  .strict()
  .default({});

export const matchRequestSchema = z
  .object({
    profileIds: z.array(objectIdSchema).max(3).optional(),
    profileKinds: z.array(profileKindSchema).max(3).optional(),
    force: z.boolean().optional(),
  })
  .strict()
  .default({});

export const coverLetterEditSchema = z
  .object({
    letterText: z.string().min(50).max(20_000),
    subjectLine: z.string().max(300).optional(),
  })
  .strict();

export const regenCoverLetterSchema = z
  .object({
    instructions: z.string().max(1000).optional(),
  })
  .strict()
  .default({});

