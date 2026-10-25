import { env } from './env.js';

export const PROFILE_KINDS = ['full_stack', 'ai_engineer', 'devops_cloud'] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

export const PROFILE_LABELS: Record<ProfileKind, string> = {
  full_stack: 'Full Stack Developer',
  ai_engineer: 'AI Engineer / Developer',
  devops_cloud: 'DevOps / Cloud Engineer',
};

export const WORK_ARRANGEMENTS = ['remote', 'hybrid', 'onsite'] as const;
export type WorkArrangement = (typeof WORK_ARRANGEMENTS)[number];

export const SENIORITY_LEVELS = ['junior', 'mid', 'senior', 'lead'] as const;
export type Seniority = (typeof SENIORITY_LEVELS)[number];

export const APPLICATION_STATUSES = [
  'DISCOVERED',
  'MATCHED',
  'READY_FOR_REVIEW',
  'APPROVED',
  'SUBMITTING',
  'SUBMITTED',
  'FAILED',
  'NEEDS_MANUAL_ACTION',
  'WITHDRAWN',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export interface ProfileSeed {
  kind: ProfileKind;
  name: string;
  targetTitles: string[];
  skills: string[];
  workPreferences: {
    countries: string[];
    remote: boolean;
    hybrid: boolean;
    onsite: boolean;
    languages: string[];
  };
}

export const DEFAULT_PROFILES: ProfileSeed[] = [
  {
    kind: 'full_stack',
    name: 'Full Stack Developer',
    targetTitles: [
      'Full Stack Developer',
      'Senior Full Stack Developer',
      'Software Engineer',
      'Frontend Engineer',
      'Backend Engineer',
      'JavaScript Developer',
      'TypeScript Developer',
    ],
    skills: [
      'JavaScript',
      'TypeScript',
      'React',
      'Node.js',
      'Express',
      'GraphQL',
      'REST APIs',
      'PostgreSQL',
      'MongoDB',
      'Docker',
      'CI/CD',
      'HTML',
      'CSS',
    ],
    workPreferences: {
      countries: ['Germany'],
      remote: true,
      hybrid: true,
      onsite: true,
      languages: ['English'],
    },
  },
  {
    kind: 'ai_engineer',
    name: 'AI Engineer / Developer',
    targetTitles: [
      'AI Engineer',
      'AI Developer',
      'LLM Engineer',
      'Generative AI Engineer',
      'Applied AI Engineer',
      'Python AI Engineer',
      'AI Agent Developer',
    ],
    skills: [
      'Python',
      'FastAPI',
      'LLM APIs',
      'Retrieval-Augmented Generation',
      'RAG',
      'AI agents',
      'LangGraph',
      'MCP',
      'OpenAI-compatible APIs',
      'Knowledge graphs',
      'Machine learning',
      'NLP',
    ],
    workPreferences: {
      countries: ['Germany'],
      remote: true,
      hybrid: true,
      onsite: true,
      languages: ['English'],
    },
  },
  {
    kind: 'devops_cloud',
    name: 'DevOps / Cloud Engineer',
    targetTitles: [
      'DevOps Engineer',
      'Cloud Engineer',
      'Cloud Developer',
      'Platform Engineer',
      'Site Reliability Engineer',
      'Cloud Infrastructure Engineer',
    ],
    skills: [
      'AWS',
      'Google Cloud Platform',
      'Azure DevOps',
      'Docker',
      'Kubernetes',
      'CI/CD',
      'Linux',
      'Terraform',
      'Infrastructure automation',
      'Monitoring',
      'Deployment workflows',
    ],
    workPreferences: {
      countries: ['Germany'],
      remote: true,
      hybrid: true,
      onsite: true,
      languages: ['English'],
    },
  },
];

export const AI_MODES = ['openrouter', 'deterministic'] as const;
export type AiMode = (typeof AI_MODES)[number];

export interface SearchCriteria {
  countries: string[];
  remoteScope: string[];
  languages: string[];
  workArrangements: WorkArrangement[];
  profileKinds: ProfileKind[];
  seniority: Seniority[];
  minRelevanceScore: number;
  maxJobsPerRun: number;
  freshnessDays: number;
  excludeInternships: boolean;
  excludeUnpaid: boolean;
  excludeKeywords: string[];
  includeKeywords: string[];
  sources: Record<string, boolean>;
}

export interface AppSettings {
  ai: {
    model: string;
    temperature: number;
    maxOutputTokens: number;
  };
  search: SearchCriteria;
  schedule: {
    enabled: boolean;
    intervalMinutes: number;
    runOnStartup: boolean;
  };
  application: {
    mode: 'approval_required' | 'prepare_only';
    maxDailyApplications: number;
    minScoreToPrepare: number;
    allowMockSubmission: boolean;
  };
  sources: Record<string, { enabled: boolean }>;
}

export function defaultSettings(): AppSettings {
  return {
    ai: {
      model: env.OPENROUTER_MODEL,
      temperature: 0.2,
      maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
    },
    search: {
      countries: ['Germany'],
      // "Germany" covers on-site/hybrid roles there; "European Union" covers EU-remote.
      remoteScope: ['Germany', 'European Union'],
      languages: ['English'],
      workArrangements: ['remote', 'hybrid', 'onsite'],
      profileKinds: [...PROFILE_KINDS],
      seniority: ['mid', 'senior'],
      minRelevanceScore: 80,
      maxJobsPerRun: 40,
      // Only vacancies posted within the last three days are stored by discovery.
      freshnessDays: 3,
      excludeInternships: true,
      excludeUnpaid: true,
      excludeKeywords: ['commission only', 'unpaid', 'volunteer'],
      includeKeywords: [],
      sources: {
        arbeitnow: true,
        remotive: true,
        mock: env.ENABLE_MOCK_SOURCE,
      },
    },
    schedule: {
      enabled: false,
      intervalMinutes: 360,
      runOnStartup: false,
    },
    application: {
      mode: 'approval_required',
      maxDailyApplications: 5,
      minScoreToPrepare: 80,
      allowMockSubmission: env.ALLOW_MOCK_SUBMISSION,
    },
    sources: {
      arbeitnow: { enabled: true },
      remotive: { enabled: true },
      mock: { enabled: env.ENABLE_MOCK_SOURCE },
    },
  };
}

export const PROMPT_VERSIONS = {
  match: 'match-v1',
  coverLetter: 'cover-letter-v1',
  profileExtraction: 'profile-extract-v1',
  screeningQuestions: 'screening-questions-v1',
} as const;
