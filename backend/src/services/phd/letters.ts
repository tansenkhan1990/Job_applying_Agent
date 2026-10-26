import { Types } from 'mongoose';
import type { PhdPositionRecord } from '../../models/PhdPosition.js';
import type { ProfileDoc } from '../../types/models.js';
import { PhdPositionModel } from '../../models/PhdPosition.js';
import { PhdMatchModel } from '../../models/PhdMatch.js';
import { CoverLetterModel } from '../../models/CoverLetter.js';
import { CandidateProfileModel } from '../../models/CandidateProfile.js';
import { PROMPT_VERSIONS } from '../../config/defaults.js';
import { aiConfigured, completeStructured } from '../ai/client.js';
import { coverLetterDocumentPrompt } from '../ai/prompts.js';
import { coverLetterSchema, type AiCoverLetter } from '../ai/schemas.js';
import { getSettings, resolveModel } from '../settingsService.js';
import { saveCoverLetterVersion, type GeneratedLetter } from '../coverLetters/generate.js';
import { checkGrounding } from '../coverLetters/grounding.js';
import {
  buildDocumentEvidence,
  loadCandidateDocumentSets,
  selectCandidateDocuments,
  targetContentHash,
} from '../ai/candidateDocuments.js';
import { logger } from '../../utils/logger.js';
import { normalizeWhitespace, truncate, wordCount } from '../../utils/text.js';
import { sha256 } from '../../utils/hash.js';
import { badRequest, notFound } from '../../utils/errors.js';

