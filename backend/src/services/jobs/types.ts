import type { ProfileKind, SearchCriteria, Seniority, WorkArrangement } from '../../config/defaults.js';

export type LanguageRequirement = 'english_ok' | 'german_required' | 'german_preferred' | 'unknown';

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
  tags: string[];
  description: string;
  descriptionHtml?: string;
  postedAt: Date | null;
  expiresAt: Date | null;
  languageRequirement: LanguageRequirement;
  seniority: Seniority | 'unknown';
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
  freshnessDays: number;
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
    freshnessDays: search.freshnessDays,
    maxJobs: search.maxJobsPerRun,
    ...overrides,
  };
}
