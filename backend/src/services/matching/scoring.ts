import { normalizeForMatch } from '../../utils/text.js';
import { titleRelevance } from '../jobs/filters.js';

/** Documented weights for the transparent job-fit model. */
export const MATCH_WEIGHTS = {
  requiredSkills: 35,
  experience: 25,
  responsibilities: 15,
  preferredSkills: 10,
  seniority: 10,
  education: 5,
} as const;

export type MatchCategoryKey = keyof typeof MATCH_WEIGHTS;

export interface MatchCategory {
  key: MatchCategoryKey;
  label: string;
  weight: number;
  applicable: boolean;
  score: number;
  detail: string;
}

export interface JobFitScore {
  score: number;
  categories: MatchCategory[];
  breakdown: Record<MatchCategoryKey, number>;
  matchedRequired: string[];
  missingRequired: string[];
  matchedPreferred: string[];
  missingPreferred: string[];
  requiredSkills: string[];
  preferredSkills: string[];
  matchedSkills: string[];
  missingSkills: string[];
  strengths: string[];
  concerns: string[];
  explanation: string;
  yearsRequired: number | null;
}

export interface FitJob {
  title: string;
  description?: string | null;
  tags?: string[] | null;
  seniority?: string | null;
  location?: string | null;
  country?: string | null;
  workArrangement?: string | null;
  languageRequirement?: string | null;
}

export interface FitProfile {
  skills?: string[] | null;
  targetTitles?: string[] | null;
  experienceSummary?: string | null;
  yearsExperience?: number | null;
  experience?: Array<{ title?: string; employer?: string; summary?: string }> | null;
  education?: Array<{ degree?: string; institution?: string }> | null;
}

const COMMON_SKILLS = [
  'JavaScript',
  'TypeScript',
  'React',
  'Next.js',
  'Angular',
  'Vue',
  'Node.js',
  'Express',
  'NestJS',
  'Python',
  'Django',
  'Flask',
  'FastAPI',
  'Java',
  'Spring Boot',
  'Go',
  'Rust',
  'C#',
  '.NET',
  'PHP',
  'Laravel',
  'Ruby',
  'Ruby on Rails',
  'HTML',
  'CSS',
  'Tailwind CSS',
  'GraphQL',
  'REST APIs',
  'gRPC',
  'PostgreSQL',
  'MySQL',
  'MongoDB',
  'Redis',
  'Elasticsearch',
  'DynamoDB',
  'SQL',
  'Prisma',
  'Docker',
  'Kubernetes',
  'Terraform',
  'Ansible',
  'AWS',
  'Azure',
  'Google Cloud Platform',
  'CI/CD',
  'Jenkins',
  'GitHub Actions',
  'GitLab CI',
  'Linux',
  'Nginx',
  'Prometheus',
  'Grafana',
  'Observability',
  'Microservices',
  'Kafka',
  'RabbitMQ',
  'Spark',
  'Airflow',
  'dbt',
  'Machine Learning',
  'Deep Learning',
  'PyTorch',
  'TensorFlow',
  'scikit-learn',
  'Pandas',
  'NumPy',
  'NLP',
  'LLM',
  'RAG',
  'LangChain',
  'LangGraph',
  'Vector databases',
  'Prompt engineering',
  'AI agents',
  'MLOps',
  'Cybersecurity',
  'SIEM',
  'SOAR',
  'Penetration testing',
  'Threat modeling',
  'OWASP',
  'IAM',
  'Zero Trust',
  'Git',
  'Agile',
  'Scrum',
  'TDD',
  'Playwright',
  'Cypress',
  'Jest',
];

const SKILL_ALIASES: Record<string, string[]> = {
  'node.js': ['node.js', 'nodejs', 'node js', 'node'],
  'retrieval augmented generation': [
    'retrieval-augmented generation',
    'retrieval augmented generation',
    'rag',
  ],
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
  'infrastructure automation': [
    'infrastructure automation',
    'infrastructure as code',
    'iac',
    'terraform',
  ],
  monitoring: ['monitoring', 'observability', 'prometheus', 'grafana'],
  'deployment workflows': ['deployment workflows', 'deployment', 'deployments'],
  'ai agents': ['ai agents', 'agentic', 'agents', 'langgraph'],
  llm: ['llm', 'large language model', 'large language models'],
  'vector databases': ['vector database', 'vector databases', 'pinecone', 'weaviate', 'qdrant'],
  'spring boot': ['spring boot', 'spring'],
  '.net': ['.net', 'dotnet', 'asp.net'],
  'tailwind css': ['tailwind css', 'tailwind'],
  'github actions': ['github actions'],
  'gitlab ci': ['gitlab ci', 'gitlab'],
  'penetration testing': ['penetration testing', 'pen testing', 'pentest', 'ethical hacking'],
  'threat modeling': ['threat modeling', 'threat modelling'],
  iam: ['iam', 'identity and access management'],
  'zero trust': ['zero trust'],
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
      return new RegExp(
        `(^|[^a-z0-9])${variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`,
      ).test(normalizedText);
    }
    return normalizedText.includes(variant);
  });
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

