import type { WorkArrangement } from '../../config/defaults.js';

export interface PhdListing {
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
  description: string;
  requiredQualifications: string[];
  requiredSkills: string[];
  preferredSkills: string[];
  requiredMethods: string[];
  requiredLanguages: string[];
  funding: string;
  /** Whether the advertisement itself evidences a funded position. */
  fundingStatus: 'funded' | 'not_funded' | 'unknown';
  fundingEvidence: string;
  salary: string;
  employmentRequirements: string[];
  languageRequirement: string;
  languageDecision: 'Eligible' | 'Excluded' | 'Needs Review';
  languageEvidence: string;
  languageReason: string;
  languageConfidence: number;
  postedAt: Date | null;
  postedAtUnknown: boolean;
  applicationDeadline: Date | null;
  deadlineTimezone: string;
  deadlineHasTime: boolean;
  /** The advertisement states rolling/continuous admission, so no fixed deadline is expected. */
  rollingAdmissions: boolean;
  deadlineStatus: 'open' | 'expired' | 'unknown' | 'closed';
  deadlineNote: string;
  expectedStartDate: string;
  status: 'active' | 'expired' | 'closed' | 'duplicate';
  statusNote: string;
  fingerprint: string;
  contentHash: string;
}

export interface PhdSourceAdapter {
  id: string;
  label: string;
  description: string;
  simulated: boolean;
  isConfigured(): boolean;
  searchPositions(criteria: { maxPositions: number }): Promise<PhdListing[]>;
  /** Optional: re-read one position from the source so its deadline can be re-verified. */
  getPosition?(sourceJobId: string): Promise<PhdListing | null>;
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
    /** Counts per exclusion rule, so a run can explain what it dropped. */
    rejectionReasons?: Record<string, number>;
    durationMs: number;
    error: string;
  }>;
}
