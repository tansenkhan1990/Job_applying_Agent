export type ProfileKind = 'full_stack' | 'ai_engineer' | 'devops_cloud';
export type ProfileKindOrUnassigned = ProfileKind | 'unassigned';
export type WorkArrangement = 'remote' | 'hybrid' | 'onsite' | 'unknown';
export type ApplicationStatus =
  | 'DISCOVERED'
  | 'MATCHED'
  | 'READY_FOR_REVIEW'
  | 'APPROVED'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'FAILED'
  | 'NEEDS_MANUAL_ACTION'
  | 'WITHDRAWN';

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export interface SettingsResponse {
  settings: AppSettings;
  sources: SourceStatus[];
  ai: AiStatus;
}

export interface AppSettings {
  ai: { model: string; temperature: number; maxOutputTokens: number };
  search: {
    countries: string[];
    remoteScope: string[];
    languages: string[];
    workArrangements: Array<'remote' | 'hybrid' | 'onsite'>;
    profileKinds: ProfileKind[];
    seniority: Array<'junior' | 'mid' | 'senior' | 'lead'>;
    minRelevanceScore: number;
    maxJobsPerRun: number;
    freshnessDays: number;
    excludeInternships: boolean;
    excludeUnpaid: boolean;
    excludeKeywords: string[];
    includeKeywords: string[];
    sources: Record<string, boolean>;
  };
  schedule: { enabled: boolean; intervalMinutes: number; runOnStartup: boolean };
  application: {
    mode: 'approval_required' | 'prepare_only';
    maxDailyApplications: number;
    minScoreToPrepare: number;
    allowMockSubmission: boolean;
  };
  sources: Record<string, { enabled: boolean }>;
}

export interface AiStatus {
  configured: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  envModel: string;
  deterministicFallback: boolean;
  limits: {
    timeoutMs: number;
    maxRetries: number;
    maxOutputTokens: number;
    maxInputChars: number;
  };
}

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength: number | null;
  pricing: Record<string, string> | null;
  supportedParameters: string[];
  description: string;
}

export interface SourceStatus {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  configured: boolean;
  requiresConfiguration: boolean;
  note: string;
}

export interface AiTestResult {
  ok: boolean;
  configured: boolean;
  model: string;
  message: string;
  reply?: string;
  code?: string;
}

export interface DocumentMeta {
  id: string;
  filename: string;
  relativePath: string;
  extension: string;
  docType: 'cv' | 'cover_letter' | 'unknown';
  profileKind: ProfileKindOrUnassigned;
  mappingSource: 'auto' | 'manual' | 'none';
  mappingReviewed: boolean;
  sizeBytes: number;
  contentHash: string;
  textPreview: string;
  pageCount: number;
  wordCount: number;
  status: 'pending' | 'processed' | 'needs_ocr' | 'failed' | 'unsupported' | 'missing';
  error: string;
  missing: boolean;
  parsedWith: string;
  lastScannedAt: string;
  updatedAt: string;
}

export interface DocumentsResponse {
  documents: DocumentMeta[];
  folder: { configuredPath: string; readable: boolean; filesFound: number; maxSizeMb: number };
  counts: {
    total: number;
    processed: number;
    needsOcr: number;
    failed: number;
    missing: number;
    unmapped: number;
  };
}

export interface RescanSummary {
  rootExists: boolean;
  scanned: number;
  added: number;
  updated: number;
  unchanged: number;
  missing: number;
  needsOcr: number;
  failed: number;
  autoMapped: number;
  durationMs: number;
  truncated: boolean;
  warnings: string[];
}

export interface CandidateProfile {
  id: string;
  kind: ProfileKind;
  label: string;
  name: string;
  targetTitles: string[];
  skills: string[];
  experienceSummary: string;
  yearsExperience: number | null;
  location: string;
  languages: Array<{ language: string; level: string }>;
  experience: Array<{
    title: string;
    employer: string;
    startDate?: string;
    endDate?: string;
    summary?: string;
  }>;
  education: Array<{ degree: string; institution: string; year?: string }>;
  projects: Array<{ name: string; summary: string; technologies?: string[] }>;
  certifications: string[];
  publications: string[];
  workPreferences: {
    countries: string[];
    remote: boolean;
    hybrid: boolean;
    onsite: boolean;
    languages: string[];
  };
  cvDocument: string | null;
  coverLetterDocument: string | null;
  cvDocumentInfo?: DocumentMeta | null;
  coverLetterDocumentInfo?: DocumentMeta | null;
  status: 'draft' | 'approved';
  extractionSource: 'default' | 'ai' | 'heuristic' | 'manual';
  extractionModel: string;
  extractedAt: string | null;
  updatedAt: string;
}