function uniqueSkills(skills: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const skill of skills) {
    const key = normalizeForMatch(skill);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(skill);
  }
  return output;
}

const REQUIRED_HEADING =
  /^(requirements?|qualifications?|must[- ]have|what you bring|your profile|skills?|experience|about you|we expect|what we expect|your background)\b/i;
const PREFERRED_HEADING =
  /^(nice[- ]to[- ]have|preferred|bonus|advantages?|plus|desirable|beneficial)\b/i;
const PREFERRED_CONTEXT =
  /\b(preferred|nice to have|bonus|a plus|advantage|advantageous|desirable|beneficial|optional)\b/i;
const REQUIRED_CONTEXT =
  /\b(required|requirement|must|essential|mandatory|proficien|strong|solid|experience (?:with|in)|knowledge of|familiarity with)\b/i;

interface SkillRequirement {
  required: Set<string>;
  preferred: Set<string>;
  mentioned: Set<string>;
}

function labelFor(skill: string): string {
  return skill;
}

/**
 * Heuristic extraction of required/preferred skills from the posting text. It is deliberately
 * conservative: skills mentioned only in responsibilities stay "mentioned" and do not inflate
 * the required-skills category.
 */
export function extractSkillRequirements(
  job: FitJob,
  profileSkills: string[],
): SkillRequirement {
  const pool = uniqueSkills([...profileSkills, ...COMMON_SKILLS]);
  const description = job.description ?? '';
  const lines = description.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const required = new Set<string>();
  const preferred = new Set<string>();
  const mentioned = new Set<string>();
  let section: 'required' | 'preferred' | 'other' = 'other';

  for (const line of lines) {
    if (PREFERRED_HEADING.test(line)) section = 'preferred';
    else if (REQUIRED_HEADING.test(line)) section = 'required';

    const preferredLine = PREFERRED_CONTEXT.test(line);
    const requiredLine = REQUIRED_CONTEXT.test(line);

    for (const skill of pool) {
      if (!skillPresent(line, skill)) continue;
      const name = labelFor(skill);
      if (preferredLine || section === 'preferred') {
        if (!required.has(name)) preferred.add(name);
      } else if (requiredLine || section === 'required') {
        required.add(name);
        preferred.delete(name);
      } else {
        mentioned.add(name);
      }
    }
  }

  // Source tags are an explicit skill signal even when the prose has no heading.
  for (const tag of job.tags ?? []) {
    for (const skill of pool) {
      if (skillPresent(tag, skill)) {
        if (!preferred.has(skill)) required.add(skill);
      }
    }
  }

  // A posting may only list a stack with no requirement section. Mentioned skills are then
  // the best available evidence, but they are still reported separately.
  if (required.size === 0 && mentioned.size > 0) {
    for (const skill of mentioned) required.add(skill);
  }

  return { required, preferred, mentioned };
}

function percentage(matched: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(1, matched / total)) : 0;
}

function profileHasSkill(profileSkills: string[], skill: string): boolean {
  return profileSkills.some((candidate) => skillPresent(skill, candidate));
}

const RELEVANCE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'your', 'our', 'are', 'will', 'that', 'this', 'from',
  'have', 'has', 'not', 'but', 'all', 'can', 'who', 'what', 'when', 'where', 'how', 'their',
  'they', 'them', 'its', 'into', 'over', 'more', 'also', 'work', 'working', 'role', 'team',
  'teams', 'job', 'position', 'company', 'experience', 'years', 'year', 'skills', 'required',
  'requirements', 'preferred', 'nice', 'have', 'plus', 'using', 'use', 'build', 'building',
  'develop', 'development', 'strong', 'good', 'knowledge', 'understanding', 'ability',
]);

