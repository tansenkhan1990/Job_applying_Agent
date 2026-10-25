import type { JobMatchDoc, JobDoc, ProfileDoc } from '../../types/models.js';
import { DocumentModel } from '../../models/Document.js';
import { CoverLetterModel } from '../../models/CoverLetter.js';
import { PROMPT_VERSIONS } from '../../config/defaults.js';
import { env } from '../../config/env.js';
import { aiConfigured, completeStructured } from '../ai/client.js';
import { coverLetterPrompt } from '../ai/prompts.js';
import { coverLetterSchema, type AiCoverLetter } from '../ai/schemas.js';
import { getSettings, resolveModel } from '../settingsService.js';
import { logger } from '../../utils/logger.js';
import { normalizeWhitespace, truncate, wordCount } from '../../utils/text.js';
import { sha256 } from '../../utils/hash.js';
import { checkGrounding, type GroundingResult } from './grounding.js';

export interface GeneratedLetter {
  subjectLine: string;
  letterText: string;
  source: 'generated' | 'template';
  model: string;
  promptVersion: string;
  grounding: GroundingResult;
  claimsUsed: string[];
  uncertainties: string[];
}

function profilePayload(profile: ProfileDoc): string {
  return truncate(
    JSON.stringify(
      {
        name: profile.name || 'unknown',
        targetTitles: profile.targetTitles,
        skills: profile.skills,
        experienceSummary: profile.experienceSummary,
        yearsExperience: profile.yearsExperience,
        location: profile.location,
        languages: profile.languages,
        experience: profile.experience,
        education: profile.education,
        certifications: profile.certifications,
        projects: profile.projects,
        publications: profile.publications,
      },
      null,
      2,
    ),
    3_000,
  );
}

function replacePlaceholders(letter: string, input: { employer: string; title: string; name: string }): string {
  return letter
    .replace(/\[(company|employer)\]/gi, input.employer)
    .replace(/\[(role|position|job title)\]/gi, input.title)
    .replace(/\[(your name|name)\]/gi, input.name)
    .replace(/\[(date)\]/gi, new Date().toISOString().slice(0, 10))
    .replace(/\[(hiring manager)\]/gi, 'Hiring Manager');
}

function sanitizeLetter(raw: string): string {
  return normalizeWhitespace(
    raw
      .replace(/^```[a-z]*\s*/i, '')
      .replace(/```\s*$/i, '')
      .replace(/^"+|"+$/g, '')
      .replace(/\r\n?/g, '\n'),
  );
}

function buildTemplateLetter(input: {
  job: JobDoc;
  profile: ProfileDoc;
  matchedSkills: string[];
}): AiCoverLetter {
  const { job, profile } = input;
  const skills = (input.matchedSkills.length > 0 ? input.matchedSkills : profile.skills).slice(0, 6);
  const greeting = 'Dear Hiring Manager,';
  const experience = profile.experienceSummary
    ? profile.experienceSummary.replace(/\s+/g, ' ').trim()
    : `My background covers ${skills.join(', ')}.`;

  const paragraphs = [
    greeting,
    `I am writing to apply for the ${job.title} position at ${job.employer}. ${experience}`,
    skills.length > 0
      ? `The role's focus on ${skills.slice(0, 4).join(', ')} aligns with the work described in my CV. I have applied these technologies in professional projects and can speak to the concrete outcomes listed there.`
      : `My CV describes the technologies and responsibilities I can bring to this role.`,
    `I would welcome the opportunity to discuss how my experience fits your team's needs. Thank you for considering my application.`,
    profile.name ? `Sincerely,\n${profile.name}` : 'Sincerely,',
  ];

  return {
    subjectLine: `Application for ${job.title}`,
    letterText: paragraphs.join('\n\n'),
    claimsUsed: skills.map((skill) => `Skill evidenced in CV: ${skill}`),
    uncertainties: [
      'This letter was produced by the deterministic template because no OpenRouter model was available. Review and personalise it before approving.',
    ],
  };
}

