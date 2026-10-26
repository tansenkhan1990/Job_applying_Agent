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

/**
 * Extract an approximate annual salary range from free text. Returns null when the posting
 * does not contain a credible number; the UI must show "not stated" in that case.
 */
export function parseSalaryRange(raw: string | null | undefined): {
  min: number | null;
  max: number | null;
} {
  if (!raw) return { min: null, max: null };
  const matches = [...raw.matchAll(/(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(k|K)?/g)]
    .map((match) => {
      const base = Number.parseFloat(match[1]!.replace(/,/g, ''));
      if (!Number.isFinite(base)) return null;
      return match[2] ? base * 1_000 : base;
    })
    .filter((value): value is number => value !== null && value >= 10_000 && value <= 1_000_000)
    .sort((a, b) => a - b);
  if (matches.length === 0) return { min: null, max: null };
  return { min: matches[0]!, max: matches[matches.length - 1]! };
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
  'aachen',
  'eschborn',
  'darmstadt',
  'mannheim',
  'ratingen',
  'gilching',
  'offenbach',
  'georgsmarienhütte',
  'georgsmarienhuette',
  'regensburg',
  'ingolstadt',
  'würzburg',
  'wuerzburg',
  'braunschweig',
  'kassel',
  'erfurt',
  'magdeburg',
  'rostock',
  'lübeck',
  'luebeck',
  'saarbrücken',
  'saarbruecken',
  'koblenz',
  'trier',
  'marburg',
  'gießen',
  'giessen',
  'siegen',
  'paderborn',
  'bielefeld',
  'osnabrück',
  'osnabrueck',
  'oldenburg',
  'bremerhaven',
  'chemnitz',
  'cottbus',
  'göttingen',
  'goettingen',
  'tübingen',
  'tuebingen',
  'heilbronn',
  'pforzheim',
  'wolfsburg',
  'remote germany',
  'deutschland',
  'germany',
];

// Cities that are outside Germany. Recognising them prevents an unlabelled city from being
// stored as "country unknown" and slipping through the on-site/hybrid geographic filter.
const EU_CITIES = [
  'amsterdam',
  'rotterdam',
  'utrecht',
  'eindhoven',
  'the hague',
  'brussels',
  'antwerp',
  'paris',
  'lyon',
  'bordeaux',
  'toulouse',
  'marseille',
  'madrid',
  'barcelona',
  'valencia',
  'lisbon',
  'porto',
  'milan',
  'rome',
  'turin',
  'vienna',
  'salzburg',
  'zurich',
  'geneva',
  'basel',
  'bern',
  'lausanne',
  'stockholm',
  'gothenburg',
  'copenhagen',
  'aarhus',
  'oslo',
  'helsinki',
  'espoo',
  'dublin',
  'cork',
  'prague',
  'brno',
  'warsaw',
  'krakow',
  'wroclaw',
  'budapest',
  'bucharest',
  'sofia',
  'athens',
  'thessaloniki',
  'tallinn',
  'riga',
  'vilnius',
  'ljubljana',
  'zagreb',
  'bratislava',
  'luxembourg',
  'koudekerk aan den rijn',
];

const NON_EU_CITIES = [
  'london',
  'manchester',
  'edinburgh',
  'birmingham',
  'bristol',
  'leeds',
  'glasgow',
  'belfast',
  'new york',
  'san francisco',
  'boston',
  'austin',
  'seattle',
  'toronto',
  'vancouver',
  'bangalore',
  'hyderabad',
  'pune',
  'singapore',
  'tokyo',
  'sydney',
  'melbourne',
  'dubai',
  'tel aviv',
  'cape town',
  'sao paulo',
  'mexico city',
];

const EU_CITY_PATTERN = new RegExp(`\\b(${EU_CITIES.join('|')})\\b`);
const NON_EU_CITY_PATTERN = new RegExp(`\\b(${NON_EU_CITIES.join('|')})\\b`);
const NON_EU_COUNTRY_PATTERN =
  /\b(united states|usa|u\.s\.|canada|india|australia|brazil|philippines|singapore|japan|china|mexico|argentina|south africa|united kingdom|uk|england|scotland|wales)\b/;

/** Generic remote wording that carries no geographic information. */
const GENERIC_REMOTE_WORDS = new Set([
  'remote',
  'job',
  'jobs',
  'work',
  'working',
  'from',
  'home',
  'homeoffice',
  'office',
  'fully',
  '100',
  'wfh',
  'teleworking',
  'telearbeit',
  'teletravail',
  'distributed',
  'location',
  'independent',
  'flexible',
  'friendly',
  'first',
  'only',
  'or',
  'and',
]);

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
  if (NON_EU_COUNTRY_PATTERN.test(normalized) || NON_EU_CITY_PATTERN.test(normalized)) {
    return 'Other';
  }
  if (
    EU_CITY_PATTERN.test(normalized) ||
    /\b(netherlands|france|spain|portugal|ireland|italy|poland|austria|switzerland|sweden|denmark|finland|belgium|czech|estonia|lithuania|latvia|romania|bulgaria|greece|hungary|croatia|slovenia|slovakia|luxembourg|norway|european union|europe|emea|eu remote)\b/.test(
      normalized,
    )
  ) {
    return 'European Union';
  }
  return '';
}

