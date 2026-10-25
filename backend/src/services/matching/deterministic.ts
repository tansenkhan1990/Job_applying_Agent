import type { CandidateProfileRecord } from '../../models/CandidateProfile.js';
import type { Seniority } from '../../config/defaults.js';
import { normalizeForMatch } from '../../utils/text.js';
import { titleRelevance } from '../jobs/filters.js';
import { isEuRemoteLocation } from '../jobs/normalize.js';
import type { LanguageRequirement } from '../jobs/types.js';

export interface RequirementAssessment {
  label: string;
  status: 'met' | 'missing' | 'unknown' | 'preferred_missing';
  detail: string;
}

export interface AssessmentJob {
  title: string;
  location?: string | null;
  description?: string | null;
  tags?: string[] | null;
  seniority?: string | null;
  languageRequirement?: string | null;
  country?: string | null;
  workArrangement?: string | null;
}

export interface DeterministicAssessment {
  score: number;
  breakdown: { title: number; skills: number; seniority: number; location: number };
  matchedSkills: string[];
  missingSkills: string[];
  strengths: string[];
  concerns: string[];
  requirements: RequirementAssessment[];
  mandatoryUnknown: string[];
  languageRequirement: LanguageRequirement;
  languageAssessment: {
    requiredLanguage: string | null;
    mandatory: boolean;
    candidateMeets: 'yes' | 'no' | 'unknown';
  };
  reviewRequired: boolean;
  explanation: string;
}

const SKILL_ALIASES: Record<string, string[]> = {
  'node.js': ['node.js', 'nodejs', 'node js', 'node'],
  'retrieval augmented generation': ['retrieval-augmented generation', 'retrieval augmented generation', 'rag'],
  rag: ['rag', 'retrieval augmented generation'],
  'google cloud platform': ['google cloud platform', 'gcp', 'google cloud'],
  kubernetes: ['kubernetes', 'k8s'],
  postgresql: ['postgresql', 'postgres'],
  'ci cd': ['ci/cd', 'ci cd', 'continuous integration', 'continuous delivery'],
  'rest apis': ['rest apis', 'rest api', 'rest'],
  'machine learning': ['machine learning', 'ml'],
  nlp: ['nlp', 'natural language processing'],
  typescript: ['typescript', 'ts'],
  javascript: ['javascript', 'js'],
  'infrastructure automation': ['infrastructure automation', 'infrastructure as code', 'iac', 'terraform'],
  monitoring: ['monitoring', 'observability', 'prometheus', 'grafana'],
  'deployment workflows': ['deployment workflows', 'deployment', 'deployments'],
  'ai agents': ['ai agents', 'agentic', 'agents', 'langgraph'],
};

function skillVariants(skill: string): string[] {
  const normalized = normalizeForMatch(skill);
  return [normalized, ...(SKILL_ALIASES[normalized] ?? []).map(normalizeForMatch)];
}