export async function generateCoverLetter(input: {
  job: JobDoc;
  profile: ProfileDoc;
  match?: JobMatchDoc | null;
  instructions?: string;
}): Promise<GeneratedLetter> {
  const { job, profile } = input;
  const settings = await getSettings();
  const model = resolveModel(settings);

  const cvDoc = profile.cvDocument
    ? await DocumentModel.findById(profile.cvDocument).select('+text')
    : null;
  const coverDoc = profile.coverLetterDocument
    ? await DocumentModel.findById(profile.coverLetterDocument).select('+text')
    : null;
  const cvText = cvDoc?.text ?? '';
  const originalLetter = coverDoc?.text ?? '';
  const matchedSkills = input.match?.matchedSkills ?? [];
  const concerns = input.match?.concerns ?? [];

  let letter: AiCoverLetter;
  let source: GeneratedLetter['source'] = 'template';
  let usedModel = 'deterministic-template';
  let promptVersion = 'template-v1';
  let claimsUsed: string[] = [];
  let uncertainties: string[] = [];

  const canUseAi = aiConfigured() && Boolean(model);

  if (canUseAi) {
    try {
      const prompt = coverLetterPrompt({
        candidateProfile: profilePayload(profile),
        cvText: truncate(cvText || 'CV text not available.', 6_000),
        originalCoverLetter: truncate(originalLetter || 'No original cover letter provided.', 2_500),
        jobTitle: job.title,
        employer: job.employer,
        location: job.location,
        description: truncate(job.description ?? '', 5_000),
        matchedSkills,
        concerns,
        instructions: input.instructions,
      });

      let result = await completeStructured({
        model,
        task: 'tailored cover letter',
        system: prompt.system,
        user: prompt.user,
        schema: coverLetterSchema,
        temperature: 0.4,
        maxTokens: Math.min(2_500, settings.ai.maxOutputTokens),
      });

      let grounding = checkGrounding({
        letterText: result.data.letterText,
        subjectLine: result.data.subjectLine,
        sources: [cvText, originalLetter, profilePayload(profile)],
      });

      if (!grounding.passed && (grounding.unsupportedTerms.length > 0 || grounding.unsupportedNumbers.length > 0)) {
        const forbidden = [...grounding.unsupportedTerms, ...grounding.unsupportedNumbers];
        const retryPrompt = coverLetterPrompt({
          candidateProfile: profilePayload(profile),
          cvText: truncate(cvText || 'CV text not available.', 6_000),
          originalCoverLetter: truncate(originalLetter || 'No original cover letter provided.', 2_500),
          jobTitle: job.title,
          employer: job.employer,
          location: job.location,
          description: truncate(job.description ?? '', 5_000),
          matchedSkills,
          concerns,
          instructions: `${input.instructions ?? ''} Rewrite without mentioning or implying any of: ${forbidden.join(', ')}. Only use facts from the verified material.`,
        });
        result = await completeStructured({
          model,
          task: 'tailored cover letter (grounding retry)',
          system: retryPrompt.system,
          user: retryPrompt.user,
          schema: coverLetterSchema,
          temperature: 0.3,
          maxTokens: Math.min(2_500, settings.ai.maxOutputTokens),
        });
        grounding = checkGrounding({
          letterText: result.data.letterText,
          subjectLine: result.data.subjectLine,
          sources: [cvText, originalLetter, profilePayload(profile)],
        });
      }

      letter = result.data;
      source = 'generated';
      usedModel = result.model;
      promptVersion = PROMPT_VERSIONS.coverLetter;
      claimsUsed = result.data.claimsUsed;
      uncertainties = result.data.uncertainties;

      const letterText = replacePlaceholders(sanitizeLetter(letter.letterText), {
        employer: job.employer,
        title: job.title,
        name: profile.name,
      });
      const finalGrounding = checkGrounding({
        letterText,
        subjectLine: letter.subjectLine,
        sources: [cvText, originalLetter, profilePayload(profile)],
      });

      return {
        subjectLine: letter.subjectLine || `Application for ${job.title}`,
        letterText,
        source,
        model: usedModel,
        promptVersion,
        grounding: finalGrounding,
        claimsUsed,
        uncertainties,
      };
    } catch (error) {
      logger.warn(
        { jobId: String(job._id), error: error instanceof Error ? error.message : 'unknown' },
        'AI cover letter generation failed; falling back to template',
      );
      uncertainties = [
        'AI generation failed. This fallback letter is a template and must be reviewed carefully.',
      ];
    }
  }

  const template = buildTemplateLetter({ job, profile, matchedSkills });
  const letterText = sanitizeLetter(template.letterText);
  const grounding = checkGrounding({
    letterText,
    subjectLine: template.subjectLine,
    sources: [cvText, originalLetter, profilePayload(profile)],
  });

  return {
    subjectLine: template.subjectLine,
    letterText,
    source: 'template',
    model: usedModel,
    promptVersion,
    grounding,
    claimsUsed: template.claimsUsed,
    uncertainties:
      uncertainties.length > 0
        ? uncertainties
        : ['No AI model configured. This is a deterministic template; personalise it before approving.'],
  };
}

export async function saveCoverLetterVersion(input: {
  job: JobDoc;
  profile: ProfileDoc;
  applicationId?: string;
  letter: GeneratedLetter;
  version: number;
}) {
  return CoverLetterModel.create({
    job: input.job._id,
    profile: input.profile._id,
    application: input.applicationId ?? null,
    version: input.version,
    subjectLine: input.letter.subjectLine,
    letterText: input.letter.letterText,
    contentHash: sha256(input.letter.letterText),
    source: input.letter.source,
    model: input.letter.model,
    promptVersion: input.letter.promptVersion,
    grounding: input.letter.grounding,
    coverLetterDocument: input.profile.coverLetterDocument ?? null,
    cvDocument: input.profile.cvDocument ?? null,
    claimsUsed: input.letter.claimsUsed,
    uncertainties: input.letter.uncertainties,
    wordCount: wordCount(input.letter.letterText),
  });
}

export function letterMeta(letter: GeneratedLetter) {
  return {
    ...letter,
    contentHash: sha256(letter.letterText),
    wordCount: wordCount(letter.letterText),
    aiConfigured: env.aiConfigured,
  };
}
