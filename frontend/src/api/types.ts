export type ProfileKind = 'full_stack' | 'ai_engineer' | 'devops_cloud';
export type ProfileKindOrUnassigned = ProfileKind | 'unassigned';
export type WorkArrangement = 'remote' | 'hybrid' | 'onsite' | 'unknown';

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
    maxAgeMonths: number;
    excludeInternships: boolean;
    excludeUnpaid: boolean;
    excludeGermanRequired: boolean;
    excludeKeywords: string[];
    includeKeywords: string[];
    targetTitles: string[];
    sources: Record<string, boolean>;
  };
  schedule: { enabled: boolean; intervalMinutes: number; runOnStartup: boolean };
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
  scoreBreakdown: Record<string, number>;
  scoreCategories?: Array<{
    key: string;
    label: string;
    weight: number;
    applicable: boolean;
    score: number;
    detail: string;
  }>;
  matchedRequired?: string[];
  missingRequired?: string[];
  matchedPreferred?: string[];
  missingPreferred?: string[];
  requiredSkills?: string[];
  preferredSkills?: string[];
  recommendedProfileKind?: string;
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
  languageRequirement:
    | 'english_ok'
    | 'german_not_required'
    | 'german_required'
    | 'german_preferred'
    | 'unknown';
  languageAssessment: { requiredLanguage: string; mandatory: boolean; candidateMeets: string };
  promptInjectionDetected: boolean;
  recommendedCvDocument: string | null;
  recommendedCoverLetterDocument: string | null;
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
  simulated: boolean;
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
  postedAtUnknown?: boolean;
  discoveredAt: string;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  lastVerifiedAt: string | null;
  expiresAt: string | null;
  ageEligibility: 'Eligible' | 'Too Recent' | 'Unknown' | 'Expired';
  eligibleAfter: string | null;
  ageCheckAt: string | null;
  ageReason: string;
  status: 'active' | 'expired' | 'unavailable' | 'duplicate';
  statusNote: string;
  languageRequirement:
    | 'english_ok'
    | 'german_not_required'
    | 'german_required'
    | 'german_preferred'
    | 'unknown';
  jobLanguage: 'English' | 'German' | 'Mixed' | 'Unknown';
  englishRequired: boolean | null;
  germanRequired: boolean | null;
  germanOptional: boolean | null;
  languageEvidence: string;
  languageConfidence: number;
  languageDecision: 'Eligible' | 'Excluded' | 'Needs Review';
  languageReason: string;
  seniority: 'junior' | 'mid' | 'senior' | 'lead' | 'unknown';
  saved: boolean;
  reviewedAt: string | null;
  /** Application tracker: when the user marked this vacancy as applied, otherwise null. */
  appliedAt: string | null;
  remoteEligibleFromGermany: boolean | null;
  bestMatch?: JobMatch | null;
  mergedSources: string[];
}

export interface JobDetailResponse {
  job: Job;
  matches: JobMatch[];
}

export type PhdLanguageDecision = 'Eligible' | 'Excluded' | 'Needs Review';

export interface PhdPosition {
  id: string;
  source: string;
  sourceJobId: string;
  sourceLabel: string;
  simulated: boolean;
  url: string;
  canonicalUrl: string;
  applicationUrl: string;
  institution: string;
  title: string;
  researchGroup: string;
  supervisor: string;
  department: string;
  location: string;
  country: string;
  workArrangement: WorkArrangement | 'unknown';
  remoteEligibleFromGermany: boolean | null;
  researchTopic: string;
  researchArea: 'ai' | 'cybersecurity' | 'software_engineering' | 'data' | 'other';
  researchAreaEvidence: string;
  description?: string;
  descriptionPreview?: string;
  requiredQualifications: string[];
  requiredSkills: string[];
  preferredSkills: string[];
  requiredMethods: string[];
  requiredLanguages: string[];
  funding: string;
  fundingStatus: 'funded' | 'not_funded' | 'unknown';
  fundingEvidence: string;
  salary: string;
  employmentRequirements: string[];
  languageRequirement: string;
  languageDecision: PhdLanguageDecision;
  languageEvidence: string;
  languageReason: string;
  languageConfidence: number;
  postedAt: string | null;
  postedAtUnknown: boolean;
  applicationDeadline: string | null;
  deadlineTimezone: string;
  deadlineHasTime: boolean;
  deadlineStatus: 'open' | 'expired' | 'unknown' | 'closed';
  deadlineNote: string;
  expectedStartDate: string;
  discoveredAt: string;
  lastSeenAt: string | null;
  lastVerifiedAt: string | null;
  saved: boolean;
  reviewedAt: string | null;
  status: 'active' | 'expired' | 'closed' | 'duplicate';
  statusNote: string;
  bestMatch?: PhdMatch | null;
}

