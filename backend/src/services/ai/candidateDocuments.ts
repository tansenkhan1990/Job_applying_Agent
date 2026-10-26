import { CandidateProfileModel } from '../../models/CandidateProfile.js';
import { DocumentModel } from '../../models/Document.js';
import { PROFILE_KINDS, type ProfileKind } from '../../config/defaults.js';
import { normalizeForMatch, normalizeWhitespace, truncate } from '../../utils/text.js';
import { skillPresent } from '../matching/scoring.js';
import { titleRelevance } from '../jobs/filters.js';
import { sha256 } from '../../utils/hash.js';

export interface CandidateDocumentSet {
  profileId: string;
  profileKind: ProfileKind;
  label: string;
  name: string;
  targetTitles: string[];
  skills: string[];
  experienceSummary: string;
  yearsExperience: number | null;
  location: string;
  languages: Array<{ language: string; level: string }>;
  education: Array<{ degree: string; institution: string; year: string }>;
  certifications: string[];
  projects: Array<{ name: string; summary: string; technologies: string[] }>;
  publications: string[];
  cvDocumentId: string | null;
  cvFilename: string;
  cvStatus: string;
  cvText: string;
  referenceDocumentId: string | null;
  referenceFilename: string;
  referenceStatus: string;
  referenceText: string;
}

export interface RankedCandidateDocument {
  document: CandidateDocumentSet;
  score: number;
  rationale: string;
}

export interface DocumentSelection {
  cvProfileId: string;
  referenceProfileId: string;
  rationale: string;
  limitations: string[];
}

export interface DocumentEvidence {
  selected: CandidateDocumentSet;
  reference: CandidateDocumentSet | null;
  selectedCvText: string;
  referenceLetterText: string;
  otherCvEvidence: Array<{ label: string; filename: string; excerpts: string }>;
  otherLetterEvidence: Array<{ label: string; filename: string; excerpts: string }>;
  limitations: string[];
  matchedSkills: string[];
  /** Full verified document texts used for grounding checks. */
  groundingTexts: string[];
}

const STOPWORDS = new Set([
  'the','and','for','with','you','your','our','are','will','that','this','from','have','has',
  'not','but','all','can','who','what','when','where','how','their','they','them','its','into',
  'over','more','also','work','working','role','team','teams','job','position','company',
  'experience','years','year','skills','required','requirements','preferred','nice','plus',
  'using','use','build','building','develop','development','strong','good','knowledge',
  'understanding','ability','about','would','should','could','apply','application','please',
  'will','may','must','our','we','us','as','in','on','to','of','a','an','is','be','or','at',
  'by','it','this','that','these','those','candidate','candidates','research','researcher',
  'phd','doctoral','doctorate','university','institute','group','project','projects',
]);

