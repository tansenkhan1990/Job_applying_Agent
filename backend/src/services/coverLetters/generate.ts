import type { JobMatchDoc, JobDoc, ProfileDoc } from '../../types/models.js';
import { DocumentModel } from '../../models/Document.js';
import { CoverLetterModel } from '../../models/CoverLetter.js';
import { PROMPT_VERSIONS } from '../../config/defaults.js';
import { env } from '../../config/env.js';
import { aiConfigured, completeStructured } from '../ai/client.js';
import { coverLetterDocumentPrompt, coverLetterPrompt } from '../ai/prompts.js';
import type { DocumentEvidence } from '../ai/candidateDocuments.js';
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
  hasDescription: boolean;
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
    !input.hasDescription
      ? `The posting did not include a job description, so this draft is based on the role title and my CV.${
          skills.length > 0
            ? ` My documented experience includes ${skills.slice(0, 4).join(', ')}.`
            : ''
        } I would welcome the opportunity to discuss the role and its specific requirements.`
      : skills.length > 0
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
  /** When provided, the generator uses ranked evidence from all three CVs/letters. */
  documentEvidence?: DocumentEvidence;
}): Promise<GeneratedLetter> {
  const { job, profile } = input;
  const settings = await getSettings();
  const model = resolveModel(settings);

  const cvDoc = input.documentEvidence
    ? null
    : profile.cvDocument
      ? await DocumentModel.findById(profile.cvDocument).select('+text')
      : null;
  const coverDoc = input.documentEvidence
    ? null
    : profile.coverLetterDocument
      ? await DocumentModel.findById(profile.coverLetterDocument).select('+text')
      : null;
  const cvText = input.documentEvidence?.selectedCvText ?? cvDoc?.text ?? '';
  const originalLetter = input.documentEvidence?.referenceLetterText ?? coverDoc?.text ?? '';
  const matchedSkills = input.documentEvidence
    ? input.documentEvidence.matchedSkills
    : input.match?.matchedSkills ?? [];
  const descriptionMissing = !(job.description ?? '').trim();
  const descriptionLimitation =
    'The job description is empty or unavailable, so the letter cannot reference its specific requirements.';
  const concerns = [
    ...(input.match?.concerns ?? []),
    ...(input.documentEvidence?.limitations ?? []),
    ...(descriptionMissing ? [descriptionLimitation] : []),
  ];
  const groundingSources = input.documentEvidence
    ? [...input.documentEvidence.groundingTexts, profilePayload(profile)]
    : [cvText, originalLetter, profilePayload(profile)];

  function buildPrompt(extraInstructions?: string) {
    if (input.documentEvidence) {
      return coverLetterDocumentPrompt({
        target: 'job',
        title: job.title,
        organization: job.employer,
        location: job.location,
        description: truncate(job.description ?? '', 7_000),
        context: `${job.employmentType || ''}${job.salary ? ` · ${job.salary}` : ''}`,
        instructions: [input.instructions, extraInstructions].filter(Boolean).join(' ') || undefined,
        evidence: {
          selectedProfile: profilePayload(profile),
          selectedCvText: truncate(input.documentEvidence!.selectedCvText, 6_500),
          referenceLetterText: truncate(input.documentEvidence!.referenceLetterText, 3_000),
          otherCvEvidence: input.documentEvidence!.otherCvEvidence,
          otherLetterEvidence: input.documentEvidence!.otherLetterEvidence,
          matchedSkills,
          concerns,
          limitations: input.documentEvidence!.limitations,
        },
      });
    }
    return coverLetterPrompt({
      candidateProfile: profilePayload(profile),
      cvText: truncate(cvText || 'CV text not available.', 6_000),
      originalCoverLetter: truncate(originalLetter || 'No original cover letter provided.', 2_500),
      jobTitle: job.title,
      employer: job.employer,
      location: job.location,
      description: truncate(job.description ?? '', 5_000),
      matchedSkills,
      concerns,
      instructions: [input.instructions, extraInstructions].filter(Boolean).join(' ') || undefined,
    });
  }

  let letter: AiCoverLetter;
  let source: GeneratedLetter['source'] = 'template';
  let usedModel = 'deterministic-template';
  let promptVersion = 'template-v1';
  let claimsUsed: string[] = [];
  let uncertainties: string[] = [];

  const canUseAi = aiConfigured() && Boolean(model);

  if (canUseAi) {
    try {
      const prompt = buildPrompt();

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
        sources: groundingSources,
      });

      if (!grounding.passed && (grounding.unsupportedTerms.length > 0 || grounding.unsupportedNumbers.length > 0)) {
        const forbidden = [...grounding.unsupportedTerms, ...grounding.unsupportedNumbers];
        const retryPrompt = buildPrompt(
          `Rewrite without mentioning or implying any of: ${forbidden.join(', ')}. Only use facts from the verified material.`,
        );
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
          sources: groundingSources,
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
      if (descriptionMissing) {
        uncertainties = [...uncertainties, descriptionLimitation];
      }
      const finalGrounding = checkGrounding({
        letterText,
        subjectLine: letter.subjectLine,
        sources: groundingSources,
      });

      return {
        subjectLine: letter.subjectLine || `Application for ${job.title}`,
        letterText,
        source,
        model: usedModel,
        promptVersion,
        grounding: finalGrounding,
        claimsUsed,
        uncertainties: uncertainties.filter(
          (entry, index, all) => all.indexOf(entry) === index,
        ),
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

  const template = buildTemplateLetter({
    job,
    profile,
    matchedSkills,
    hasDescription: !descriptionMissing,
  });
  const letterText = sanitizeLetter(template.letterText);
  const grounding = checkGrounding({
    letterText,
    subjectLine: template.subjectLine,
    sources: groundingSources,
  });

  return {
    subjectLine: template.subjectLine,
    letterText,
    source: 'template',
    model: usedModel,
    promptVersion,
    grounding,
    claimsUsed: template.claimsUsed,
    uncertainties: [
      ...(uncertainties.length > 0
        ? uncertainties
        : ['No AI model configured. This is a deterministic template; personalise it before approving.']),
      ...(descriptionMissing ? [descriptionLimitation] : []),
    ].filter((entry, index, all) => all.indexOf(entry) === index),
  };
}

export async function saveCoverLetterVersion(input: {
  job?: JobDoc | null;
  phdPositionId?: string | null;
  letterType?: 'job' | 'phd';
  profile: ProfileDoc;
  applicationId?: string;
  letter: GeneratedLetter;
  version: number;
  referenceLetterDocumentId?: string | null;
  referenceProfileId?: string | null;
  jobContentHash?: string;
  selectionRationale?: string;
  sourceDocuments?: Array<{
    document: string;
    profileKind: string;
    docType: string;
    role: string;
  }>;
}) {
  return CoverLetterModel.create({
    job: input.job?._id ?? null,
    phdPosition: input.phdPositionId ?? null,
    letterType: input.letterType ?? 'job',
    profile: input.profile._id,
    application: input.applicationId ?? null,
    version: input.version,
    subjectLine: input.letter.subjectLine,
    letterText: input.letter.letterText,
    generatedText: input.letter.letterText,
    contentHash: sha256(input.letter.letterText),
    source: input.letter.source,
    model: input.letter.model,
    promptVersion: input.letter.promptVersion,
    grounding: input.letter.grounding,
    coverLetterDocument: input.referenceLetterDocumentId ?? input.profile.coverLetterDocument ?? null,
    referenceLetterDocument: input.referenceLetterDocumentId ?? null,
    referenceProfile: input.referenceProfileId ?? null,
    cvDocument: input.profile.cvDocument ?? null,
    jobContentHash: input.jobContentHash ?? '',
    jobSnapshotAt: new Date(),
    selectionRationale: input.selectionRationale ?? '',
    sourceDocuments: input.sourceDocuments ?? [],
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