export interface PhdMatch {
  id: string;
  position: string;
  profile: string | Pick<CandidateProfile, 'id' | 'label' | 'kind' | 'name'>;
  profileKind: ProfileKind;
  score: number;
  scoreCategories: Array<{
    key: string;
    label: string;
    weight: number;
    score: number;
    detail: string;
  }>;
  matchedTopics: string[];
  missingTopics: string[];
  matchedSkills: string[];
  missingSkills: string[];
  matchedPublications: string[];
  qualifications: string[];
  mandatoryMissing: string[];
  concerns: string[];
  strengths: string[];
  languageDecision: PhdLanguageDecision;
  reviewRequired: boolean;
  recommendedCvDocument: string | null;
  explanation: string;
  model: string;
  promptVersion: string;
  evaluatedAt: string;
}

export interface PhdDetailResponse {
  position: PhdPosition;
  matches: PhdMatch[];
}

export interface PhdDiscoveryResult {
  runId: string;
  status: 'completed' | 'failed';
  discovered: number;
  created: number;
  updated: number;
  duplicates: number;
  filteredOut: number;
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
}

export interface PhdSourceStatus {
  id: string;
  label: string;
  description: string;
  simulated: boolean;
  enabled: boolean;
  configured: boolean;
  note: string;
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
  job?: string | null;
  phdPosition?: string | null;
  letterType?: 'job' | 'phd';
  profile?: string | Pick<CandidateProfile, 'id' | 'label' | 'name' | 'kind'>;
  generatedText?: string;
  editedByUser?: boolean;
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

export interface LetterOptionProfile {
  profileId: string;
  profileKind: ProfileKind;
  label: string;
  name: string;
  cvDocumentId: string | null;
  cvFilename: string;
  cvReady: boolean;
  referenceDocumentId: string | null;
  referenceFilename: string;
  referenceReady: boolean;
  recommended: boolean;
  referenceRecommended: boolean;
  rank: number;
  score: number;
  rationale: string;
}

/** Shared option payload for job cover letters and PhD academic letters. */
export interface LetterOptions {
  jobId?: string;
  positionId?: string;
  jobContentHash: string;
  jobChangedSinceLetter: boolean;
  selectedCvProfileId: string;
  selectedReferenceProfileId: string;
  recommendedCvProfileId: string;
  recommendedReferenceProfileId: string;
  selectionRationale: string;
  limitations: string[];
  preferencesSaved: boolean;
  latestLetter: {
    id: string;
    version: number;
    createdAt: string;
    jobContentHash?: string;
  } | null;
  profiles: LetterOptionProfile[];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  sources?: string[];
  createdAt?: string;
}

export interface ChatSession {
  id: string;
  targetType: 'job' | 'phd';
  job?: string | null;
  phdPosition?: string | null;
  title: string;
  aiModel?: string;
  messages: ChatMessage[];
  lastMessageAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionResponse {
  session: ChatSession | null;
}

export interface ChatSendResponse {
  session: ChatSession;
  reply: string;
  model: string;
  sources: string[];
}

export interface SearchRun {
  id: string;
  status: 'running' | 'completed' | 'failed';
  trigger: 'manual' | 'scheduled' | 'startup';
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
    rejectionReasons?: Record<string, number>;
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
  highMatchThreshold: number;
  totals: {
    totalJobs: number;
    eligibleByDate: number;
    newJobs: number;
    highMatchJobs: number;
    unknownPostingDate: number;
    savedJobs: number;
    openPhd: number;
    phdDeadlineSoon: number;
    phdUnknownDeadline: number;
    savedPhd: number;
    savedLetters: number;
    approvedProfiles: number;
  };
  lastSuccessful: { jobs: string | null; phd: string | null };
  sourceFailures: Array<{
    kind: 'jobs' | 'phd';
    source: string;
    error: string;
    runId: string;
  }>;
  topMatches: Array<{
    id: string;
    jobId: string;
    jobTitle: string;
    employer: string;
    location: string;
    score: number;
    profileKind: string;
    reviewRequired: boolean;
  }>;
  recentRuns: SearchRun[];
  ai: { configured: boolean; model: string };
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