function tokens(text: string): Set<string> {
  return new Set(
    normalizeForMatch(text)
      .split(/[^a-z0-9+#.]+/)
      .filter((token) => token.length > 2 && !STOPWORDS.has(token)),
  );
}

function overlapRatio(text: string, query: Set<string>): number {
  const own = tokens(text);
  if (own.size === 0 || query.size === 0) return 0;
  let hits = 0;
  for (const token of own) if (query.has(token)) hits += 1;
  return Math.min(1, hits / Math.min(18, Math.max(6, query.size)));
}

/** Split into sentences/lines and keep the most query-relevant passages, in original order. */
export function relevantExcerpts(text: string, query: string, maxChars: number): string {
  if (!text.trim() || maxChars <= 0) return '';
  const queryTokens = tokens(query);
  const parts = normalizeWhitespace(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 18);
  if (parts.length === 0) return truncate(text, maxChars);

  const ranked = parts
    .map((part, index) => {
      const own = tokens(part);
      let hits = 0;
      for (const token of own) if (queryTokens.has(token)) hits += 1;
      const density = own.size > 0 ? hits / Math.sqrt(own.size) : 0;
      return { part, index, density };
    })
    .sort((a, b) => b.density - a.density);

  const chosen: Array<{ part: string; index: number }> = [];
  let length = 0;
  for (const item of ranked) {
    if (length + item.part.length > maxChars) continue;
    chosen.push(item);
    length += item.part.length + 1;
    if (length >= maxChars * 0.85) break;
  }
  if (chosen.length === 0) return truncate(parts[0] ?? text, maxChars);
  return chosen
    .sort((a, b) => a.index - b.index)
    .map((item) => item.part)
    .join('\n');
}

/** Snapshot hash used to detect material job/PhD description changes. */
export function targetContentHash(parts: Array<string | null | undefined>): string {
  return sha256(parts.map((part) => part ?? '').join('\n'));
}

export async function loadCandidateDocumentSets(): Promise<CandidateDocumentSet[]> {
  const profiles = await CandidateProfileModel.find({ kind: { $in: PROFILE_KINDS } });
  const ids = profiles.flatMap((profile) =>
    [profile.cvDocument, profile.coverLetterDocument].filter(Boolean),
  );
  const docs = await DocumentModel.find({ _id: { $in: ids } }).select('+text');
  const byId = new Map(docs.map((doc) => [String(doc._id), doc]));

  const sets = profiles.map((profile) => {
    const cv = profile.cvDocument ? byId.get(String(profile.cvDocument)) : undefined;
    const reference = profile.coverLetterDocument
      ? byId.get(String(profile.coverLetterDocument))
      : undefined;
    return {
      profileId: String(profile._id),
      profileKind: profile.kind,
      label: profile.label,
      name: profile.name,
      targetTitles: profile.targetTitles ?? [],
      skills: profile.skills ?? [],
      experienceSummary: profile.experienceSummary ?? '',
      yearsExperience: profile.yearsExperience ?? null,
      location: profile.location ?? '',
      languages: (profile.languages ?? []).map((item) => ({
        language: item.language,
        level: item.level,
      })),
      education: (profile.education ?? []).map((item) => ({
        degree: item.degree,
        institution: item.institution,
        year: item.year ?? '',
      })),
      certifications: profile.certifications ?? [],
      projects: (profile.projects ?? []).map((item) => ({
        name: item.name,
        summary: item.summary ?? '',
        technologies: item.technologies ?? [],
      })),
      publications: profile.publications ?? [],
      cvDocumentId: cv?._id ? String(cv._id) : null,
      cvFilename: cv?.filename ?? '',
      cvStatus: cv?.status ?? (profile.cvDocument ? 'unknown' : 'not mapped'),
      cvText: cv?.text ?? '',
      referenceDocumentId: reference?._id ? String(reference._id) : null,
      referenceFilename: reference?.filename ?? '',
      referenceStatus: reference?.status ?? (profile.coverLetterDocument ? 'unknown' : 'not mapped'),
      referenceText: reference?.text ?? '',
    } satisfies CandidateDocumentSet;
  });

  return sets.sort(
    (a, b) => PROFILE_KINDS.indexOf(a.profileKind) - PROFILE_KINDS.indexOf(b.profileKind),
  );
}

export function rankCandidateDocuments(input: {
  documents: CandidateDocumentSet[];
  jobText: string;
  jobTitle: string;
  matchScores?: Map<string, number>;
}): RankedCandidateDocument[] {
  const jobTokens = tokens(input.jobText);
  return [...input.documents]
    .map((document) => {
      const skills = document.skills.filter((skill) => skillPresent(input.jobText, skill));
      const titleFit = titleRelevance(input.jobTitle, document.targetTitles);
      const textFit = overlapRatio(
        [
          document.experienceSummary,
          ...document.projects.map((project) => `${project.name} ${project.summary}`),
          ...document.publications,
        ].join(' '),
        jobTokens,
      );
      const matchScore = Math.max(0, Math.min(1, (input.matchScores?.get(document.profileId) ?? 0) / 100));
      const skillFit = Math.min(1, skills.length / 6);
      const score = skillFit * 0.4 + titleFit * 0.25 + textFit * 0.15 + matchScore * 0.2;
      const bits: string[] = [];
      if (skills.length > 0) bits.push(`overlaps ${skills.slice(0, 5).join(', ')}`);
      if (titleFit >= 0.5) bits.push('title matches the profile target titles');
      if (matchScore > 0) bits.push(`stored match ${Math.round(matchScore * 100)}/100`);
      return {
        document,
        score,
        rationale: bits.length > 0 ? bits.join('; ') : 'no strong keyword or title evidence',
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function selectCandidateDocuments(input: {
  documents: CandidateDocumentSet[];
  jobText: string;
  jobTitle: string;
  preferredCvProfileId?: string;
  preferredReferenceProfileId?: string;
  matchScores?: Map<string, number>;
}): { selection: DocumentSelection; ranked: RankedCandidateDocument[] } {
  const ranked = rankCandidateDocuments(input);
  const withCv = ranked.filter((item) => item.document.cvText.trim());
  const preferredCv = input.preferredCvProfileId
    ? ranked.find((item) => item.document.profileId === input.preferredCvProfileId)
    : undefined;
  const selected =
    preferredCv && preferredCv.document.cvText.trim()
      ? preferredCv
      : withCv[0] ?? ranked[0];

  const withLetter = ranked.filter((item) => item.document.referenceText.trim());
  const preferredReference = input.preferredReferenceProfileId
    ? withLetter.find((item) => item.document.profileId === input.preferredReferenceProfileId)
    : undefined;
  const reference =
    preferredReference ??
    [...withLetter].sort((a, b) => {
      const aBonus = a.document.profileId === selected?.document.profileId ? 0.2 : 0;
      const bBonus = b.document.profileId === selected?.document.profileId ? 0.2 : 0;
      return b.score + bBonus - (a.score + aBonus);
    })[0] ??
    null;

  const limitations: string[] = [];
  if (!selected || !selected.document.cvText.trim()) {
    limitations.push('No readable CV text is available. Map and process at least one CV.');
  }
  if (withCv.length < input.documents.length) {
    limitations.push(
      `${input.documents.length - withCv.length} of ${input.documents.length} profiles have no readable CV text.`,
    );
  }
  if (!reference || !reference.document.referenceText.trim()) {
    limitations.push('No readable existing cover letter is available as a writing reference.');
  }
  if (withLetter.length < input.documents.length) {
    limitations.push(
      `${input.documents.length - withLetter.length} of ${input.documents.length} profiles have no readable existing cover letter.`,
    );
  }

  const rationale = selected
    ? `Selected ${selected.document.label} CV: ${selected.rationale}. ${
        reference
          ? `Using the ${reference.document.label} existing letter for tone and structure.`
          : 'No reference letter available.'
      }`
    : 'No candidate CV available.';

  return {
    selection: {
      cvProfileId: selected?.document.profileId ?? '',
      referenceProfileId: reference?.document.profileId ?? '',
      rationale,
      limitations,
    },
    ranked,
  };
}

export function buildDocumentEvidence(input: {
  documents: CandidateDocumentSet[];
  selection: DocumentSelection;
  jobText: string;
  jobTitle: string;
}): DocumentEvidence {
  const selected =
    input.documents.find((doc) => doc.profileId === input.selection.cvProfileId) ??
    input.documents[0];
  const reference =
    input.documents.find((doc) => doc.profileId === input.selection.referenceProfileId) ?? null;
  const query = `${input.jobTitle}\n${input.jobText}`;

  const limitations = [...input.selection.limitations];
  if (!selected?.cvText.trim()) limitations.push('The selected CV has no extracted text.');
  if (!reference?.referenceText.trim()) {
    limitations.push('No reference cover letter text is available; generate without a style reference.');
  }

  return {
    selected: selected as CandidateDocumentSet,
    reference,
    selectedCvText: truncate(selected?.cvText ?? '', 6_500),
    referenceLetterText: truncate(reference?.referenceText ?? '', 3_000),
    otherCvEvidence: input.documents
      .filter((doc) => doc.profileId !== selected?.profileId && doc.cvText.trim())
      .map((doc) => ({
        label: doc.label,
        filename: doc.cvFilename,
        excerpts: relevantExcerpts(doc.cvText, query, 1_200),
      })),
    otherLetterEvidence: input.documents
      .filter((doc) => doc.profileId !== reference?.profileId && doc.referenceText.trim())
      .map((doc) => ({
        label: doc.label,
        filename: doc.referenceFilename,
        excerpts: relevantExcerpts(doc.referenceText, query, 700),
      })),
    limitations,
    matchedSkills: selected
      ? selected.skills.filter((skill) => skillPresent(input.jobText, skill)).slice(0, 12)
      : [],
    groundingTexts: input.documents.flatMap((doc) => [doc.cvText, doc.referenceText]).filter(Boolean),
  };
}

export function candidateSummary(document: CandidateDocumentSet): string {
  return truncate(
    JSON.stringify(
      {
        profile: document.label,
        cv: document.cvFilename || 'not mapped',
        referenceLetter: document.referenceFilename || 'not mapped',
        skills: document.skills,
        yearsExperience: document.yearsExperience,
        experienceSummary: document.experienceSummary,
        education: document.education,
        publications: document.publications,
        certifications: document.certifications,
        projects: document.projects,
        languages: document.languages,
      },
      null,
      2,
    ),
    2_400,
  );
}
