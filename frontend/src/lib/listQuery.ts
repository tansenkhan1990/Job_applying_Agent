/**
 * Pure builders for the jobs and PhD list queries. Keeping them out of the pages means the
 * filter + sort combinations can be unit-tested without a browser. The backend still applies
 * every rule (date window, language, geography), so these parameters can only narrow results.
 */

export type JobScoreBand = '' | '90-100' | '80-89' | '70-79' | 'below-70';
export type JobLanguageFilter = 'non_required' | 'eligible' | 'optional' | 'review' | 'all';
export type JobReviewFilter = 'all' | 'unreviewed' | 'reviewed';
export type JobAppliedFilter = 'all' | 'applied' | 'not_applied';
export type JobLetterFilter = 'all' | 'yes' | 'no';
export type JobDateEvidence = 'verified' | 'needs_review';
export type JobSort = 'newest' | 'oldest' | 'score' | 'company' | 'title';

export interface JobFilters {
  q: string;
  category: string;
  profileKind: string;
  scoreBand: JobScoreBand;
  languageFilter: JobLanguageFilter;
  /** Empty is "any date": the mandatory three-calendar-month window still applies. */
  postedWindow: '' | '1' | '3' | '7' | '14' | '30' | '90' | '3m' | 'custom';
  postedFrom: string;
  postedTo: string;
  dateEvidence: JobDateEvidence;
  arrangement: '' | 'remote' | 'hybrid' | 'onsite';
  locationScope: '' | 'germany' | 'outside_germany_remote';
  country: string;
  remoteFromGermany: '' | 'true' | 'false';
  employmentType: string;
  minSalary: string;
  employer: string;
  seniority: string;
  savedOnly: boolean;
  reviewFilter: JobReviewFilter;
  /** Application tracker filter: applied, not yet applied, or either. */
  appliedFilter: JobAppliedFilter;
  letterFilter: JobLetterFilter;
  sort: JobSort;
}

export const DEFAULT_JOB_FILTERS: JobFilters = {
  q: '',
  category: '',
  profileKind: '',
  scoreBand: '',
  languageFilter: 'non_required',
  postedWindow: '',
  postedFrom: '',
  postedTo: '',
  dateEvidence: 'verified',
  arrangement: '',
  locationScope: '',
  country: '',
  remoteFromGermany: '',
  employmentType: '',
  minSalary: '',
  employer: '',
  seniority: '',
  savedOnly: false,
  reviewFilter: 'all',
  appliedFilter: 'all',
  letterFilter: 'all',
  sort: 'newest',
};

export function jobScoreRange(band: JobScoreBand): { min?: string; max?: string } {
  if (band === '90-100') return { min: '90', max: '100' };
  if (band === '80-89') return { min: '80', max: '89' };
  if (band === '70-79') return { min: '70', max: '79' };
  if (band === 'below-70') return { max: '69' };
  return {};
}

