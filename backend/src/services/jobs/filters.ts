import type { Seniority } from '../../config/defaults.js';
import { normalizeForMatch } from '../../utils/text.js';
import { isEuRemoteLocation } from './normalize.js';
import type { JobListing, JobSearchCriteria } from './types.js';

export interface FilterOutcome {
  included: boolean;
  reasons: string[];
  flags: string[];
}

const INTERNSHIP_PATTERN = /\b(intern|internship|werkstudent|working student|praktikant|praktikum|trainee)\b/;
const UNPAID_PATTERN =
  /\b(unpaid|without pay|no salary|volunteer|commission only|commission-only|equity only)\b/;
const GERMAN_TITLE_HINTS = [
  'entwickler',
  'entwicklerin',
  'ingenieur',
  'ingenieurin',
  'softwareentwickler',
  'plattform',
  'ki ',
  'künstliche intelligenz',
];

const TITLE_STOPWORDS = new Set([
  'senior',
  'junior',
  'mid',
  'lead',
  'principal',
  'staff',
  'the',
  'and',
  'or',
  'for',
  'with',
  'developer',
  'engineer',
  'engineering',
  'software',
]);

export function titleRelevance(title: string, targetTitles: string[]): number {
  const normalizedTitle = normalizeForMatch(title);
  if (!normalizedTitle) return 0;
  const titleTokens = new Set(
    normalizedTitle.split(' ').filter((token) => token.length > 2 && !TITLE_STOPWORDS.has(token)),
  );

  let best = 0;
  for (const target of targetTitles) {
    const targetTokens = normalizeForMatch(target)
      .split(' ')
      .filter((token) => token.length > 2 && !TITLE_STOPWORDS.has(token));
    if (targetTokens.length === 0) continue;
    const overlap = targetTokens.filter((token) => titleTokens.has(token)).length / targetTokens.length;
    const whole = normalizedTitle.includes(normalizeForMatch(target)) ? 1 : 0;
    best = Math.max(best, overlap, whole);
  }
  // Broad engineering vocabulary keeps relevant German-language titles.
  if (best === 0) {
    const broad = [
      'engineer',
      'developer',
      'entwickler',
      'ingenieur',
      'architect',
      'sre',
      'devops',
      'platform',
      'cloud',
      'frontend',
      'backend',
      'fullstack',
      'full stack',
      'data',
      'machine learning',
      'ai ',
      'ki ',
      ...GERMAN_TITLE_HINTS,
    ];
    if (broad.some((token) => normalizedTitle.includes(token))) best = 0.6;
  }
  return best;
}

export function isLanguageAllowed(requirement: JobListing['languageRequirement'], languages: string[]): boolean {
  // Deliberately conservative: never exclude a vacancy just because German is mentioned.
  // German-mandatory roles stay visible and are flagged during matching.
  if (requirement === 'german_required') return true;
  const hasEnglish = languages.some((language) => /english/i.test(language));
  return hasEnglish || languages.length === 0;
}

export function isLocationAllowed(job: JobListing, criteria: JobSearchCriteria): boolean {
  const locationText = normalizeForMatch(`${job.location} ${job.title}`);
  if (job.workArrangement === 'remote') {
    if (job.country === 'Germany') return true;
    return isEuRemoteLocation(job.location);
  }
  const countryAllowed =
    job.country.length === 0 ||
    criteria.countries.some((country) => normalizeForMatch(country) === normalizeForMatch(job.country)) ||
    criteria.countries.some((country) => locationText.includes(normalizeForMatch(country)));
  return countryAllowed;
}

export function isSeniorityAllowed(
  seniority: Seniority | 'unknown',
  allowed: Seniority[],
): boolean {
  if (seniority === 'unknown' || allowed.length === 0) return true;
  return allowed.includes(seniority);
}

export function applyDeterministicFilters(job: JobListing, criteria: JobSearchCriteria): FilterOutcome {
  const reasons: string[] = [];
  const flags: string[] = [];
  const text = normalizeForMatch(`${job.title} ${job.location} ${job.description.slice(0, 6000)}`);

  if (job.postedAt) {
    const ageDays = (Date.now() - job.postedAt.getTime()) / 86_400_000;
    if (ageDays > criteria.freshnessDays) reasons.push('older_than_freshness_window');
  }
  if (job.expiresAt && job.expiresAt.getTime() < Date.now()) reasons.push('expired');

  if (criteria.workArrangements.length > 0 && job.workArrangement !== 'unknown') {
    if (!criteria.workArrangements.includes(job.workArrangement)) reasons.push('work_arrangement_mismatch');
  }

  if (criteria.excludeInternships && INTERNSHIP_PATTERN.test(text)) reasons.push('internship_excluded');
  if (criteria.excludeUnpaid && UNPAID_PATTERN.test(text)) reasons.push('unpaid_excluded');

  for (const keyword of criteria.excludeKeywords) {
    const normalized = normalizeForMatch(keyword);
    if (normalized && text.includes(normalized)) {
      reasons.push(`excluded_keyword:${keyword}`);
    }
  }

  if (!isLocationAllowed(job, criteria)) reasons.push('location_mismatch');
  if (!isSeniorityAllowed(job.seniority, criteria.seniority)) reasons.push('seniority_mismatch');

  if (criteria.targetTitles.length > 0 && criteria.includeKeywords.length === 0) {
    if (titleRelevance(job.title, criteria.targetTitles) === 0) reasons.push('title_not_relevant');
  }

  if (job.languageRequirement === 'german_required') flags.push('german_required');
  if (job.country === '' || job.workArrangement === 'unknown') flags.push('location_needs_review');
  if (criteria.includeKeywords.length > 0) {
    const hasInclude = criteria.includeKeywords.some((keyword) => {
      const normalized = normalizeForMatch(keyword);
      return normalized.length > 0 && text.includes(normalized);
    });
    if (!hasInclude) reasons.push('missing_include_keyword');
  }

  return { included: reasons.length === 0, reasons, flags };
}
