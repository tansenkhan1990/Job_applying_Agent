import { createHash } from 'node:crypto';
import type { Seniority, WorkArrangement } from '../../config/defaults.js';
import { normalizeForMatch, normalizeWhitespace, stripHtml } from '../../utils/text.js';
import { classifyLanguage, type LanguageClassification } from './language.js';
import { assessJobAge } from './age.js';
import type { JobListing, LanguageRequirement } from './types.js';

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'ref',
  'referrer',
  'source',
  'gh_src',
  'gclid',
  'fbclid',
  'mc_cid',
  'mc_eid',
]);

export function canonicalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.protocol = 'https:';
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    let pathname = url.pathname.replace(/\/+$/, '');
    if (!pathname) pathname = '/';
    return `${url.origin}${pathname}${url.search ? `?${url.searchParams.toString()}` : ''}`;
  } catch {
    return rawUrl.trim();
  }
}

/**
 * Only absolute http(s) URLs may be opened by the browser runner. Anything else (file:,
 * javascript:, data:, malformed input) is discarded rather than trusted.
 */
export function safeHttpUrl(rawUrl: string | null | undefined): string {
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (url.username || url.password) return '';
    return url.toString();
  } catch {
    return '';
  }
}

export function jobFingerprint(employer: string, title: string, location: string): string {
  const normalized = [employer, title, location]
    .map((part) => normalizeForMatch(part).replace(/\b(gmbh|ag|se|inc|ltd|llc|the)\b/g, '').trim())
    .join('|');
  return createHash('sha256').update(normalized).digest('hex');
}

export function contentHash(listing: Pick<JobListing, 'title' | 'description' | 'location' | 'employer'>): string {
  return createHash('sha256')
    .update([listing.employer, listing.title, listing.location, listing.description].join('|'))
    .digest('hex');
}

const GERMAN_CITIES = [
  'berlin',
  'munich',
  'münchen',
  'hamburg',
  'cologne',
  'köln',
  'frankfurt',
  'stuttgart',
  'düsseldorf',
  'dusseldorf',
  'leipzig',
  'dresden',
  'hannover',
  'nuremberg',
  'nürnberg',
  'karlsruhe',
  'freiburg',
  'heidelberg',
  'bonn',
  'essen',
  'dortmund',
  'bremen',
  'potsdam',
  'jena',
  'ulm',
  'augsburg',
  'münster',
  'munster',
  'kiel',
  'mainz',
  'wiesbaden',
  'remote germany',
  'deutschland',
  'germany',
];

const EU_HINTS = [
  'europe',
  'eu',
  'european union',
  'emea',
  'worldwide',
  'anywhere',
  'global',
  'germany',
  'deutschland',
  'netherlands',
  'france',
  'spain',
  'portugal',
  'ireland',
  'italy',
  'poland',
  'austria',
  'switzerland',
  'sweden',
  'denmark',
  'finland',
  'belgium',
  'czech',
  'estonia',
  'lithuania',
  'latvia',
  'romania',
  'bulgaria',
  'greece',
  'hungary',
  'croatia',
  'slovenia',
  'slovakia',
  'luxembourg',
  'norway',
];

const RESTRICTED_HINTS = [
  'usa only',
  'us only',
  'united states only',
  'canada only',
  'latam',
  'india only',
  'asia only',
  'australia only',
  'uk only',
  'united kingdom only',
  'philippines',
  'brazil only',
];

export function detectCountry(location: string): string {
  const normalized = normalizeForMatch(location);
  if (!normalized) return '';
  if (GERMAN_CITIES.some((city) => normalized.includes(city))) return 'Germany';
  if (/\b(united states|usa|canada|india|australia|brazil|philippines|singapore|japan)\b/.test(normalized)) {
    return 'Other';
  }
  if (/\b(netherlands|france|spain|portugal|ireland|italy|poland|austria|switzerland|sweden|denmark|finland|belgium|czech|estonia|lithuania|latvia|romania|bulgaria|greece|hungary|croatia|slovenia|slovakia|luxembourg|norway|european union|europe|emea|eu remote)\b/.test(normalized)) {
    return 'European Union';
  }
  return '';
}

export function isEuRemoteLocation(location: string): boolean {
  const normalized = normalizeForMatch(location);
  if (!normalized) return true; // Unknown remote scope is kept and flagged for review.
  if (RESTRICTED_HINTS.some((hint) => normalized.includes(hint))) return false;
  return EU_HINTS.some((hint) => normalized.includes(hint)) || normalized.length <= 3;
}

