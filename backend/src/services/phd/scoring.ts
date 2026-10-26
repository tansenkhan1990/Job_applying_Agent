import type { CandidateProfileRecord } from '../../models/CandidateProfile.js';
import { skillPresent } from '../matching/scoring.js';

export const PHD_MATCH_WEIGHTS = {
  researchTopic: 30,
  technicalSkills: 25,
  researchExperience: 20,
  academicQualifications: 15,
  methods: 10,
} as const;

export type PhdCategoryKey = keyof typeof PHD_MATCH_WEIGHTS;

export interface PhdCategory {
  key: PhdCategoryKey;
  label: string;
  weight: number;
  score: number;
  detail: string;
}

export interface PhdFitPosition {
  title: string;
  institution: string;
  researchTopic?: string | null;
  description?: string | null;
  requiredSkills?: string[] | null;
  preferredSkills?: string[] | null;
  requiredMethods?: string[] | null;
  requiredQualifications?: string[] | null;
  languageDecision?: string | null;
  languageReason?: string | null;
}

export interface PhdFitResult {
  score: number;
  categories: PhdCategory[];
  matchedTopics: string[];
  missingTopics: string[];
  matchedSkills: string[];
  missingSkills: string[];
  matchedPublications: string[];
  mandatoryMissing: string[];
  qualifications: string[];
  strengths: string[];
  concerns: string[];
  explanation: string;
  reviewRequired: boolean;
}

const RESEARCH_TOPICS: Array<{ label: string; variants: string[] }> = [
  {
    label: 'Knowledge graphs',
    variants: ['knowledge graph', 'knowledge graphs', 'property graph', 'graph database'],
  },
  {
    label: 'Graph machine learning',
    variants: ['graph machine learning', 'graph neural', 'graph representation learning', 'gnn'],
  },
  {
    label: 'Artificial intelligence',
    variants: ['artificial intelligence', 'ai'],
  },
  {
    label: 'Large language models',
    variants: ['large language model', 'large language models', 'llm', 'llms'],
  },
  {
    label: 'Retrieval-Augmented Generation',
    variants: ['retrieval-augmented generation', 'retrieval augmented generation', 'rag'],
  },
  {
    label: 'Natural language processing',
    variants: ['natural language processing', 'nlp', 'computational linguistics'],
  },
  {
    label: 'Machine learning',
    variants: ['machine learning', 'deep learning'],
  },
  {
    label: 'Semantic web',
    variants: ['semantic web', 'linked data', 'rdf', 'sparql', 'ontolog'],
  },
  {
    label: 'Spatio-temporal knowledge graphs',
    variants: ['spatio-temporal', 'spatial-temporal', 'temporal knowledge graph'],
  },
  {
    label: 'AI for software engineering',
    variants: ['ai for software engineering', 'ai4se', 'research software engineering'],
  },
  {
    label: 'Information retrieval',
    variants: ['information retrieval', 'recommender system', 'search engine'],
  },
];

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

function corpusHas(text: string, variant: string): boolean {
  return skillPresent(text, variant);
}

function profileCorpus(profile: CandidateProfileRecord): string {
  return [
    profile.skills.join(' '),
    profile.experienceSummary ?? '',
    ...profile.experience.map((role) => `${role.title} ${role.employer} ${role.summary}`),
    ...profile.projects.map((project) => `${project.name} ${project.summary} ${project.technologies.join(' ')}`),
    ...profile.publications,
    ...profile.education.map((entry) => `${entry.degree} ${entry.institution}`),
    ...profile.certifications,
  ].join('\n');
}

function highestDegree(profile: CandidateProfileRecord): number {
  const text = profile.education.map((entry) => entry.degree).join(' ');
  if (/\bph\.?d\b|doctora|doktor/i.test(text)) return 4;
  if (/\bmaster|m\.?sc|m\.?a\.?\b|magister/i.test(text)) return 3;
  if (/\bbachelor|b\.?sc|b\.?a\.?\b/i.test(text)) return 2;
  return profile.education.length > 0 ? 2 : 0;
}

