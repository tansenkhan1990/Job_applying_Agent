import { createHash } from 'node:crypto';
import type { WorkArrangement } from '../../config/defaults.js';
import { normalizeWhitespace, stripHtml } from '../../utils/text.js';
import { canonicalizeUrl, safeHttpUrl } from '../jobs/normalize.js';
import { classifyLanguage } from '../jobs/language.js';
import { skillPresent } from '../matching/scoring.js';
import {
  assessPhdDeadline,
  classifyPhdFunding,
  classifyPhdResearchArea,
  detectRollingAdmissions,
  isDateOnlyDeadline,
} from './metadata.js';
import type { PhdListing } from './types.js';

export const PHD_SKILLS = [
  'Python',
  'R',
  'Java',
  'C++',
  'JavaScript',
  'TypeScript',
  'SQL',
  'SPARQL',
  'Cypher',
  'RDF',
  'OWL',
  'Neo4j',
  'Knowledge graphs',
  'Graph neural networks',
  'Graph representation learning',
  'Machine learning',
  'Deep learning',
  'PyTorch',
  'TensorFlow',
  'scikit-learn',
  'Transformers',
  'Large language models',
  'Retrieval-Augmented Generation',
  'NLP',
  'Semantic web',
  'Linked data',
  'Ontologies',
  'Data mining',
  'Spatio-temporal data',
  'Recommender systems',
  'Information retrieval',
  'Vector databases',
  'Docker',
  'Kubernetes',
  'AWS',
  'Google Cloud Platform',
  'Git',
  'Linux',
  'Research software engineering',
  'Software engineering',
  'Statistics',
  'Bayesian methods',
  'Causal inference',
];

export interface RawPhdListing {
  source: string;
  sourceJobId: string;
  sourceLabel: string;
  simulated?: boolean;
  url: string;
  applicationUrl?: string;
  institution: string;
  title: string;
  researchGroup?: string;
  supervisor?: string;
  department?: string;
  location?: string;
  country?: string;
  workArrangement?: WorkArrangement | 'unknown';
  remoteEligibleFromGermany?: boolean | null;
  researchTopic?: string;
  description?: string;
  requiredQualifications?: string[];
  requiredSkills?: string[];
  preferredSkills?: string[];
  requiredLanguages?: string[];
  funding?: string;
  salary?: string;
  employmentRequirements?: string[];
  postedAt?: Date | string | null;
  applicationDeadline?: Date | string | null;
  deadlineTimezone?: string;
  /** True only when the official source states the position is closed or filled. */
  closed?: boolean;
  expectedStartDate?: string;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    output.push(trimmed);
  }
  return output;
}

const REQUIREMENT_HEADING =
  /^(requirements?|qualifications?|your profile|what you bring|we expect|your background|profile)\b/i;

/** Pull bullet-style qualifications from an explicitly labelled requirements section. */
export function extractQualifications(description: string): string[] {
  const lines = normalizeWhitespace(description).split(/\n+/).map((line) => line.trim());
  const found: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (REQUIREMENT_HEADING.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (/^[A-Z][A-Za-z ]{2,40}:$/.test(line)) break;
    const cleaned = line.replace(/^[-•*\u2022\d.)\s]+/, '').trim();
    if (cleaned.length >= 15 && cleaned.length <= 300) found.push(cleaned);
    if (found.length >= 12) break;
  }
  return unique(found);
}

function extractSkills(text: string): string[] {
  return PHD_SKILLS.filter((skill) => skillPresent(text, skill));
}

/** European countries whose doctoral positions are in scope. */
const EUROPE_COUNTRIES = [
  'Albania',
  'Austria',
  'Belgium',
  'Bosnia and Herzegovina',
  'Bulgaria',
  'Croatia',
  'Cyprus',
  'Czech Republic',
  'Denmark',
  'Estonia',
  'Finland',
  'France',
  'Germany',
  'Greece',
  'Hungary',
  'Iceland',
  'Ireland',
  'Italy',
  'Kosovo',
  'Latvia',
  'Liechtenstein',
  'Lithuania',
  'Luxembourg',
  'Malta',
  'Moldova',
  'Monaco',
  'Montenegro',
  'Netherlands',
  'North Macedonia',
  'Norway',
  'Poland',
  'Portugal',
  'Romania',
  'Serbia',
  'Slovakia',
  'Slovenia',
  'Spain',
  'Sweden',
  'Switzerland',
  'Ukraine',
  'United Kingdom',
] as const;