export function detectWorkArrangement(
  title: string,
  location: string,
  description: string,
  remoteFlag: boolean,
): WorkArrangement | 'unknown' {
  const titleText = normalizeForMatch(`${title} ${location}`);
  const body = normalizeForMatch(`${title} ${location} ${description.slice(0, 3000)}`);
  if (/\bhybrid\b|homeoffice|home office|teilweise remote|mobile working/.test(body)) return 'hybrid';
  if (
    remoteFlag ||
    /\bfully remote\b|\b100% remote\b|\bremote first\b|\bremote-first\b|\bremote\b|\bhomeoffice\b|\bwork from home\b|\btelearbeit\b/.test(
      body,
    )
  ) {
    if (/\bonsite\b|\bon-site\b|\bin office\b|\bvor ort\b/.test(titleText)) return 'onsite';
    return 'remote';
  }
  if (/\bonsite\b|\bon-site\b|\bin office\b|\bvor ort\b|\bin person\b/.test(body)) return 'onsite';
  return 'unknown';
}

export function detectSeniority(title: string, description: string): Seniority | 'unknown' {
  const text = normalizeForMatch(`${title} ${description.slice(0, 1200)}`);
  if (/\b(intern|internship|werkstudent|working student|praktikant|praktikum|graduate|entry level|junior|berufseinsteiger)\b/.test(text)) {
    return 'junior';
  }
  if (/\b(head of|principal|staff engineer|engineering manager|tech lead|team lead|lead engineer|director)\b/.test(text)) {
    return 'lead';
  }
  if (/\b(senior|sr\.?|erfahren|erfahrene)\b/.test(text)) return 'senior';
  if (/\b(mid level|mid-level|intermediate)\b/.test(text)) return 'mid';
  return 'unknown';
}

export { classifyLanguage, detectLanguageRequirement } from './language.js';

export function normalizeListing(
  input: Omit<
    JobListing,
    | 'canonicalUrl'
    | 'languageRequirement'
    | 'jobLanguage'
    | 'englishRequired'
    | 'germanRequired'
    | 'germanOptional'
    | 'languageEvidence'
    | 'languageConfidence'
    | 'languageDecision'
    | 'languageReason'
    | 'ageEligibility'
    | 'eligibleAfter'
    | 'ageCheckAt'
    | 'ageReason'
    | 'seniority'
    | 'workArrangement'
    | 'country'
    | 'description'
  > & {
    description?: string;
    descriptionHtml?: string;
    languageRequirement?: LanguageRequirement;
    languageClassification?: LanguageClassification;
    seniority?: Seniority | 'unknown';
    workArrangement?: WorkArrangement | 'unknown';
    country?: string;
  },
): JobListing {
  const description = normalizeWhitespace(input.description ?? stripHtml(input.descriptionHtml ?? ''));
  const classification =
    input.languageClassification ??
    classifyLanguage({ title: input.title, location: input.location, description });
  const age = assessJobAge({
    postedAt: input.postedAt,
    postedLocalDate: input.postedLocalDate,
    expiresAt: input.expiresAt,
  });
  return {
    ...input,
    description,
    descriptionHtml: input.descriptionHtml,
    canonicalUrl: canonicalizeUrl(input.url),
    applicationUrl: safeHttpUrl(input.applicationUrl) || canonicalizeUrl(input.url),
    employer: normalizeWhitespace(input.employer) || 'Unknown employer',
    title: normalizeWhitespace(input.title) || 'Untitled role',
    location: normalizeWhitespace(input.location),
    country: input.country ?? detectCountry(input.location),
    workArrangement:
      input.workArrangement ?? detectWorkArrangement(input.title, input.location, description, input.remote),
    languageRequirement: input.languageRequirement ?? classification.languageRequirement,
    jobLanguage: classification.jobLanguage,
    englishRequired: classification.englishRequired,
    germanRequired: classification.germanRequired,
    germanOptional: classification.germanOptional,
    languageEvidence: classification.languageEvidence,
    languageConfidence: classification.languageConfidence,
    languageDecision: classification.languageDecision,
    languageReason: classification.languageReason,
    ageEligibility: age.ageEligibility,
    eligibleAfter: age.eligibleAfter,
    ageCheckAt: age.ageCheckAt,
    ageReason: age.ageReason,
    seniority: input.seniority ?? detectSeniority(input.title, description),
    remote: input.remote || input.workArrangement === 'remote',
  };
}