export function buildJobListQuery(
  filters: JobFilters,
  search: string,
  page: number,
  limit = 20,
): URLSearchParams {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    status: 'active',
  });
  if (search.trim()) params.set('q', search.trim());
  if (filters.category) params.set('category', filters.category);
  if (filters.profileKind) params.set('profileKind', filters.profileKind);

  const range = jobScoreRange(filters.scoreBand);
  if (range.min) params.set('minScore', range.min);
  if (range.max) params.set('maxScore', range.max);

  if (filters.languageFilter === 'non_required') params.set('excludeGermanRequired', 'true');
  else if (filters.languageFilter === 'all') params.set('excludeGermanRequired', 'false');
  else if (filters.languageFilter === 'eligible') params.set('languageDecision', 'Eligible');
  else if (filters.languageFilter === 'optional') params.set('germanOptional', 'true');
  else if (filters.languageFilter === 'review') params.set('languageDecision', 'Needs Review');

  // "Last 3 months" is the default backend window, so no extra parameter is needed; a day
  // count would be stricter than calendar months and is labelled separately in the UI.
  if (filters.postedWindow && filters.postedWindow !== 'custom' && filters.postedWindow !== '3m') {
    params.set('postedWithinDays', filters.postedWindow);
  }
  if (filters.postedWindow === 'custom') {
    if (filters.postedFrom) params.set('postedAfter', filters.postedFrom);
    if (filters.postedTo) params.set('postedBefore', filters.postedTo);
  }
  if (filters.dateEvidence === 'needs_review') params.set('ageEligibility', 'Unknown');
  if (filters.arrangement) params.set('workArrangement', filters.arrangement);
  if (filters.locationScope) params.set('locationScope', filters.locationScope);
  if (filters.country.trim()) params.set('country', filters.country.trim());
  if (filters.remoteFromGermany) {
    params.set('remoteEligibleFromGermany', filters.remoteFromGermany);
  }
  if (filters.employmentType.trim()) params.set('employmentType', filters.employmentType.trim());
  if (filters.minSalary.trim()) params.set('minSalary', filters.minSalary.trim());
  if (filters.employer.trim()) params.set('employer', filters.employer.trim());
  if (filters.seniority) params.set('seniority', filters.seniority);
  if (filters.savedOnly) params.set('saved', 'true');
  if (filters.reviewFilter !== 'all') {
    params.set('reviewed', filters.reviewFilter === 'reviewed' ? 'true' : 'false');
  }
  if (filters.appliedFilter === 'applied') params.set('applied', 'true');
  else if (filters.appliedFilter === 'not_applied') params.set('applied', 'false');
  if (filters.letterFilter !== 'all') {
    params.set('hasCoverLetter', filters.letterFilter === 'yes' ? 'true' : 'false');
  }
  params.set('sort', filters.sort);
  return params;
}

export type PhdDeadlineGroup = 'open' | 'unknown' | 'expired' | 'closed';
export type PhdScoreBand = '' | '80-100' | '60-79' | 'below-60';
export type PhdSort = 'newest' | 'oldest' | 'score' | 'deadline' | 'institution' | 'title';

export interface PhdQueryInput {
  search: string;
  topic: string;
  researchArea: string;
  institution: string;
  country: string;
  /** Empty means every work arrangement: on-site, hybrid and remote are all in scope. */
  arrangement: '' | 'remote' | 'hybrid' | 'onsite';
  deadlineGroup: PhdDeadlineGroup;
  deadlineWindow: string;
  scoreBand: PhdScoreBand;
  language: string;
  funded: string;
  savedOnly: boolean;
  unreviewedOnly: boolean;
  letterFilter: string;
  sort: PhdSort;
  page: number;
}

export function buildPhdListQuery(input: PhdQueryInput, limit = 20): URLSearchParams {
  const params = new URLSearchParams({ page: String(input.page), limit: String(limit) });
  if (input.search.trim()) params.set('q', input.search.trim());
  if (input.topic.trim()) params.set('topic', input.topic.trim());
  if (input.researchArea) params.set('researchArea', input.researchArea);
  if (input.institution.trim()) params.set('institution', input.institution.trim());
  if (input.country.trim()) params.set('country', input.country.trim());
  if (input.arrangement) params.set('workArrangement', input.arrangement);
  if (input.deadlineGroup !== 'open') params.set('deadlineStatus', input.deadlineGroup);
  if (input.deadlineWindow) params.set('deadlineWithinDays', input.deadlineWindow);

  if (input.scoreBand === '80-100') params.set('minScore', '80');
  else if (input.scoreBand === '60-79') {
    params.set('minScore', '60');
    params.set('maxScore', '79');
  } else if (input.scoreBand === 'below-60') params.set('maxScore', '59');

  if (input.language) params.set('languageDecision', input.language);
  if (input.funded) params.set('funded', input.funded);
  if (input.savedOnly) params.set('saved', 'true');
  if (input.unreviewedOnly) params.set('reviewed', 'false');
  if (input.letterFilter !== 'all') params.set('hasCoverLetter', input.letterFilter);
  params.set('sort', input.sort);
  return params;
}