function keywordSet(text: string): Set<string> {
  return new Set(
    normalizeForMatch(text)
      .split(/[^a-z0-9+#.]+/)
      .filter((token) => token.length > 2 && !RELEVANCE_STOPWORDS.has(token)),
  );
}

function overlapScore(source: string, target: Set<string>, targetSize = 12): number {
  const tokens = keywordSet(source);
  if (tokens.size === 0 || target.size === 0) return 0;
  let matches = 0;
  for (const token of tokens) {
    if (target.has(token)) matches += 1;
  }
  return Math.min(1, matches / Math.max(6, Math.min(targetSize, target.size)));
}

function seniorityScore(
  jobSeniority: string | undefined,
  years: number | null | undefined,
): { applicable: boolean; score: number; detail: string } {
  const level = (jobSeniority ?? 'unknown').toLowerCase();
  if (!level || level === 'unknown') {
    return { applicable: false, score: 0, detail: 'Seniority is not stated in the posting.' };
  }
  if (years === null || years === undefined) {
    return {
      applicable: true,
      score: 0.5,
      detail: `Posting level: ${level}; total experience is not verified in the profile.`,
    };
  }
  const minimum: Record<string, number> = { junior: 0, mid: 2, senior: 5, lead: 8 };
  const requiredYears = minimum[level] ?? 3;
  const fit = requiredYears === 0 ? 1 : Math.min(1, years / requiredYears);
  return {
    applicable: true,
    score: Math.max(0.2, fit),
    detail: `Posting level: ${level}; profile states ${years} years (${requiredYears}+ expected).`,
  };
}

function educationLevel(education: FitProfile['education']): number {
  const text = (education ?? [])
    .map((entry) => `${entry.degree ?? ''} ${entry.institution ?? ''}`)
    .join(' ');
  if (/\bph\.?d\b|doctora/i.test(text)) return 4;
  if (/\bmaster|m\.?sc|m\.?a\.?\b/i.test(text)) return 3;
  if (/\bbachelor|b\.?sc|b\.?a\.?\b/i.test(text)) return 2;
  return education && education.length > 0 ? 2 : 0;
}

function requiredEducationLevel(description: string): number {
  if (/\bph\.?d\b|doctoral|doctorate/i.test(description)) return 4;
  if (/\bmaster'?s?\b|m\.?sc\b/i.test(description)) return 3;
  if (/\bbachelor'?s?\b|b\.?sc\b|university degree|degree in/i.test(description)) return 2;
  return 0;
}

export function scoreJobFit(job: FitJob, profile: FitProfile): JobFitScore {
  const profileSkills = uniqueSkills(profile.skills ?? []);
  const jobText = `${job.title}\n${job.location ?? ''}\n${job.description ?? ''}`;
  const skillRequirements = extractSkillRequirements(job, profileSkills);
  const requiredSkills = [...skillRequirements.required];
  const preferredSkills = [...skillRequirements.preferred].filter(
    (skill) => !skillRequirements.required.has(skill),
  );

  const matchedRequired = requiredSkills.filter((skill) => profileHasSkill(profileSkills, skill));
  const missingRequired = requiredSkills.filter((skill) => !profileHasSkill(profileSkills, skill));
  const matchedPreferred = preferredSkills.filter((skill) => profileHasSkill(profileSkills, skill));
  const missingPreferred = preferredSkills.filter(
    (skill) => !profileHasSkill(profileSkills, skill),
  );

  const categories: MatchCategory[] = [];
  const yearsRequired = extractYearsRequirement(jobText);
  const profileExperienceText = [
    profile.experienceSummary ?? '',
    ...(profile.experience ?? []).map((role) => `${role.title ?? ''} ${role.employer ?? ''} ${role.summary ?? ''}`),
    profileSkills.join(' '),
  ].join(' ');

  if (requiredSkills.length > 0) {
    categories.push({
      key: 'requiredSkills',
      label: 'Required skills',
      weight: MATCH_WEIGHTS.requiredSkills,
      applicable: true,
      score: percentage(matchedRequired.length, requiredSkills.length),
      detail: `Matched ${matchedRequired.length} of ${requiredSkills.length} required skills${
        missingRequired.length > 0 ? `; missing: ${missingRequired.slice(0, 6).join(', ')}` : ''
      }.`,
    });
  }

  const jobKeywords = keywordSet(jobText);
  const experienceRelevance = overlapScore(profileExperienceText, jobKeywords, 18);
  const years = profile.yearsExperience ?? null;
  const yearsFit =
    yearsRequired !== null
      ? years === null
        ? 0.5
        : Math.min(1, years / yearsRequired)
      : years !== null
        ? Math.min(1, 0.6 + years / 25)
        : 0.5;
  if (profileExperienceText.trim().length > 0) {
    categories.push({
      key: 'experience',
      label: 'Relevant experience',
      weight: MATCH_WEIGHTS.experience,
      applicable: true,
      score: Math.max(0, Math.min(1, yearsFit * 0.6 + experienceRelevance * 0.4)),
      detail:
        yearsRequired !== null
          ? `Posting asks for ${yearsRequired}+ years; profile states ${
              years === null ? 'unknown' : `${years} years`
            }. Relevant keyword overlap: ${Math.round(experienceRelevance * 100)}%.`
          : `No explicit years requirement. Relevant experience overlap: ${Math.round(
              experienceRelevance * 100,
            )}%.`,
    });
  }

  const titleFit = titleRelevance(job.title, profile.targetTitles ?? []);
  const roleOverlap = overlapScore(
    `${job.title} ${job.description ?? ''}`,
    keywordSet(`${(profile.targetTitles ?? []).join(' ')} ${profileExperienceText}`),
    14,
  );
  categories.push({
    key: 'responsibilities',
    label: 'Responsibilities & role alignment',
    weight: MATCH_WEIGHTS.responsibilities,
    applicable: true,
    score: Math.max(0, Math.min(1, titleFit * 0.6 + roleOverlap * 0.4)),
    detail: `Title relevance ${Math.round(titleFit * 100)}%; responsibility overlap ${Math.round(
      roleOverlap * 100,
    )}%.`,
  });

  if (preferredSkills.length > 0) {
    categories.push({
      key: 'preferredSkills',
      label: 'Preferred skills',
      weight: MATCH_WEIGHTS.preferredSkills,
      applicable: true,
      score: percentage(matchedPreferred.length, preferredSkills.length),
      detail: `Matched ${matchedPreferred.length} of ${preferredSkills.length} preferred skills.`,
    });
  }

  const seniority = seniorityScore(job.seniority ?? undefined, years);
  if (seniority.applicable) {
    categories.push({
      key: 'seniority',
      label: 'Seniority',
      weight: MATCH_WEIGHTS.seniority,
      applicable: true,
      score: seniority.score,
      detail: seniority.detail,
    });
  }

  const educationRequired = requiredEducationLevel(jobText);
  if (educationRequired > 0) {
    const have = educationLevel(profile.education);
    categories.push({
      key: 'education',
      label: 'Education',
      weight: MATCH_WEIGHTS.education,
      applicable: true,
      score: have >= educationRequired ? 1 : have > 0 ? 0.25 : 0.15,
      detail:
        have >= educationRequired
          ? 'The profile meets the stated education requirement.'
          : 'The stated education requirement is not clearly evidenced in the profile.',
    });
  }

  const totalWeight = categories.reduce((sum, category) => sum + category.weight, 0);
  const weighted = categories.reduce(
    (sum, category) => sum + category.weight * category.score,
    0,
  );
  const score = totalWeight > 0 ? Math.round((weighted / totalWeight) * 100) : 0;

  const breakdown = Object.fromEntries(
    categories.map((category) => [category.key, Math.round(category.score * category.weight)]),
  ) as Record<MatchCategoryKey, number>;

  const matchedSkills = uniqueSkills([...matchedRequired, ...matchedPreferred]);
  const missingSkills = uniqueSkills([...missingRequired, ...missingPreferred]);

  const strengths: string[] = [];
  if (matchedRequired.length > 0) {
    strengths.push(`Required-skill overlap: ${matchedRequired.slice(0, 8).join(', ')}.`);
  }
  if (matchedPreferred.length > 0) {
    strengths.push(`Preferred-skill overlap: ${matchedPreferred.slice(0, 6).join(', ')}.`);
  }
  if (titleFit >= 0.7) strengths.push('The job title closely matches the target titles.');
  if (experienceRelevance >= 0.35) {
    strengths.push('The CV experience description overlaps with the advertised responsibilities.');
  }

  const concerns: string[] = [];
  if (missingRequired.length > 0) {
    concerns.push(`Required skills not evidenced in the profile: ${missingRequired.slice(0, 8).join(', ')}.`);
  }
  if (missingPreferred.length > 0) {
    concerns.push(`Preferred skills not evidenced: ${missingPreferred.slice(0, 6).join(', ')}.`);
  }
  if (yearsRequired !== null && years !== null && years < yearsRequired) {
    concerns.push(`Posting asks for ${yearsRequired}+ years; profile states ${years}.`);
  }
  if (educationRequired > 0) {
    const have = educationLevel(profile.education);
    if (have < educationRequired) {
      concerns.push('The stated education requirement is not clearly evidenced.');
    }
  }
  if (job.seniority && job.seniority !== 'unknown') {
    const seniorityCategory = categories.find((category) => category.key === 'seniority');
    if (seniorityCategory && seniorityCategory.score < 0.6) {
      concerns.push(`Seniority fit is weak for a ${job.seniority}-level role.`);
    }
  }

  const categorySummary = categories
    .map(
      (category) =>
        `${category.label} ${Math.round(category.score * 100)}% (weight ${category.weight})`,
    )
    .join(', ');

  return {
    score,
    categories,
    breakdown,
    matchedRequired,
    missingRequired,
    matchedPreferred,
    missingPreferred,
    requiredSkills,
    preferredSkills,
    matchedSkills,
    missingSkills,
    strengths: strengths.slice(0, 6),
    concerns: concerns.slice(0, 8),
    explanation: `Transparent weighted estimate: ${categorySummary}. Weights are normalized over applicable categories; this is an estimate from the available description, not a shortlist probability.`,
    yearsRequired,
  };
}