/** The countries a discovery run may store. Everything else is filtered out. */
export const PHD_TARGET_COUNTRIES = new Set<string>([
  ...EUROPE_COUNTRIES,
  // A Europe-wide remote advertisement is still a European position.
  'Europe',
  'Turkey',
  'United States',
  'Canada',
  'Malaysia',
]);

export const PHD_TARGET_REGIONS_LABEL = 'Europe, Turkey, the USA, Canada and Malaysia';

const COUNTRY_ALIASES: Array<[string, string]> = [
  ...EUROPE_COUNTRIES.map((country): [string, string] => [country.toLowerCase(), country]),
  ['deutschland', 'Germany'],
  ['österreich', 'Austria'],
  ['oesterreich', 'Austria'],
  ['belgië', 'Belgium'],
  ['belgique', 'Belgium'],
  ['czechia', 'Czech Republic'],
  ['česko', 'Czech Republic'],
  ['españa', 'Spain'],
  ['espana', 'Spain'],
  ['suomi', 'Finland'],
  ['sverige', 'Sweden'],
  ['norge', 'Norway'],
  ['danmark', 'Denmark'],
  ['schweiz', 'Switzerland'],
  ['suisse', 'Switzerland'],
  ['italia', 'Italy'],
  ['polska', 'Poland'],
  ['nederland', 'Netherlands'],
  ['holland', 'Netherlands'],
  ['the netherlands', 'Netherlands'],
  ['europe', 'Europe'],
  ['european union', 'Europe'],
  ['eu', 'Europe'],
  ['uk', 'United Kingdom'],
  ['u.k.', 'United Kingdom'],
  ['great britain', 'United Kingdom'],
  ['britain', 'United Kingdom'],
  ['england', 'United Kingdom'],
  ['scotland', 'United Kingdom'],
  ['wales', 'United Kingdom'],
  ['northern ireland', 'United Kingdom'],
  ['usa', 'United States'],
  ['u.s.a.', 'United States'],
  ['u.s.', 'United States'],
  ['us', 'United States'],
  ['united states of america', 'United States'],
  ['turkiye', 'Turkey'],
  ['türkiye', 'Turkey'],
  ['republic of turkey', 'Turkey'],
  ['malaysia', 'Malaysia'],
];

const COUNTRY_ALIAS_LOOKUP = new Map(
  COUNTRY_ALIASES.map(([alias, country]) => [alias.toLowerCase(), country]),
);