export interface JobMatch {
  id: string;
  job: string | Job;
  profile: string | Pick<CandidateProfile, 'id' | 'label' | 'kind' | 'status'>;
  profileKind: ProfileKind;
  jobTitle: string;
  employer: string;
  score: number;
  deterministicScore: number;
  aiScore: number | null;
  scoreBreakdown: { title: number; skills: number; seniority: number; location: number };
  matchedSkills: string[];
  missingSkills: string[];
  strengths: string[];
  concerns: string[];
  explanation: string;
  mandatoryRequirements: Array<{
    label: string;
    status: 'met' | 'missing' | 'unknown' | 'preferred_missing';
    detail: string;
  }>;
  mandatoryUnknown: string[];
  languageRequirement: 'english_ok' | 'german_required' | 'german_preferred' | 'unknown';
  languageAssessment: { requiredLanguage: string; mandatory: boolean; candidateMeets: string };
  promptInjectionDetected: boolean;
  recommendedCvDocument: string | null;
  recommendedCoverLetterDocument: string | null;
  eligibleForPreparation: boolean;
  reviewRequired: boolean;
  model: string;
  promptVersion: string;
  evaluationSource: 'openrouter' | 'deterministic';
  evaluatedAt: string;
}

export interface Job {
  id: string;
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
  workArrangement: WorkArrangement;
  employmentType: string;
  salary: string;
  tags: string[];
  description?: string;
  descriptionPreview?: string;
  postedAt: string | null;
  discoveredAt: string;
  lastVerifiedAt: string | null;
  expiresAt: string | null;
  status: 'active' | 'expired' | 'unavailable' | 'duplicate';
  statusNote: string;
  languageRequirement: 'english_ok' | 'german_required' | 'german_preferred' | 'unknown';
  seniority: 'junior' | 'mid' | 'senior' | 'lead' | 'unknown';
  bestMatch?: JobMatch | null;
  application?: {
    id: string;
    status: ApplicationStatus;
    appliedAt: string | null;
  } | null;
  mergedSources: string[];
}

export interface JobDetailResponse {
  job: Job;
  matches: JobMatch[];
}

export interface ScreeningQuestion {
  questionId: string;
  question: string;
  required: boolean;
  answer: string;
  status: 'answered' | 'requires_user' | 'unknown';
  source: 'job_description' | 'manual';
}

export interface CoverLetterVersion {
  id: string;
  version: number;
  subjectLine: string;
  letterText: string;
  contentHash: string;
  source: 'generated' | 'template' | 'edited' | 'original';
  model: string;
  promptVersion: string;
  grounding: {
    passed: boolean;
    unsupportedTerms: string[];
    unsupportedNumbers: string[];
    notes: string[];
  };
  claimsUsed?: string[];
  uncertainties?: string[];
  wordCount: number;
  createdAt: string;
}

export interface Application {
  id: string;
  job: Job | string;
  profile: CandidateProfile | string;
  match: JobMatch | string | null;
  employer: string;
  jobTitle: string;
  jobUrl: string;
  applicationUrl: string;
  source: string;
  status: ApplicationStatus;
  version: number;
  selectedCvDocument: DocumentMeta | string | null;
  selectedCoverLetterDocument: DocumentMeta | string | null;
  cvHash: string;
  coverLetterHash: string;
  currentLetter: CoverLetterVersion | string | null;
  screeningQuestions: ScreeningQuestion[];
  approval: {
    approvedAt: string | null;
    approvedBy: string;
    applicationVersion: number | null;
    cvHash: string;
    coverLetterHash: string;
    confirmedAnswersHash: string;
    note: string;
  };
  submission: {
    attemptedAt: string | null;
    adapter: string;
    confirmed: boolean;
    confirmationId: string;
    message: string;
    evidence: string;
    simulated: boolean;
    manualInstructions: string;
    attempts: number;
    lastAttemptAt: string | null;
  };
  appliedAt: string | null;
  statusHistory: Array<{ from?: string; to: ApplicationStatus; at: string; reason?: string }>;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationListResponse extends Paginated<Application> {}

export interface PrepareResponse {
  application: Application;
  created: boolean;
  warnings: string[];
}

export interface SearchRun {
  id: string;
  status: 'running' | 'completed' | 'failed';
  trigger: 'manual' | 'scheduled';
  sources: Array<{
    source: string;
    status: 'ok' | 'failed' | 'skipped';
    found: number;
    created: number;
    updated: number;
    duplicates: number;
    filtered: number;
    durationMs: number;
    error: string;
  }>;
  discovered: number;
  created: number;
  updatedJobs: number;
  duplicates: number;
  filteredOut: number;
  scored: number;
  errorMessages: string[];
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
}

export interface DiscoveryResult {
  runId: string;
  status: 'completed' | 'failed';
  discovered: number;
  created: number;
  updated: number;
  duplicates: number;
  filteredOut: number;
  sources: SearchRun['sources'];
}

export interface DashboardSummary {
  totals: {
    totalJobs: number;
    activeJobs: number;
    relevant: number;
    applications: number;
    pendingApproval: number;
    submitted: number;
    failed: number;
    manual: number;
  };
  applicationsByStatus: Record<string, number>;
  topMatches: JobMatch[];
  recentRuns: SearchRun[];
  ai: { configured: boolean };
}

export interface ProfileExtractionResponse {
  profile: CandidateProfile;
  source: 'ai' | 'heuristic';
  model: string;
  warnings: string[];
}

export interface VerifyResponse {
  verification: { status: 'available' | 'unavailable' | 'unknown'; evidence: string };
  job: Job;
}