export function skillPresent(text: string, skill: string): boolean {
  const normalizedText = normalizeForMatch(text);
  return skillVariants(skill).some((variant) => {
    if (!variant) return false;
    if (variant.length <= 3) {
      return new RegExp(`(^|[^a-z0-9])${variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(
        normalizedText,
      );
    }
    return normalizedText.includes(variant);
  });
}

function candidateGerman(profile: CandidateProfileRecord): 'yes' | 'no' | 'unknown' {
  if (!profile.languages || profile.languages.length === 0) return 'unknown';
  const german = profile.languages.find((item) => /german|deutsch/i.test(item.language));
  if (!german) return 'no';
  if (/unknown/i.test(german.level) && profile.languages.length === 0) return 'unknown';
  return 'yes';
}

function detectExplicitRequirements(job: AssessmentJob): string[] {
  const text = `${job.title}\n${job.description ?? ''}`;
  const found: string[] = [];
  if (
    /must be (legally )?(authorized|eligible) to work|work (permit|authorization) (is )?required|right to work in (the )?(eu|europe|germany)/i.test(
      text,
    )
  ) {
    found.push('Work authorization in the EU/Germany is required');
  }
  if (/security clearance|security screening|sicherheitsüberprüfung/i.test(text)) {
    found.push('Security clearance or screening is required');
  }
  return found;
}

export function extractYearsRequirement(text: string): number | null {
  const match =
    /(\d{1,2})\s*\+\s*(?:years|years of|jahre)|(?:at least|minimum|mindestens)\s+(\d{1,2})\s*(?:years|jahre)/i.exec(
      text,
    );
  if (!match) return null;
  const value = Number.parseInt(match[1] ?? match[2] ?? '', 10);
  return Number.isFinite(value) ? value : null;
}

function germanLanguageRequirement(job: AssessmentJob): LanguageRequirement {
  return (job.languageRequirement as LanguageRequirement) ?? 'unknown';
}

export function assessDeterministically(
  job: AssessmentJob,
  profile: CandidateProfileRecord,
  criteria: { seniority: Seniority[]; countries: string[]; remoteScope: string[] },
): DeterministicAssessment {
  const jobText = `${job.title}\n${job.location}\n${job.description ?? ''}\n${(job.tags ?? []).join(' ')}`;
  const profileSkills = [...new Set(profile.skills ?? [])];

  const titleScore = Math.round(titleRelevance(job.title, profile.targetTitles ?? []) * 30);
  const matchedSkills = profileSkills.filter((skill) => skillPresent(jobText, skill));
  const missingSkills = profileSkills.filter((skill) => !skillPresent(jobText, skill)).slice(0, 15);
  const skillsScore = Math.round(Math.min(1, matchedSkills.length / 7) * 40);

  const jobSeniority = (job.seniority ?? 'unknown') as Seniority | 'unknown';
  const jobWorkArrangement = job.workArrangement ?? 'unknown';
  const jobLocation = job.location ?? '';
  const jobCountry = job.country ?? '';
  const seniorityScore = jobSeniority === 'unknown' ? 10 : criteria.seniority.includes(jobSeniority) ? 15 : 0;

  const remoteCompatible =
    jobWorkArrangement === 'remote' &&
    (jobCountry === 'Germany' || isEuRemoteLocation(jobLocation));
  const locationScore =
    remoteCompatible || jobCountry === 'Germany'
      ? 15
      : jobCountry === '' || jobCountry === 'unknown'
        ? 7
        : criteria.countries.some((country) => normalizeForMatch(country) === normalizeForMatch(jobCountry))
          ? 15
          : 0;

  const breakdown = { title: titleScore, skills: skillsScore, seniority: seniorityScore, location: locationScore };
  let score = titleScore + skillsScore + seniorityScore + locationScore;

  const requirements: RequirementAssessment[] = [];
  const mandatoryUnknown: string[] = [];
  const concerns: string[] = [];
  const strengths: string[] = [];

  // Language: mandatory German is a hard requirement, but mentioning German is not.
  const languageRequirement = germanLanguageRequirement(job);
  const german = candidateGerman(profile);
  let languageAssessment: DeterministicAssessment['languageAssessment'] = {
    requiredLanguage: '',
    mandatory: false,
    candidateMeets: 'unknown',
  };

  if (languageRequirement === 'german_required') {
    languageAssessment = {
      requiredLanguage: 'German',
      mandatory: true,
      candidateMeets: german,
    };
    if (german === 'no') {
      requirements.push({
        label: 'German language',
        status: 'missing',
        detail: 'The vacancy requires German, and the candidate profile does not list German.',
      });
      concerns.push('German is mandatory for this role and is not evidenced in the candidate profile.');
      score = Math.min(score, 45);
    } else if (german === 'unknown') {
      requirements.push({
        label: 'German language',
        status: 'unknown',
        detail: 'The vacancy requires German; the profile has no verified language list.',
      });
      mandatoryUnknown.push('German proficiency is required but not verified in the profile');
      score = Math.min(score, 70);
    } else {
      requirements.push({
        label: 'German language',
        status: 'met',
        detail: `Profile lists German (${profile.languages.find((item) => /german|deutsch/i.test(item.language))?.level ?? 'level unknown'}).`,
      });
    }
  } else if (languageRequirement === 'german_preferred') {
    languageAssessment = { requiredLanguage: 'German', mandatory: false, candidateMeets: german };
    if (german === 'no') {
      requirements.push({
        label: 'German language',
        status: 'preferred_missing',
        detail: 'German is listed as an advantage, not a requirement.',
      });
      concerns.push('German is preferred but not evidenced; this is not treated as a hard blocker.');
    }
  } else if (languageRequirement === 'english_ok') {
    languageAssessment = { requiredLanguage: 'English', mandatory: false, candidateMeets: 'unknown' };
  }

  // Seniority
  if (jobSeniority !== 'unknown') {
    const allowed = criteria.seniority.includes(jobSeniority);
    requirements.push({
      label: 'Seniority',
      status: allowed ? 'met' : 'missing',
      detail: `Vacancy level: ${jobSeniority}; target levels: ${criteria.seniority.join(', ')}.`,
    });
    if (!allowed) {
      concerns.push(`Vacancy seniority (${jobSeniority}) is outside the configured target levels.`);
      score = Math.min(score, 60);
    }
  } else {
    requirements.push({
      label: 'Seniority',
      status: 'unknown',
      detail: 'The posting does not state a seniority level.',
    });
  }

  // Location / remote scope
  if (jobWorkArrangement === 'remote') {
    requirements.push({
      label: 'Location',
      status: remoteCompatible ? 'met' : 'unknown',
      detail: remoteCompatible
        ? `Remote role compatible with target scope (${jobLocation || 'location not stated'}).`
        : `Remote scope "${jobLocation || 'unknown'}" could not be confirmed as Germany/EU.`,
    });
    if (!remoteCompatible) {
      concerns.push('Remote location scope is unclear or outside Germany/EU; verify eligibility manually.');
    }
  } else {
    const countryMatch =
      jobCountry === 'Germany' ||
      criteria.countries.some((country) => normalizeForMatch(country) === normalizeForMatch(jobCountry));
    requirements.push({
      label: 'Location',
      status: countryMatch ? 'met' : 'unknown',
      detail: `Vacancy location: ${jobLocation || 'not stated'} (${jobCountry || 'country unknown'}).`,
    });
    if (!countryMatch && jobCountry) {
      concerns.push('Vacancy is outside the configured country scope.');
    }
  }

  // Explicit years requirement
  const yearsRequired = extractYearsRequirement(jobText);
  if (yearsRequired !== null) {
    if (profile.yearsExperience === null || profile.yearsExperience === undefined) {
      requirements.push({
        label: 'Years of experience',
        status: 'unknown',
        detail: `Posting asks for ${yearsRequired}+ years; the profile does not state total experience.`,
      });
      mandatoryUnknown.push(`The posting asks for ${yearsRequired}+ years of experience, which is not verified`);
    } else if (profile.yearsExperience < yearsRequired) {
      requirements.push({
        label: 'Years of experience',
        status: 'missing',
        detail: `Posting asks for ${yearsRequired}+ years; profile states ${profile.yearsExperience}.`,
      });
      score = Math.min(score, 55);
    } else {
      requirements.push({
        label: 'Years of experience',
        status: 'met',
        detail: `Posting asks for ${yearsRequired}+ years; profile states ${profile.yearsExperience}.`,
      });
    }
  }

  for (const requirement of detectExplicitRequirements(job)) {
    requirements.push({
      label: 'Work authorization / screening',
      status: 'unknown',
      detail: requirement,
    });
    mandatoryUnknown.push(requirement);
  }

  if (matchedSkills.length >= 4) {
    strengths.push(`Strong technology overlap: ${matchedSkills.slice(0, 8).join(', ')}.`);
  } else if (matchedSkills.length > 0) {
    strengths.push(`Relevant overlap: ${matchedSkills.join(', ')}.`);
  }
  if (titleScore >= 20) strengths.push(`Job title closely matches the target titles.`);
  if (jobCountry === 'Germany' || remoteCompatible) {
    strengths.push('Location and work arrangement fit the configured search scope.');
  }
  if (missingSkills.length > 0) {
    concerns.push(`Skills named in the profile but absent from the posting: ${missingSkills.slice(0, 6).join(', ')}.`);
  }

  const missingMandatory = requirements.some((item) => item.status === 'missing');
  if (missingMandatory) score = Math.min(score, 55);
  if (mandatoryUnknown.length > 0) score = Math.min(score, 75);

  score = Math.max(0, Math.min(100, Math.round(score)));

  const explanationParts = [
    `Rule-based assessment: title match ${titleScore}/30, skill overlap ${skillsScore}/40 (${matchedSkills.length} of ${profileSkills.length} profile skills found), seniority ${seniorityScore}/15, location ${locationScore}/15.`,
    languageRequirement === 'german_required'
      ? `The posting mandates German; candidate evidence: ${german}.`
      : languageRequirement === 'german_preferred'
        ? 'German is preferred, not mandatory.'
        : languageRequirement === 'english_ok'
          ? 'English appears sufficient.'
          : 'The language requirement could not be determined.',
  ];
  if (mandatoryUnknown.length > 0) {
    explanationParts.push(
      `Unverified mandatory requirements keep this match in manual review: ${mandatoryUnknown.join('; ')}.`,
    );
  }

  return {
    score,
    breakdown,
    matchedSkills,
    missingSkills,
    strengths: strengths.slice(0, 6),
    concerns: concerns.slice(0, 8),
    requirements,
    mandatoryUnknown,
    languageRequirement,
    languageAssessment,
    reviewRequired: mandatoryUnknown.length > 0 || missingMandatory,
    explanation: explanationParts.join(' '),
  };
}