// Only used when an advertisement omits the country but names a well-known host city.
const CITY_COUNTRY: Array<[string, string]> = [
  ['berlin', 'Germany'],
  ['munich', 'Germany'],
  ['münchen', 'Germany'],
  ['hamburg', 'Germany'],
  ['frankfurt', 'Germany'],
  ['cologne', 'Germany'],
  ['köln', 'Germany'],
  ['stuttgart', 'Germany'],
  ['dresden', 'Germany'],
  ['leipzig', 'Germany'],
  ['heidelberg', 'Germany'],
  ['aachen', 'Germany'],
  ['bonn', 'Germany'],
  ['göttingen', 'Germany'],
  ['tübingen', 'Germany'],
  ['karlsruhe', 'Germany'],
  ['freiburg', 'Germany'],
  ['jena', 'Germany'],
  ['potsdam', 'Germany'],
  ['bremen', 'Germany'],
  ['hannover', 'Germany'],
  ['nuremberg', 'Germany'],
  ['nürnberg', 'Germany'],
  ['amsterdam', 'Netherlands'],
  ['utrecht', 'Netherlands'],
  ['rotterdam', 'Netherlands'],
  ['leiden', 'Netherlands'],
  ['delft', 'Netherlands'],
  ['eindhoven', 'Netherlands'],
  ['groningen', 'Netherlands'],
  ['nijmegen', 'Netherlands'],
  ['maastricht', 'Netherlands'],
  ['london', 'United Kingdom'],
  ['oxford', 'United Kingdom'],
  ['edinburgh', 'United Kingdom'],
  ['manchester', 'United Kingdom'],
  ['bristol', 'United Kingdom'],
  ['zurich', 'Switzerland'],
  ['zürich', 'Switzerland'],
  ['geneva', 'Switzerland'],
  ['lausanne', 'Switzerland'],
  ['basel', 'Switzerland'],
  ['bern', 'Switzerland'],
  ['vienna', 'Austria'],
  ['wien', 'Austria'],
  ['graz', 'Austria'],
  ['linz', 'Austria'],
  ['innsbruck', 'Austria'],
  ['paris', 'France'],
  ['lyon', 'France'],
  ['grenoble', 'France'],
  ['toulouse', 'France'],
  ['marseille', 'France'],
  ['bordeaux', 'France'],
  ['lille', 'France'],
  ['strasbourg', 'France'],
  ['copenhagen', 'Denmark'],
  ['københavn', 'Denmark'],
  ['aarhus', 'Denmark'],
  ['stockholm', 'Sweden'],
  ['gothenburg', 'Sweden'],
  ['göteborg', 'Sweden'],
  ['uppsala', 'Sweden'],
  ['oslo', 'Norway'],
  ['trondheim', 'Norway'],
  ['helsinki', 'Finland'],
  ['espoo', 'Finland'],
  ['tampere', 'Finland'],
  ['reykjavik', 'Iceland'],
  ['brussels', 'Belgium'],
  ['bruxelles', 'Belgium'],
  ['leuven', 'Belgium'],
  ['ghent', 'Belgium'],
  ['antwerp', 'Belgium'],
  ['dublin', 'Ireland'],
  ['cork', 'Ireland'],
  ['galway', 'Ireland'],
  ['milan', 'Italy'],
  ['milano', 'Italy'],
  ['rome', 'Italy'],
  ['roma', 'Italy'],
  ['turin', 'Italy'],
  ['torino', 'Italy'],
  ['bologna', 'Italy'],
  ['padua', 'Italy'],
  ['pisa', 'Italy'],
  ['madrid', 'Spain'],
  ['barcelona', 'Spain'],
  ['valencia', 'Spain'],
  ['seville', 'Spain'],
  ['bilbao', 'Spain'],
  ['lisbon', 'Portugal'],
  ['lisboa', 'Portugal'],
  ['porto', 'Portugal'],
  ['coimbra', 'Portugal'],
  ['warsaw', 'Poland'],
  ['warszawa', 'Poland'],
  ['krakow', 'Poland'],
  ['kraków', 'Poland'],
  ['wroclaw', 'Poland'],
  ['wrocław', 'Poland'],
  ['poznan', 'Poland'],
  ['gdansk', 'Poland'],
  ['prague', 'Czech Republic'],
  ['praha', 'Czech Republic'],
  ['brno', 'Czech Republic'],
  ['budapest', 'Hungary'],
  ['bucharest', 'Romania'],
  ['sofia', 'Bulgaria'],
  ['athens', 'Greece'],
  ['thessaloniki', 'Greece'],
  ['zagreb', 'Croatia'],
  ['ljubljana', 'Slovenia'],
  ['belgrade', 'Serbia'],
  ['bratislava', 'Slovakia'],
  ['tallinn', 'Estonia'],
  ['riga', 'Latvia'],
  ['vilnius', 'Lithuania'],
  ['kyiv', 'Ukraine'],
  ['ankara', 'Turkey'],
  ['istanbul', 'Turkey'],
  ['izmir', 'Turkey'],
  ['boston', 'United States'],
  ['new york', 'United States'],
  ['san francisco', 'United States'],
  ['berkeley', 'United States'],
  ['palo alto', 'United States'],
  ['seattle', 'United States'],
  ['austin', 'United States'],
  ['chicago', 'United States'],
  ['los angeles', 'United States'],
  ['san diego', 'United States'],
  ['atlanta', 'United States'],
  ['pittsburgh', 'United States'],
  ['ann arbor', 'United States'],
  ['madison', 'United States'],
  ['urbana', 'United States'],
  ['champaign', 'United States'],
  ['princeton', 'United States'],
  ['new haven', 'United States'],
  ['philadelphia', 'United States'],
  ['baltimore', 'United States'],
  ['durham', 'United States'],
  ['houston', 'United States'],
  ['denver', 'United States'],
  ['boulder', 'United States'],
  ['minneapolis', 'United States'],
  ['toronto', 'Canada'],
  ['montreal', 'Canada'],
  ['montréal', 'Canada'],
  ['vancouver', 'Canada'],
  ['ottawa', 'Canada'],
  ['waterloo', 'Canada'],
  ['edmonton', 'Canada'],
  ['calgary', 'Canada'],
  ['halifax', 'Canada'],
  ['winnipeg', 'Canada'],
  ['kuala lumpur', 'Malaysia'],
  ['putrajaya', 'Malaysia'],
  ['cyberjaya', 'Malaysia'],
  ['penang', 'Malaysia'],
  ['george town', 'Malaysia'],
  ['johor bahru', 'Malaysia'],
  ['serdang', 'Malaysia'],
  ['skudai', 'Malaysia'],
  ['bangi', 'Malaysia'],
  ['shah alam', 'Malaysia'],
  ['kota kinabalu', 'Malaysia'],
  ['kuching', 'Malaysia'],
];

