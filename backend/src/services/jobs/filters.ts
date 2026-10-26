import type { Seniority } from '../../config/defaults.js';
import { normalizeForMatch } from '../../utils/text.js';
import { assessJobAge } from './age.js';
import { isEuRemoteLocation, isGermanLocation } from './normalize.js';
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

const REMOTE_RESTRICTION_AFTER =
  /\b(?:only|must (?:be )?(?:based|reside|live|located)|residents? of|eligible to work|authorized to work|work authorization|permission to work)\b[^.]{0,90}\b(?:united states|usa|u\.s\.|canada|india|australia|brazil|philippines|singapore|japan|china|mexico|argentina|south africa)\b/i;
const REMOTE_RESTRICTION_BEFORE =
  /\b(?:united states|usa|u\.s\.|canada|india|australia|brazil|philippines|singapore|japan|china|mexico|argentina|south africa)\b[^.]{0,40}\b(?:only|residents? only)\b/i;

/**
 * A remote listing can be restricted in its description even when the location field only
 * says "Remote". Explicit non-EU residency/work-authorisation requirements are excluded
 * instead of being treated as open to applicants in Germany.
 */
export function hasNonEuRemoteRestriction(job: JobListing): boolean {
  const text = `${job.location}\n${job.description.slice(0, 6_000)}`;
  return REMOTE_RESTRICTION_AFTER.test(text) || REMOTE_RESTRICTION_BEFORE.test(text);
}

export function isLocationAllowed(job: JobListing, criteria: JobSearchCriteria): boolean {
  if (job.workArrangement === 'remote') {
    if (hasNonEuRemoteRestriction(job)) return false;
    if (job.country === 'Germany') return true;
    if (!isEuRemoteLocation(job.location)) return false;
    const scope = criteria.remoteScope.map(normalizeForMatch);
    const scopeAllowsEu =
      scope.length === 0 ||
      scope.some(
        (entry) =>
          entry.includes('europe') || entry === 'eu' || entry.includes('european union'),
      );
    return scopeAllowsEu;
  }

  // Outside Germany only remote roles are in scope. A hybrid/on-site/unknown-arrangement
  // role must be verifiably German: a foreign country is rejected, and an unrecognised
  // location is only accepted when the location text itself names Germany.
  if (job.country === 'Germany') return true;
  if (job.country !== '') return false;
  return isGermanLocation(job.location);
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

  const age = assessJobAge({
    postedAt: job.postedAt,
    postedLocalDate: job.postedLocalDate,
    expiresAt: job.expiresAt,
    months: criteria.maxAgeMonths,
  });
  if (job.postedAt) {
    const ageDays = (Date.now() - job.postedAt.getTime()) / 86_400_000;
    if (ageDays > criteria.freshnessDays) reasons.push('older_than_max_age');
  } else {
    // Sources do not always expose a publication date. Keep the listing but mark it, so
    // age eligibility is never silently assumed.
    flags.push('posted_date_unknown');
  }
  if (age.ageEligibility === 'Unknown') flags.push('age_unknown');
  if (age.ageEligibility === 'Expired') {
    // Only postings inside the calendar-month window are stored. A job is excluded either
    // because its own deadline passed or because it is three or more months old.
    const expiredByDate = Boolean(job.expiresAt && job.expiresAt.getTime() < Date.now());
    reasons.push(expiredByDate ? 'expired' : 'older_than_max_age');
  }

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

  // Mentioning German is never a reason to exclude a vacancy. Only postings classified as
  // Excluded (explicitly mandatory German) are dropped, and only when the user asked for
  // that. Optional, not-required and unclassified postings always stay.
  const languageExcluded =
    job.languageDecision === 'Excluded' || job.languageRequirement === 'german_required';
  if (languageExcluded) {
    if (criteria.excludeGermanRequired) reasons.push('language_excluded');
    else flags.push('german_required');
  }
  if (job.languageDecision === 'Needs Review') flags.push('language_needs_review');
  if (job.germanOptional === true) flags.push('german_optional');
  if (job.languageRequirement === 'german_not_required') flags.push('german_not_required');
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