/** True when a Germany-based location string is present (country may be undetected). */
export function isGermanLocation(location: string): boolean {
  const normalized = normalizeForMatch(location);
  if (!normalized) return false;
  if (/\b(germany|deutschland)\b/.test(normalized)) return true;
  return GERMAN_CITIES.some((city) => normalized.includes(city));
}

export function isEuRemoteLocation(location: string): boolean {
  const normalized = normalizeForMatch(location);
  if (!normalized) return true; // Unknown remote scope is kept and flagged for review.
  if (RESTRICTED_HINTS.some((hint) => normalized.includes(hint))) return false;
  if (EU_HINTS.some((hint) => normalized.includes(hint))) return true;
  if (NON_EU_COUNTRY_PATTERN.test(normalized) || NON_EU_CITY_PATTERN.test(normalized)) return false;
  // A label such as "Remote", "Remote job" or "Homeoffice" says nothing about the
  // country. Keep it and let the caller flag the scope for review instead of dropping a
  // legitimate Germany-remote vacancy.
  const residual = normalized
    .split(' ')
    .filter((word) => word.length > 0 && !GENERIC_REMOTE_WORDS.has(word))
    .join(' ');
  return residual.length === 0;
}

/**
 * Explicit evidence that a remote role may be done from Germany. Null means the posting
 * does not state it; false means the posting restricts applicants to another region.
 * This is deliberately strict: a worldwide/Europe label alone is not positive evidence.
 */
export function remoteEligibilityFromGermany(input: {
  location: string;
  country: string;
  description?: string | null;
}): boolean | null {
  const text = normalizeForMatch(`${input.location}\n${input.description ?? ''}`);
  if (input.country === 'Germany') return true;
  if (RESTRICTED_HINTS.some((hint) => text.includes(hint))) return false;
  if (NON_EU_COUNTRY_PATTERN.test(text) && !/\b(europe|eu|emea|worldwide|global|anywhere)\b/.test(text)) {
    return false;
  }
  if (
    /\b(remote|homeoffice|home office|work from home)\b[^.]{0,80}\b(germany|deutschland)\b/.test(text) ||
    /\b(germany|deutschland)\b[^.]{0,80}\b(remote|homeoffice|home office)\b/.test(text)
  ) {
    return true;
  }
  return null;
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
  const country = input.country ?? detectCountry(input.location);
  const workArrangement =
    input.workArrangement ??
    detectWorkArrangement(input.title, input.location, description, input.remote);
  return {
    ...input,
    description,
    descriptionHtml: input.descriptionHtml,
    simulated: input.simulated ?? input.source === 'mock',
    canonicalUrl: canonicalizeUrl(input.url),
    applicationUrl: safeHttpUrl(input.applicationUrl) || canonicalizeUrl(input.url),
    salaryMin: input.salaryMin ?? parseSalaryRange(input.salary).min,
    salaryMax: input.salaryMax ?? parseSalaryRange(input.salary).max,
    employer: normalizeWhitespace(input.employer) || 'Unknown employer',
    title: normalizeWhitespace(input.title) || 'Untitled role',
    location: normalizeWhitespace(input.location),
    country,
    workArrangement,
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
    // Only remote roles can have remote-from-Germany eligibility. An on-site role leaves
    // this null so the dashboard filter cannot mislabel it.
    remoteEligibleFromGermany:
      workArrangement === 'remote'
        ? remoteEligibilityFromGermany({
            location: input.location ?? '',
            country,
            description,
          })
        : null,
  };
}