function profilePayload(profile: ProfileDoc): string {
  return truncate(
    JSON.stringify(
      {
        name: profile.name || 'unknown',
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
    3_500,
  );
}

function sanitize(raw: string): string {
  return normalizeWhitespace(
    raw
      .replace(/^```[a-z]*\s*/i, '')
      .replace(/```\s*$/i, '')
      .replace(/^"+|"+$/g, '')
      .replace(/\r\n?/g, '\n'),
  );
}

function replacePlaceholders(
  letter: string,
  input: { institution: string; title: string; group: string; name: string },
): string {
  return letter
    .replace(/\[(institution|university|employer)\]/gi, input.institution)
    .replace(/\[(position|role|position title)\]/gi, input.title)
    .replace(/\[(research group|group|department)\]/gi, input.group || 'the research group')
    .replace(/\[(your name|name)\]/gi, input.name)
    .replace(/\[(date)\]/gi, new Date().toISOString().slice(0, 10))
    .replace(/\[(supervisor|professor)\]/gi, 'the selection committee');
}

function templateLetter(input: {
  position: PhdPositionRecord;
  profile: ProfileDoc;
  matchedSkills: string[];
  publications: string[];
}): AiCoverLetter {
  const { position, profile } = input;
  const skills = (input.matchedSkills.length > 0 ? input.matchedSkills : profile.skills).slice(0, 6);
  const topic = position.researchTopic || position.title;
  const group = position.researchGroup ? `the ${position.researchGroup}` : 'your research group';
  const evidence = profile.experienceSummary
    ? profile.experienceSummary.replace(/\s+/g, ' ').trim()
    : 'My academic and technical background is summarised in the attached CV.';
  const publicationLine =
    input.publications.length > 0
      ? `My publication record includes: ${input.publications.slice(0, 3).join('; ')}.`
      : '';

  return {
    subjectLine: `Application for ${position.title}`,
    letterText: [
      'Dear Selection Committee,',
      `I am writing to apply for the doctoral position “${position.title}” at ${position.institution}. ${evidence}`,
      `The position's focus on ${topic} connects directly to my technical work${skills.length ? ` in ${skills.slice(0, 4).join(', ')}` : ''}. I am interested in contributing to ${group} because the advertised research direction matches the questions I have pursued in my academic work.`,
      publicationLine,
      'I would welcome the opportunity to discuss how my background could contribute to the group’s research programme. Thank you for considering my application.',
      profile.name ? `Sincerely,\n${profile.name}` : 'Sincerely,',
    ]
      .filter(Boolean)
      .join('\n\n'),
    claimsUsed: [...skills.map((skill) => `Skill evidenced in CV: ${skill}`), ...input.publications.slice(0, 3)],
    uncertainties: [
      'This letter was produced by the deterministic template because no AI model was available. Review and personalise it before use.',
    ],
  };
}

function positionHash(position: {
  title: string;
  institution: string;
  researchTopic?: string | null;
  description?: string | null;
}): string {
  return targetContentHash([
    position.title,
    position.institution,
    position.researchTopic,
    position.description,
  ]);
}

async function loadPositionAndDocuments(positionId: string) {
  const position = await PhdPositionModel.findById(positionId);
  if (!position) throw notFound('PhD position');
  const documents = await loadCandidateDocumentSets();
  const matches = await PhdMatchModel.find({ position: position._id }).select('profile score');
  const matchScores = new Map(matches.map((match) => [String(match.profile), match.score]));
  return { position, documents, matchScores };
}

function positionSelection(
  documents: Awaited<ReturnType<typeof loadCandidateDocumentSets>>,
  position: { title: string; researchTopic?: string | null; description?: string | null },
  matchScores: Map<string, number>,
  preferred?: { cvProfileId?: string; referenceProfileId?: string },
) {
  return selectCandidateDocuments({
    documents,
    jobTitle: position.title,
    jobText: `${position.title}\n${position.researchTopic ?? ''}\n${position.description ?? ''}`,
    matchScores,
    preferredCvProfileId: preferred?.cvProfileId,
    preferredReferenceProfileId: preferred?.referenceProfileId,
  });
}

export async function getPhdLetterOptions(positionId: string) {
  const { position, documents, matchScores } = await loadPositionAndDocuments(positionId);
  const auto = positionSelection(documents, position, matchScores);
  const savedCv = position.letterPreferences?.cvProfile
    ? String(position.letterPreferences.cvProfile)
    : '';
  const savedReference = position.letterPreferences?.referenceProfile
    ? String(position.letterPreferences.referenceProfile)
    : '';
  const chosen =
    savedCv || savedReference
      ? positionSelection(documents, position, matchScores, {
          cvProfileId: savedCv || undefined,
          referenceProfileId: savedReference || undefined,
        })
      : auto;

  const latest = await CoverLetterModel.findOne({
    phdPosition: position._id,
    letterType: 'phd',
  }).sort({ createdAt: -1 });
  const hash = positionHash(position);
  const limitations = [...chosen.selection.limitations];
  if (!(position.description ?? '').trim()) {
    limitations.push(
      'The PhD description is empty or unavailable. A letter generated now can only use the advertised title/topic, your CVs and your existing letters.',
    );
  }

  return {
    positionId: String(position._id),
    jobContentHash: hash,
    jobChangedSinceLetter: Boolean(latest?.jobContentHash && latest.jobContentHash !== hash),
    selectedCvProfileId: chosen.selection.cvProfileId,
    selectedReferenceProfileId: chosen.selection.referenceProfileId,
    recommendedCvProfileId: auto.selection.cvProfileId,
    recommendedReferenceProfileId: auto.selection.referenceProfileId,
    selectionRationale: chosen.selection.rationale,
    limitations,
    preferencesSaved: Boolean(savedCv || savedReference),
    latestLetter: latest
      ? {
          id: String(latest._id),
          version: latest.version,
          createdAt: latest.createdAt,
          jobContentHash: latest.jobContentHash,
        }
      : null,
    profiles: documents.map((doc) => ({
      profileId: doc.profileId,
      profileKind: doc.profileKind,
      label: doc.label,
      name: doc.name,
      cvDocumentId: doc.cvDocumentId,
      cvFilename: doc.cvFilename,
      cvReady: Boolean(doc.cvText.trim()),
      referenceDocumentId: doc.referenceDocumentId,
      referenceFilename: doc.referenceFilename,
      referenceReady: Boolean(doc.referenceText.trim()),
      recommended: doc.profileId === auto.selection.cvProfileId,
      referenceRecommended: doc.profileId === auto.selection.referenceProfileId,
      rank:
        auto.ranked.findIndex((item) => item.document.profileId === doc.profileId) + 1,
      score: Math.round(
        (auto.ranked.find((item) => item.document.profileId === doc.profileId)?.score ?? 0) * 100,
      ),
      rationale:
        auto.ranked.find((item) => item.document.profileId === doc.profileId)?.rationale ?? '',
    })),
  };
}

export async function setPhdLetterPreferences(input: {
  positionId: string;
  cvProfileId?: string;
  referenceProfileId?: string;
}) {
  const position = await PhdPositionModel.findById(input.positionId);
  if (!position) throw notFound('PhD position');
  const profiles = await CandidateProfileModel.find({
    _id: { $in: [input.cvProfileId, input.referenceProfileId].filter(Boolean) },
  });
  if (input.cvProfileId) {
    const profile = profiles.find((item) => String(item._id) === input.cvProfileId);
    if (!profile) throw notFound('Candidate profile');
    if (!profile.cvDocument) throw badRequest('The selected profile has no mapped CV.');
  }
  if (input.referenceProfileId) {
    const profile = profiles.find((item) => String(item._id) === input.referenceProfileId);
    if (!profile) throw notFound('Candidate profile');
    if (!profile.coverLetterDocument) {
      throw badRequest('The selected reference profile has no existing cover letter.');
    }
  }
  position.letterPreferences = {
    cvProfile: input.cvProfileId
      ? new Types.ObjectId(input.cvProfileId)
      : position.letterPreferences?.cvProfile ?? null,
    referenceProfile: input.referenceProfileId
      ? new Types.ObjectId(input.referenceProfileId)
      : position.letterPreferences?.referenceProfile ?? null,
    updatedAt: new Date(),
  };
  await position.save();
  return getPhdLetterOptions(input.positionId);
}

export async function generatePhdLetter(input: {
  positionId: string;
  profileId?: string;
  referenceProfileId?: string;
  instructions?: string;
}) {
  const { position, documents, matchScores } = await loadPositionAndDocuments(input.positionId);
  const savedCv = position.letterPreferences?.cvProfile
    ? String(position.letterPreferences.cvProfile)
    : '';
  const savedReference = position.letterPreferences?.referenceProfile
    ? String(position.letterPreferences.referenceProfile)
    : '';
  const { selection, ranked } = positionSelection(documents, position, matchScores, {
    cvProfileId: input.profileId ?? savedCv ?? undefined,
    referenceProfileId: input.referenceProfileId ?? savedReference ?? undefined,
  });

  if (!selection.cvProfileId) {
    throw badRequest('No readable CV is available. Map and process a CV before generating a letter.');
  }
  const selectedDocument = documents.find((doc) => doc.profileId === selection.cvProfileId);
  if (!selectedDocument?.cvText.trim()) {
    throw badRequest('The selected CV has no extracted text. Reprocess it on the Documents page.');
  }
  const profile = await CandidateProfileModel.findById(selection.cvProfileId);
  if (!profile) throw notFound('Candidate profile');

  const settings = await getSettings();
  const model = resolveModel(settings);
  const match = await PhdMatchModel.findOne({ position: position._id, profile: profile._id });
  const evidence = buildDocumentEvidence({
    documents,
    selection,
    jobTitle: position.title,
    jobText: `${position.title}\n${position.researchTopic ?? ''}\n${position.description ?? ''}`,
  });
  const matchedSkills = evidence.matchedSkills;
  const publications = match?.matchedPublications ?? [];
  const concerns = [...(match?.concerns ?? []), ...evidence.limitations];

  let letter: AiCoverLetter = templateLetter({ position, profile, matchedSkills, publications });
  let source: GeneratedLetter['source'] = 'template';
  let usedModel = 'deterministic-template';
  let promptVersion = 'phd-template-v1';
  let claimsUsed: string[] = [];
  let uncertainties: string[] = [];

  if (aiConfigured() && model) {
    try {
      const prompt = coverLetterDocumentPrompt({
        target: 'phd',
        title: position.title,
        organization: position.institution,
        location: position.location,
        description: truncate(position.description ?? '', 7_000),
        context: `Research topic: ${position.researchTopic || 'not stated'}\nResearch group: ${
          position.researchGroup || 'not stated'
        }\nDeadline: ${
          position.applicationDeadline ? position.applicationDeadline.toISOString().slice(0, 10) : 'not stated'
        }`,
        instructions: input.instructions,
        evidence: {
          selectedProfile: profilePayload(profile),
          selectedCvText: truncate(evidence.selectedCvText, 6_500),
          referenceLetterText: truncate(evidence.referenceLetterText, 3_000),
          otherCvEvidence: evidence.otherCvEvidence,
          otherLetterEvidence: evidence.otherLetterEvidence,
          matchedSkills,
          concerns,
          limitations: evidence.limitations,
        },
      });

      const result = await completeStructured({
        model,
        task: 'PhD cover letter',
        system: prompt.system,
        user: prompt.user,
        schema: coverLetterSchema,
        temperature: 0.35,
        maxTokens: Math.min(2_800, settings.ai.maxOutputTokens),
      });

      letter = result.data;
      source = 'generated';
      usedModel = result.model;
      promptVersion = PROMPT_VERSIONS.phdCoverLetter;
      claimsUsed = result.data.claimsUsed;
      uncertainties = result.data.uncertainties;
    } catch (error) {
      logger.warn(
        {
          positionId: String(position._id),
          error: error instanceof Error ? error.message : 'unknown',
        },
        'AI PhD cover letter failed; using template',
      );
      uncertainties = ['AI generation failed. This template letter must be reviewed carefully.'];
    }
  }

  if (source !== 'generated') {
    uncertainties =
      uncertainties.length > 0
        ? uncertainties
        : ['No AI model configured. This is a deterministic template; personalise it before use.'];
  }
  if (!(position.description ?? '').trim()) {
    uncertainties = [
      ...uncertainties,
      'The PhD description is empty or unavailable, so the letter cannot reference its specific requirements.',
    ];
  }

  const letterText = replacePlaceholders(sanitize(letter.letterText), {
    institution: position.institution,
    title: position.title,
    group: position.researchGroup,
    name: profile.name,
  });
  const grounding = checkGrounding({
    letterText,
    subjectLine: letter.subjectLine,
    sources: [...evidence.groundingTexts, profilePayload(profile)],
  });

  const generated: GeneratedLetter = {
    subjectLine: letter.subjectLine || `Application for ${position.title}`,
    letterText,
    source,
    model: usedModel,
    promptVersion,
    grounding,
    claimsUsed,
    uncertainties,
  };

  const previous = await CoverLetterModel.findOne({
    phdPosition: position._id,
    letterType: 'phd',
  }).sort({ version: -1 });
  const reference = documents.find(
    (doc) => doc.profileId === selection.referenceProfileId && doc.referenceText.trim(),
  );
  const sourceDocuments = documents.flatMap((doc) => {
    const entries: Array<{ document: string; profileKind: string; docType: string; role: string }> = [];
    if (doc.cvDocumentId) {
      entries.push({
        document: doc.cvDocumentId,
        profileKind: doc.profileKind,
        docType: 'cv',
        role: doc.profileId === selection.cvProfileId ? 'selected_cv' : 'other_cv',
      });
    }
    if (doc.referenceDocumentId) {
      entries.push({
        document: doc.referenceDocumentId,
        profileKind: doc.profileKind,
        docType: 'cover_letter',
        role:
          doc.profileId === selection.referenceProfileId ? 'reference_letter' : 'other_letter',
      });
    }
    return entries;
  });

  const saved = await saveCoverLetterVersion({
    phdPositionId: String(position._id),
    letterType: 'phd',
    profile,
    letter: generated,
    version: (previous?.version ?? 0) + 1,
    referenceLetterDocumentId: reference?.referenceDocumentId ?? null,
    referenceProfileId: selection.referenceProfileId || null,
    jobContentHash: positionHash(position),
    selectionRationale: `${selection.rationale} ${
      ranked.find((item) => item.document.profileId === selection.cvProfileId)?.rationale ?? ''
    }`.trim(),
    sourceDocuments,
  });

  position.letterPreferences = {
    cvProfile: new Types.ObjectId(selection.cvProfileId),
    referenceProfile: selection.referenceProfileId
      ? new Types.ObjectId(selection.referenceProfileId)
      : null,
    updatedAt: new Date(),
  };
  await position.save();

  return saved;
}

export async function listPhdLetters(positionId: string, profileId?: string) {
  const filter: Record<string, unknown> = { phdPosition: positionId, letterType: 'phd' };
  if (profileId) filter.profile = profileId;
  return CoverLetterModel.find(filter)
    .sort({ createdAt: -1 })
    .populate('profile', 'label name kind')
    .populate('referenceProfile', 'label name kind');
}

export async function getPhdLetter(positionId: string, letterId: string) {
  const letter = await CoverLetterModel.findOne({
    _id: letterId,
    phdPosition: positionId,
    letterType: 'phd',
  });
  if (!letter) throw notFound('Cover letter');
  return letter;
}

export async function editPhdLetter(input: { positionId: string; letterId: string; letterText: string }) {
  const letter = await getPhdLetter(input.positionId, input.letterId);
  const text = input.letterText.trim();
  if (text.length < 50) throw badRequest('The cover letter must be at least 50 characters.');
  letter.revisions.push({ text: letter.letterText, savedAt: new Date() });
  letter.letterText = text;
  letter.contentHash = sha256(text);
  letter.wordCount = wordCount(text);
  letter.source = 'edited';
  letter.editedByUser = true;
  await letter.save();
  return letter;
}

export async function phdLetterDownload(input: { positionId: string; letterId: string }) {
  const letter = await getPhdLetter(input.positionId, input.letterId);
  const position = await PhdPositionModel.findById(input.positionId);
  if (!position) throw notFound('PhD position');
  const profile = await CandidateProfileModel.findById(letter.profile);
  return { letter, position, profile };
}
