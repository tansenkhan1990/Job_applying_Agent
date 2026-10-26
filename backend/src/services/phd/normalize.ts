import { createHash } from 'node:crypto';
import type { WorkArrangement } from '../../config/defaults.js';
import { normalizeWhitespace, stripHtml } from '../../utils/text.js';
import { canonicalizeUrl, safeHttpUrl } from '../jobs/normalize.js';
import { classifyLanguage } from '../jobs/language.js';
import { skillPresent } from '../matching/scoring.js';
import {
  assessPhdDeadline,
  classifyPhdResearchArea,
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

function inferCountry(location: string, explicit: string | undefined): string {
  if (explicit?.trim()) return explicit.trim();
  if (/\bgermany\b|\bdeutschland\b/i.test(location)) return 'Germany';
  const germanCities =
    /\b(berlin|munich|münchen|hamburg|frankfurt|cologne|köln|stuttgart|dresden|leipzig|heidelberg|aachen|bonn|göttingen|goettingen|tübingen|tuebingen|karlsruhe|freiburg|jena|potsdam|bremen|hannover|nuremberg|nürnberg)\b/i;
  if (germanCities.test(location)) return 'Germany';
  return '';
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
  const deadlineAssessment = assessPhdDeadline({
    deadline,
    timezone: deadlineTimezone,
    hasTime: deadlineHasTime,
    closed: raw.closed,
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
 * Germany: all arrangements. Outside Germany: only explicit remote positions that state
 * remote eligibility from Germany. A remote label alone is not sufficient.
 */
export function passesPhdLocationRule(listing: PhdListing): { included: boolean; reason: string } {
  if (listing.country === 'Germany') {
    return { included: true, reason: 'Germany-based position.' };
  }
  if (listing.workArrangement !== 'remote') {
    return {
      included: false,
      reason: 'Outside Germany, only remote positions are considered.',
    };
  }
  if (listing.remoteEligibleFromGermany !== true) {
    return {
      included: false,
      reason: 'Remote eligibility from Germany is not explicitly confirmed by the advertisement.',
    };
  }
  return { included: true, reason: 'Remote outside Germany with explicit eligibility from Germany.' };
}
