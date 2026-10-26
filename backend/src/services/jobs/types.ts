import type { ProfileKind, SearchCriteria, Seniority, WorkArrangement } from '../../config/defaults.js';
import type { AgeEligibility } from './age.js';

export type LanguageRequirement =
  | 'english_ok'
  | 'german_not_required'
  | 'german_required'
  | 'german_preferred'
  | 'unknown';

export type JobLanguage = 'English' | 'German' | 'Mixed' | 'Unknown';
export type LanguageDecision = 'Eligible' | 'Excluded' | 'Needs Review';

export interface JobListing {
  source: string;
  sourceJobId: string;
  sourceLabel: string;
  url: string;
  canonicalUrl: string;
  applicationUrl: string;
  employer: string;
  title: string;
  location: string;
  country: string;
  remote: boolean;
  workArrangement: WorkArrangement | 'unknown';
  employmentType: string;
  salary: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  tags: string[];
  description: string;
  descriptionHtml?: string;
  postedAt: Date | null;
  /** Calendar date (YYYY-MM-DD) in the source's own timezone, when the source provides one. */
  postedLocalDate?: string | null;
  expiresAt: Date | null;
  ageEligibility: AgeEligibility;
  eligibleAfter: Date | null;
  ageCheckAt: Date;
  ageReason: string;
  languageRequirement: LanguageRequirement;
  jobLanguage: JobLanguage;
  englishRequired: boolean | null;
  germanRequired: boolean | null;
  germanOptional: boolean | null;
  languageEvidence: string;
  languageConfidence: number;
  languageDecision: LanguageDecision;
  languageReason: string;
  seniority: Seniority | 'unknown';
  /** True only when the posting explicitly permits remote work from Germany; null if unstated. */
  remoteEligibleFromGermany?: boolean | null;
}

export interface JobSearchCriteria {
  countries: string[];
  remoteScope: string[];
  languages: string[];
  workArrangements: WorkArrangement[];
  seniority: Seniority[];
  targetTitles: string[];
  profileKinds: ProfileKind[];
  includeKeywords: string[];
  excludeKeywords: string[];
  excludeInternships: boolean;
  excludeUnpaid: boolean;
  /** Drop vacancies whose posting mandates German. Optional/preferred German and unclassified postings stay. */
  excludeGermanRequired: boolean;
  freshnessDays: number;
  maxAgeMonths: number;
  maxJobs: number;
}

export interface JobSourceAdapter {
  id: string;
  label: string;
  description: string;
  requiresConfiguration: boolean;
  isConfigured(): boolean;
  searchJobs(criteria: JobSearchCriteria): Promise<JobListing[]>;
  /** Optional: fetch fresh details for a single listing. Return null when unsupported. */
  getJobDetails?(sourceJobId: string): Promise<JobListing | null>;
  verifyJob?(listing: Pick<JobListing, 'url' | 'sourceJobId' | 'source'>): Promise<{
    status: 'available' | 'unavailable' | 'unknown';
    evidence: string;
  }>;
}

export interface SourceConfigStatus {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  requiresConfiguration: boolean;
  note: string;
}

export function criteriaFromSettings(
  search: SearchCriteria,
  overrides: Partial<JobSearchCriteria> = {},
): JobSearchCriteria {
  return {
    countries: search.countries,
    remoteScope: search.remoteScope,
    languages: search.languages,
    workArrangements: search.workArrangements,
    seniority: search.seniority,
    targetTitles: [],
    profileKinds: search.profileKinds,
    includeKeywords: search.includeKeywords,
    excludeKeywords: search.excludeKeywords,
    excludeInternships: search.excludeInternships,
    excludeUnpaid: search.excludeUnpaid,
    excludeGermanRequired: search.excludeGermanRequired,
    freshnessDays: search.freshnessDays,
    maxAgeMonths: search.maxAgeMonths,
    maxJobs: search.maxJobsPerRun,
    ...overrides,
  };
}