function requiredDegree(position: PhdFitPosition): { level: number; label: string } {
  const text = `${position.requiredQualifications?.join(' ') ?? ''} ${position.description ?? ''}`;
  // "PhD position"/"PhD researcher" describes the vacancy, not a requirement. Only an
  // explicit degree phrase counts as requiring an already-completed doctorate.
  if (
    /\b(?:ph\.?d\.?|doctorate|doctoral)\s+(?:degree|qualification)\b|completed\s+(?:a\s+)?ph\.?d/i.test(
      text,
    )
  ) {
    return { level: 4, label: 'PhD' };
  }
  if (/\bmaster'?s?\b|\bm\.?sc\b|master’s degree/i.test(text)) {
    return { level: 3, label: "Master's degree" };
  }
  if (/\bbachelor'?s?\b|\bb\.?sc\b/i.test(text)) {
    return { level: 2, label: "Bachelor's degree" };
  }
  return { level: 0, label: 'Not stated' };
}

/**
 * Estimated profile match for a PhD opening. The percentage is a transparent weighted
 * estimate from the available advertisement; it is not an admission probability.
 */
export function scorePhdFit(position: PhdFitPosition, profile: CandidateProfileRecord): PhdFitResult {
  const candidateText = profileCorpus(profile);
  const positionText = [
    position.title,
    position.researchTopic ?? '',
    position.description ?? '',
    (position.requiredSkills ?? []).join(' '),
  ].join('\n');

  const positionTopics = RESEARCH_TOPICS.filter((topic) =>
    topic.variants.some((variant) => corpusHas(positionText, variant)),
  );
  const matchedTopics = positionTopics
    .filter((topic) => topic.variants.some((variant) => corpusHas(candidateText, variant)))
    .map((topic) => topic.label);
  const missingTopics = positionTopics
    .filter((topic) => !topic.variants.some((variant) => corpusHas(candidateText, variant)))
    .map((topic) => topic.label);

  const topicScore = positionTopics.length > 0 ? matchedTopics.length / positionTopics.length : 0.5;

  const requiredSkills = unique(position.requiredSkills ?? []);
  const matchedSkills = requiredSkills.filter((skill) => corpusHas(candidateText, skill));
  const missingSkills = requiredSkills.filter((skill) => !corpusHas(candidateText, skill));
  const skillScore = requiredSkills.length > 0 ? matchedSkills.length / requiredSkills.length : 0;

  const publications = profile.publications ?? [];
  const relevantPublications = publications.filter((publication) =>
    positionTopics.some((topic) => topic.variants.some((variant) => corpusHas(publication, variant))),
  );
  const researchEvidence = /\bresearch\b|\bthesis\b|\bpublication\b|\bexperiment\b|\bevaluation\b|\bbenchmark\b|\bpaper\b/i.test(
    candidateText,
  );
  const publicationScore = Math.min(1, publications.length / 2);
  const researchScore =
    publications.length > 0
      ? publicationScore * 0.6 + (relevantPublications.length / publications.length) * 0.4
      : researchEvidence
        ? 0.35
        : 0.12;

  const required = requiredDegree(position);
  const degree = highestDegree(profile);
  const mandatoryMissing: string[] = [];
  let academicScore: number;
  let academicDetail: string;
  if (required.level === 0) {
    academicScore = degree >= 3 ? 1 : degree === 2 ? 0.6 : 0.2;
    academicDetail =
      'The advertisement does not state a degree requirement; score reflects the highest degree evidenced in the profile.';
  } else if (degree >= required.level) {
    academicScore = 1;
    academicDetail = `Profile meets the stated ${required.label} requirement.`;
  } else if (degree > 0) {
    academicScore = 0.35;
    academicDetail = `The advertisement asks for a ${required.label}; the profile does not clearly evidence it.`;
    mandatoryMissing.push(`${required.label} is required but not clearly evidenced in the profile`);
  } else {
    academicScore = 0.15;
    academicDetail = `No completed degree is evidenced in the profile; a ${required.label} is requested.`;
    mandatoryMissing.push(`${required.label} is required but no completed degree is evidenced`);
  }

  const methods = unique([...(position.requiredMethods ?? []), ...requiredSkills]);
  const matchedMethods = methods.filter((method) => corpusHas(candidateText, method));
  const methodScore = methods.length > 0 ? matchedMethods.length / methods.length : 0;

  const categories: PhdCategory[] = [];
  if (positionTopics.length > 0) {
    categories.push({
      key: 'researchTopic',
      label: 'Research-topic alignment',
      weight: PHD_MATCH_WEIGHTS.researchTopic,
      score: topicScore,
      detail: `Matched ${matchedTopics.length} of ${positionTopics.length} advertised research topics${
        missingTopics.length > 0 ? `; not evidenced: ${missingTopics.join(', ')}` : ''
      }.`,
    });
  }
  if (requiredSkills.length > 0) {
    categories.push({
      key: 'technicalSkills',
      label: 'Technical skills',
      weight: PHD_MATCH_WEIGHTS.technicalSkills,
      score: skillScore,
      detail: `Matched ${matchedSkills.length} of ${requiredSkills.length} listed skills${
        missingSkills.length > 0 ? `; not evidenced: ${missingSkills.slice(0, 8).join(', ')}` : ''
      }.`,
    });
  }
  categories.push({
    key: 'researchExperience',
    label: 'Research experience & publications',
    weight: PHD_MATCH_WEIGHTS.researchExperience,
    score: researchScore,
    detail: `${publications.length} publication(s) in the profile; ${relevantPublications.length} topically relevant. ${
      researchEvidence ? 'Research activity is evidenced in the CV/projects.' : 'No explicit research activity was detected.'
    }`,
  });
  categories.push({
    key: 'academicQualifications',
    label: 'Academic qualifications',
    weight: PHD_MATCH_WEIGHTS.academicQualifications,
    score: academicScore,
    detail: academicDetail,
  });
  if (methods.length > 0) {
    categories.push({
      key: 'methods',
      label: 'Required methods & tools',
      weight: PHD_MATCH_WEIGHTS.methods,
      score: methodScore,
      detail: `Matched ${matchedMethods.length} of ${methods.length} listed methods/tools.`,
    });
  }

  const totalWeight = categories.reduce((sum, category) => sum + category.weight, 0);
  const weighted = categories.reduce((sum, category) => sum + category.weight * category.score, 0);
  let score = totalWeight > 0 ? Math.round((weighted / totalWeight) * 100) : 0;

  const concerns: string[] = [];
  if (missingTopics.length > 0) {
    concerns.push(`Advertised topics not evidenced in the profile: ${missingTopics.join(', ')}.`);
  }
  if (missingSkills.length > 0) {
    concerns.push(`Listed skills not evidenced: ${missingSkills.slice(0, 8).join(', ')}.`);
  }
  if (publications.length === 0) {
    concerns.push('No publications are recorded in the profile; this is often expected for a PhD application.');
  }
  if (position.languageDecision && position.languageDecision !== 'Eligible') {
    concerns.push(
      position.languageDecision === 'Excluded'
        ? 'The advertisement mandates German, which conflicts with the English-first language profile.'
        : `The language requirement needs manual review. ${position.languageReason ?? ''}`.trim(),
    );
  }
  if (required.level > 0 && degree < required.level) {
    concerns.push(`The advertised ${required.label} requirement is not clearly met.`);
  }

  const strengths: string[] = [];
  if (matchedTopics.length > 0) strengths.push(`Research-topic overlap: ${matchedTopics.join(', ')}.`);
  if (matchedSkills.length > 0) strengths.push(`Listed-skill overlap: ${matchedSkills.slice(0, 8).join(', ')}.`);
  if (relevantPublications.length > 0) {
    strengths.push(`Topically relevant publication(s): ${relevantPublications.slice(0, 3).join('; ')}.`);
  }
  if (degree >= 3) strengths.push('A master’s-level or higher degree is evidenced in the profile.');

  if (mandatoryMissing.length > 0) score = Math.min(score, 60);
  if (position.languageDecision === 'Excluded') score = Math.min(score, 45);

  const summary = categories
    .map((category) => `${category.label} ${Math.round(category.score * 100)}% (weight ${category.weight})`)
    .join(', ');

  return {
    score: Math.max(0, Math.min(100, score)),
    categories,
    matchedTopics,
    missingTopics,
    matchedSkills,
    missingSkills,
    matchedPublications: relevantPublications.slice(0, 5),
    mandatoryMissing,
    qualifications: required.level > 0 ? [required.label] : [],
    strengths: strengths.slice(0, 6),
    concerns: concerns.slice(0, 8),
    explanation: `Estimated profile match from a transparent weighted model: ${summary}. Weights are normalized over the categories that apply. A mandatory qualification that is missing caps the score. This is not a prediction of admission chances.`,
    reviewRequired:
      mandatoryMissing.length > 0 || (position.languageDecision ?? 'Needs Review') !== 'Eligible',
  };
}
