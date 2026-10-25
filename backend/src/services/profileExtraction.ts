import { CandidateProfileModel } from '../models/CandidateProfile.js';
import { DocumentModel } from '../models/Document.js';
import { PROMPT_VERSIONS } from '../config/defaults.js';
import { env } from '../config/env.js';
import { aiConfigured, completeStructured } from './ai/client.js';
import { profileExtractionPrompt } from './ai/prompts.js';
import { profileExtractionSchema, type AiProfileExtraction } from './ai/schemas.js';
import { getSettings, resolveModel } from './settingsService.js';
import { notFound, AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { truncate, uniqueStrings } from '../utils/text.js';

export interface ExtractionResult {
  profile: Awaited<ReturnType<typeof CandidateProfileModel.findById>>;
  source: 'ai' | 'heuristic';
  model: string;
  warnings: string[];
}

function heuristicExtraction(cvText: string, fallbackSkills: string[]): AiProfileExtraction {
  const lines = cvText.split('\n').map((line) => line.trim()).filter(Boolean);
  const nameLine = lines.find(
    (line) => line.length >= 3 && line.length <= 60 && !/\d|@|http|curriculum|resume|lebenslauf/i.test(line),
  );

  const yearsMatch = /(\d{1,2})\s*\+?\s*years? of (professional |relevant )?experience/i.exec(cvText);
  const years = yearsMatch ? Number.parseInt(yearsMatch[1], 10) : null;

  const skillPool = [
    ...fallbackSkills,
    'TypeScript',
    'JavaScript',
    'React',
    'Node.js',
    'Python',
    'FastAPI',
    'AWS',
    'Docker',
    'Kubernetes',
    'Terraform',
    'PostgreSQL',
    'MongoDB',
    'GraphQL',
    'LangGraph',
    'RAG',
    'LLM',
    'CI/CD',
    'Linux',
  ];
  const skills = skillPool.filter((skill) => new RegExp(`(^|[^a-z])${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i').test(cvText));

  const languages: Array<{ language: string; level: string }> = [];
  if (/\benglish\b|\benglisch\b/i.test(cvText)) {
    const level = /\b(c1|c2|native|fluent|fließend|fliessend)\b[^.\n]{0,40}\benglish\b|\benglish\b[^.\n]{0,40}\b(c1|c2|native|fluent|fließend|fliessend)\b/i.exec(
      cvText,
    );
    languages.push({ language: 'English', level: level?.[1] ?? level?.[2] ?? 'unknown' });
  }
  if (/\bgerman\b|\bdeutsch\b/i.test(cvText)) {
    const level = /\b(a1|a2|b1|b2|c1|c2|native|fluent|fließend|fliessend)\b[^.\n]{0,40}\b(german|deutsch)\b|\b(german|deutsch)\b[^.\n]{0,40}\b(a1|a2|b1|b2|c1|c2|native|fluent|fließend|fliessend)\b/i.exec(
      cvText,
    );
    languages.push({ language: 'German', level: level?.[1] ?? level?.[3] ?? 'unknown' });
  }

  const summaryParts = [`Profile extracted from the CV with rule-based matching.`];
  if (skills.length > 0) summaryParts.push(`Evidenced technologies: ${skills.slice(0, 10).join(', ')}.`);
  if (years !== null) summaryParts.push(`The CV states ${years}+ years of experience.`);

  return {
    name: nameLine ?? '',
    skills,
    experienceSummary: summaryParts.join(' '),
    yearsExperience: years,
    location: '',
    languages,
    experience: [],
    education: [],
    certifications: [],
    projects: [],
    publications: [],
  };
}

export async function extractProfileFromCv(profileId: string): Promise<ExtractionResult> {
  const profile = await CandidateProfileModel.findById(profileId);
  if (!profile) throw notFound('Candidate profile');

  if (!profile.cvDocument) {
    throw new AppError(
      400,
      'BAD_REQUEST',
      'No CV is mapped to this profile. Map a CV on the Documents page first.',
    );
  }

  const cv = await DocumentModel.findById(profile.cvDocument).select('+text');
  if (!cv) throw notFound('Mapped CV document');
  if (cv.status === 'needs_ocr') {
    throw new AppError(
      422,
      'BAD_REQUEST',
      'The mapped CV has no extractable text (scanned PDF). Run OCR on the file, save it as a text PDF/DOCX, and rescan.',
    );
  }
  if (!cv.text || cv.text.trim().length < 50) {
    throw new AppError(422, 'BAD_REQUEST', 'The mapped CV has too little extractable text to analyse.');
  }

  const settings = await getSettings();
  const model = resolveModel(settings);
  const warnings: string[] = [];
  let extracted: AiProfileExtraction;
  let source: 'ai' | 'heuristic' = 'heuristic';
  let usedModel = 'heuristic-v1';

  if (aiConfigured() && model) {
    try {
      const prompt = profileExtractionPrompt(
        truncate(cv.text, Math.max(4_000, env.AI_MAX_INPUT_CHARS - 6_000)),
        profile.targetTitles,
      );
      const result = await completeStructured({
        model,
        task: 'candidate profile extraction',
        system: prompt.system,
        user: prompt.user,
        schema: profileExtractionSchema,
        temperature: 0.1,
        maxTokens: 2_000,
      });
      extracted = result.data;
      source = 'ai';
      usedModel = result.model;
    } catch (error) {
      warnings.push(
        `AI extraction failed (${error instanceof Error ? error.message : 'unknown'}); a rule-based fallback was used.`,
      );
      extracted = heuristicExtraction(cv.text, profile.skills ?? []);
    }
  } else {
    warnings.push(
      'OpenRouter is not configured, so a conservative rule-based extraction was used. Review every field.',
    );
    extracted = heuristicExtraction(cv.text, profile.skills ?? []);
  }

  profile.name = extracted.name || profile.name;
  // Replace the seeded target skills with skills evidenced by this CV. Seeded skills are
  // search hints, not verified candidate facts; keeping them would inflate match scores.
  if (extracted.skills.length > 0) {
    profile.skills = uniqueStrings(extracted.skills).slice(0, 100);
  }
  profile.experienceSummary = extracted.experienceSummary || profile.experienceSummary;
  profile.yearsExperience = extracted.yearsExperience ?? profile.yearsExperience;
  profile.location = extracted.location || profile.location;
  if (extracted.languages.length > 0) profile.set('languages', extracted.languages);
  if (extracted.experience.length > 0) profile.set('experience', extracted.experience);
  if (extracted.education.length > 0) profile.set('education', extracted.education);
  profile.certifications = uniqueStrings([...profile.certifications, ...extracted.certifications]);
  if (extracted.projects.length > 0) profile.set('projects', extracted.projects);
  profile.publications = uniqueStrings([...profile.publications, ...extracted.publications]);
  profile.extractionSource = source;
  profile.extractionModel = usedModel;
  profile.extractedAt = new Date();
  profile.status = 'draft';
  await profile.save();

  logger.info(
    { profileId, source, model: usedModel, skills: profile.skills.length },
    'Candidate profile extracted',
  );

  return { profile, source, model: usedModel, warnings };
}

export function promptVersionForExtraction(): string {
  return PROMPT_VERSIONS.profileExtraction;
}