/** Canonical country name for a feed value, or the trimmed original when unrecognised. */
export function normalizeCountryName(value: string | undefined): string {
  const trimmed = normalizeWhitespace(value ?? '');
  if (!trimmed) return '';
  return COUNTRY_ALIAS_LOOKUP.get(trimmed.toLowerCase()) ?? trimmed;
}

function countryFromText(location: string): string {
  if (!location) return '';
  const aliases = [...COUNTRY_ALIASES].sort(([a], [b]) => b.length - a.length);
  for (const [alias, country] of aliases) {
    if (alias.length < 3) continue;
    if (new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(location)) {
      return country;
    }
  }
  for (const [city, country] of CITY_COUNTRY) {
    if (new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(location)) {
      return country;
    }
  }
  return '';
}

function inferCountry(location: string, explicit: string | undefined): string {
  const stated = normalizeCountryName(explicit);
  if (stated) return stated;
  return countryFromText(location);
}

export function phdFingerprint(institution: string, title: string, country: string): string {
  const key = `${institution} ${title} ${country}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return createHash('sha256').update(key).digest('hex').slice(0, 40);
}

export function normalizePhdListing(raw: RawPhdListing): PhdListing | null {
  const url = safeHttpUrl(raw.url);
  const institution = normalizeWhitespace(raw.institution ?? '');
  const title = normalizeWhitespace(raw.title ?? '');
  if (!url || !institution || !title) return null;

  const description = stripHtml(raw.description ?? '').slice(0, 30_000);
  const location = normalizeWhitespace(raw.location ?? '');
  const country = inferCountry(location, raw.country);
  const topic = normalizeWhitespace(raw.researchTopic ?? '') || title;

  const classification = classifyLanguage({ title, location, description });
  const languageDecision =
    classification.languageDecision === 'Excluded'
      ? 'Excluded'
      : classification.languageDecision === 'Eligible'
        ? 'Eligible'
        : 'Needs Review';

  const combinedText = `${title}\n${topic}\n${description}`;
  const researchArea = classifyPhdResearchArea(combinedText);
  const detectedSkills = extractSkills(combinedText);
  const requiredSkills = unique([...(raw.requiredSkills ?? []), ...detectedSkills]).slice(0, 20);
  const preferredSkills = unique(raw.preferredSkills ?? [])
    .filter((skill) => !requiredSkills.some((required) => required.toLowerCase() === skill.toLowerCase()))
    .slice(0, 15);

  const postedAt = toDate(raw.postedAt);
  const deadline = toDate(raw.applicationDeadline);
  const deadlineTimezone = normalizeWhitespace(raw.deadlineTimezone ?? '');
  const deadlineHasTime = Boolean(raw.applicationDeadline) && !isDateOnlyDeadline(raw.applicationDeadline);
  const rollingAdmissions = detectRollingAdmissions(combinedText);
  const deadlineAssessment = assessPhdDeadline({
    deadline,
    timezone: deadlineTimezone,
    hasTime: deadlineHasTime,
    closed: raw.closed,
    rolling: rollingAdmissions,
  });
  const status =
    deadlineAssessment.status === 'closed'
      ? 'closed'
      : deadlineAssessment.status === 'expired'
        ? 'expired'
        : 'active';

  const qualifications = unique([
    ...(raw.requiredQualifications ?? []),
    ...extractQualifications(description),
  ]).slice(0, 12);

  const workArrangement = raw.workArrangement ?? 'unknown';
  const remoteEligible =
    typeof raw.remoteEligibleFromGermany === 'boolean' ? raw.remoteEligibleFromGermany : null;
  const funding = classifyPhdFunding({
    funding: raw.funding,
    salary: raw.salary,
    description,
  });

  return {
    source: raw.source,
    sourceJobId: raw.sourceJobId,
    sourceLabel: raw.sourceLabel,
    simulated: Boolean(raw.simulated),
    url,
    canonicalUrl: canonicalizeUrl(url),
    applicationUrl: safeHttpUrl(raw.applicationUrl) || url,
    institution,
    title,
    researchGroup: normalizeWhitespace(raw.researchGroup ?? ''),
    supervisor: normalizeWhitespace(raw.supervisor ?? ''),
    department: normalizeWhitespace(raw.department ?? ''),
    location,
    country,
    workArrangement,
    remoteEligibleFromGermany: remoteEligible,
    researchTopic: topic,
    researchArea: researchArea.area,
    researchAreaEvidence: researchArea.evidence,
    description,
    requiredQualifications: qualifications,
    requiredSkills,
    preferredSkills,
    requiredMethods: detectedSkills.slice(0, 12),
    requiredLanguages: unique([
      ...(raw.requiredLanguages ?? []),
      ...(classification.englishRequired ? ['English'] : []),
      ...(classification.germanRequired ? ['German'] : []),
    ]),
    funding: normalizeWhitespace(raw.funding ?? ''),
    fundingStatus: funding.status,
    fundingEvidence: funding.evidence,
    salary: normalizeWhitespace(raw.salary ?? ''),
    employmentRequirements: unique(raw.employmentRequirements ?? []).slice(0, 10),
    languageRequirement: classification.languageRequirement,
    languageDecision,
    languageEvidence: classification.languageEvidence,
    languageReason: classification.languageReason,
    languageConfidence: classification.languageConfidence,
    postedAt: postedAt ?? null,
    postedAtUnknown: !postedAt,
    applicationDeadline: deadline,
    deadlineTimezone,
    deadlineHasTime,
    rollingAdmissions,
    deadlineStatus: deadlineAssessment.status,
    deadlineNote: deadlineAssessment.note,
    expectedStartDate: normalizeWhitespace(raw.expectedStartDate ?? ''),
    status,
    statusNote:
      deadlineAssessment.status === 'closed' || deadlineAssessment.status === 'expired'
        ? deadlineAssessment.note
        : deadlineAssessment.status === 'unknown'
          ? 'The application deadline needs verification at the official source.'
          : '',
    fingerprint: phdFingerprint(institution, title, country),
    contentHash: createHash('sha256').update(combinedText).digest('hex'),
  };
}

/**
 * Only doctoral positions in Europe, Turkey, the USA, Canada and Malaysia are in scope, whatever
 * the work
 * arrangement. A position whose country cannot be established is not guessed into the list.
 */
export function passesPhdLocationRule(listing: PhdListing): { included: boolean; reason: string } {
  const country = normalizeCountryName(listing.country) || countryFromText(listing.location);
  if (!country) {
    return {
      included: false,
      reason: `The advertisement does not state a country inside ${PHD_TARGET_REGIONS_LABEL}.`,
    };
  }
  if (PHD_TARGET_COUNTRIES.has(country)) {
    return { included: true, reason: `${country} is inside ${PHD_TARGET_REGIONS_LABEL}.` };
  }
  return {
    included: false,
    reason: `${country} is outside ${PHD_TARGET_REGIONS_LABEL}.`,
  };
}
