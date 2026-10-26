import { Types, type HydratedDocument } from 'mongoose';
import { ChatSessionModel } from '../../models/ChatSession.js';
import { CoverLetterModel } from '../../models/CoverLetter.js';
import { JobMatchModel } from '../../models/JobMatch.js';
import { PhdMatchModel } from '../../models/PhdMatch.js';
import type { JobDoc } from '../../types/models.js';
import type { PhdPositionRecord } from '../../models/PhdPosition.js';
import { getSettings, resolveModel } from '../settingsService.js';
import { chatCompletion, type ChatMessage } from './client.js';
import { chatContextPrompt, chatSystemPrompt } from './prompts.js';
import {
  candidateSummary,
  loadCandidateDocumentSets,
  relevantExcerpts,
  selectCandidateDocuments,
  targetContentHash,
  type CandidateDocumentSet,
  type DocumentSelection,
} from './candidateDocuments.js';
import { truncate } from '../../utils/text.js';
import { badRequest, notFound } from '../../utils/errors.js';

export type PhdPositionDoc = HydratedDocument<PhdPositionRecord>;

export type ChatTarget =
  | { type: 'job'; job: JobDoc }
  | { type: 'phd'; position: PhdPositionDoc };

export interface ChatResponderInput {
  model: string;
  system: string;
  context: string;
  history: ChatMessage[];
  question: string;
  maxTokens: number;
}

export type ChatResponder = (
  input: ChatResponderInput,
) => Promise<{ content: string; model?: string }>;

export interface GroundedChatContext {
  system: string;
  context: string;
  selectedProfileId: string;
  selectedLetterId: string | null;
  targetHash: string;
  documentIds: string[];
  sources: string[];
  limitations: string[];
}

function targetFilter(target: ChatTarget): Record<string, unknown> {
  if (target.type === 'job') {
    return { targetType: 'job', job: target.job._id };
  }
  return { targetType: 'phd', phdPosition: target.position._id };
}

function targetMeta(target: ChatTarget) {
  if (target.type === 'job') {
    return {
      title: target.job.title,
      organization: target.job.employer,
      location: target.job.location,
      description: target.job.description ?? '',
      hash: targetContentHash([
        target.job.title,
        target.job.employer,
        target.job.description,
      ]),
    };
  }
  return {
    title: target.position.title,
    organization: target.position.institution,
    location: target.position.location,
    description: target.position.description ?? '',
    hash: targetContentHash([
      target.position.title,
      target.position.institution,
      target.position.researchTopic,
      target.position.description,
    ]),
  };
}

function rankingText(documents: CandidateDocumentSet[], selection: DocumentSelection) {
  return documents
    .map((doc, index) => `${index + 1}. ${doc.label} (${doc.cvFilename || 'no CV'})`)
    .join('\n')
    .concat(`\nSelected for this target: ${selection.cvProfileId ? 'see selected CV above' : 'none'}`);
}

function documentFacts(documents: CandidateDocumentSet[]): string {
  return documents
    .map((doc) => `--- ${doc.label}\n${truncate(candidateSummary(doc), 900)}`)
    .join('\n\n');
}

async function jobContext(
  job: JobDoc,
  question: string,
): Promise<GroundedChatContext> {
  const documents = await loadCandidateDocumentSets();
  const matches = await JobMatchModel.find({ job: job._id }).sort({ score: -1 });
  const matchScores = new Map(
    matches.map((match) => [String(match.profile), match.score]),
  );
  const latestLetter = await CoverLetterModel.findOne({
    job: job._id,
    letterType: 'job',
  }).sort({ createdAt: -1 });

  const savedCv = latestLetter?.profile
    ? String(latestLetter.profile)
    : job.letterPreferences?.cvProfile
      ? String(job.letterPreferences.cvProfile)
      : undefined;
  const savedReference = latestLetter?.referenceProfile
    ? String(latestLetter.referenceProfile)
    : job.letterPreferences?.referenceProfile
      ? String(job.letterPreferences.referenceProfile)
      : undefined;

  const { selection } = selectCandidateDocuments({
    documents,
    jobTitle: job.title,
    jobText: `${job.title}\n${job.description ?? ''}`,
    matchScores,
    preferredCvProfileId: savedCv,
    preferredReferenceProfileId: savedReference,
  });
  const selected = documents.find((doc) => doc.profileId === selection.cvProfileId);
  const reference = documents.find((doc) => doc.profileId === selection.referenceProfileId);
  const query = `${job.title}\n${question}\n${job.description ?? ''}`;

  const bestMatch =
    matches.find((match) => String(match.profile) === selection.cvProfileId) ?? matches[0] ?? null;
  const matchContext = bestMatch
    ? `Score: ${bestMatch.score}/100 (${bestMatch.profileKind}). ${bestMatch.explanation}\nMatched skills: ${
        bestMatch.matchedSkills.join(', ') || 'none listed'
      }\nMissing skills: ${bestMatch.missingSkills.join(', ') || 'none listed'}\nMandatory gaps: ${
        bestMatch.mandatoryRequirements?.filter((requirement) => requirement.status === 'missing').map((requirement) => requirement.label).join(', ') || 'none flagged'
      }\nAll profile scores: ${matches.map((match) => `${match.profileKind} ${match.score}`).join(', ')}`
    : 'No stored match evaluation. Run Evaluate profiles for an evidence-based comparison.';

  const limitations = [
    ...selection.limitations,
    ...(job.description ? [] : ['The job description is empty or unavailable.']),
    ...(latestLetter ? [] : ['No generated cover letter exists yet.']),
  ];

  const otherExcerpts = [
    ...documents
      .filter((doc) => doc.profileId !== selection.cvProfileId && doc.cvText.trim())
      .map(
        (doc) =>
          `${doc.label} CV (${doc.cvFilename}):\n${relevantExcerpts(doc.cvText, query, 700)}`,
      ),
    ...documents
      .filter((doc) => doc.profileId !== selection.referenceProfileId && doc.referenceText.trim())
      .map(
        (doc) =>
          `${doc.label} existing letter (${doc.referenceFilename}):\n${relevantExcerpts(
            doc.referenceText,
            query,
            400,
          )}`,
      ),
  ].join('\n\n');

  const facts = [
    `DOCUMENT RANKING:\n${rankingText(documents, selection)}`,
    `SELECTION RATIONALE: ${selection.rationale}`,
    `ALL PROFILES:\n${documentFacts(documents)}`,
    `JOB FACTS: employmentType=${job.employmentType || 'unknown'}; workArrangement=${
      job.workArrangement
    }; country=${job.country || 'unknown'}; remoteEligibleFromGermany=${
      job.remoteEligibleFromGermany === null ? 'not stated' : job.remoteEligibleFromGermany
    }; languageDecision=${job.languageDecision}; languageReason=${job.languageReason}`,
  ].join('\n\n');

  const sources = [
    'job description',
    ...(selected ? [`selected CV: ${selected.cvFilename}`] : []),
    ...(reference ? [`reference letter: ${reference.referenceFilename}`] : []),
    ...documents
      .filter((doc) => doc.profileId !== selection.cvProfileId && doc.cvText.trim())
      .map((doc) => `CV excerpt: ${doc.cvFilename}`),
    ...(bestMatch ? ['stored match assessment'] : []),
  ];

  return {
    system: chatSystemPrompt('job'),
    context: chatContextPrompt({
      target: 'job',
      title: job.title,
      organization: job.employer,
      location: job.location,
      description: truncate(job.description ?? '', 5_500),
      facts,
      matchContext,
      selectedCv: truncate(selected?.cvText ?? '', 2_500),
      referenceLetter: truncate(reference?.referenceText ?? '', 1_500),
      otherDocumentExcerpts: otherExcerpts,
      currentLetter: truncate(latestLetter?.letterText ?? '', 1_800),
      limitations,
    }),
    selectedProfileId: selection.cvProfileId,
    selectedLetterId: latestLetter?._id ? String(latestLetter._id) : null,
    targetHash: targetMeta({ type: 'job', job }).hash,
    documentIds: documents.flatMap((doc) =>
      [doc.cvDocumentId, doc.referenceDocumentId].filter((id): id is string => Boolean(id)),
    ),
    sources,
    limitations,
  };
}

async function phdContext(
  position: PhdPositionDoc,
  question: string,
): Promise<GroundedChatContext> {
  const documents = await loadCandidateDocumentSets();
  const matches = await PhdMatchModel.find({ position: position._id }).sort({ score: -1 });
  const matchScores = new Map(
    matches.map((match) => [String(match.profile), match.score]),
  );
  const latestLetter = await CoverLetterModel.findOne({
    phdPosition: position._id,
    letterType: 'phd',
  }).sort({ createdAt: -1 });

  const savedCv = latestLetter?.profile
    ? String(latestLetter.profile)
    : position.letterPreferences?.cvProfile
      ? String(position.letterPreferences.cvProfile)
      : undefined;
  const savedReference = latestLetter?.referenceProfile
    ? String(latestLetter.referenceProfile)
    : position.letterPreferences?.referenceProfile
      ? String(position.letterPreferences.referenceProfile)
      : undefined;

  const { selection } = selectCandidateDocuments({
    documents,
    jobTitle: position.title,
    jobText: `${position.title}\n${position.researchTopic ?? ''}\n${position.description ?? ''}`,
    matchScores,
    preferredCvProfileId: savedCv,
    preferredReferenceProfileId: savedReference,
  });
  const selected = documents.find((doc) => doc.profileId === selection.cvProfileId);
  const reference = documents.find((doc) => doc.profileId === selection.referenceProfileId);
  const query = `${position.title}\n${position.researchTopic ?? ''}\n${question}\n${
    position.description ?? ''
  }`;

  const bestMatch =
    matches.find((match) => String(match.profile) === selection.cvProfileId) ?? matches[0] ?? null;
  const matchContext = bestMatch
    ? `Estimated profile match: ${bestMatch.score}/100 (${bestMatch.profileKind}). ${bestMatch.explanation}\nMatched topics: ${
        bestMatch.matchedTopics.join(', ') || 'none listed'
      }\nMissing topics: ${bestMatch.missingTopics.join(', ') || 'none listed'}\nMatched skills: ${
        bestMatch.matchedSkills.join(', ') || 'none listed'
      }\nMandatory gaps: ${bestMatch.mandatoryMissing.join(', ') || 'none flagged'}\nRelevant publications: ${
        bestMatch.matchedPublications.join(' | ') || 'none listed'
      }\nAll profile scores: ${matches.map((match) => `${match.profileKind} ${match.score}`).join(', ')}`
    : 'No stored PhD match evaluation. Evaluate profiles for topic and qualification evidence.';

  const limitations = [
    ...selection.limitations,
    ...(position.description ? [] : ['The PhD description is empty or unavailable.']),
    ...(latestLetter ? [] : ['No generated PhD cover letter exists yet.']),
  ];

  const otherExcerpts = [
    ...documents
      .filter((doc) => doc.profileId !== selection.cvProfileId && doc.cvText.trim())
      .map(
        (doc) =>
          `${doc.label} CV (${doc.cvFilename}):\n${relevantExcerpts(doc.cvText, query, 700)}`,
      ),
    ...documents
      .filter((doc) => doc.profileId !== selection.referenceProfileId && doc.referenceText.trim())
      .map(
        (doc) =>
          `${doc.label} existing letter (${doc.referenceFilename}):\n${relevantExcerpts(
            doc.referenceText,
            query,
            400,
          )}`,
      ),
  ].join('\n\n');

  const facts = [
    `DOCUMENT RANKING:\n${rankingText(documents, selection)}`,
    `SELECTION RATIONALE: ${selection.rationale}`,
    `ALL PROFILES:\n${documentFacts(documents)}`,
    `PHD FACTS: institution=${position.institution}; researchGroup=${
      position.researchGroup || 'not stated'
    }; researchTopic=${position.researchTopic || 'not stated'}; workArrangement=${
      position.workArrangement
    }; remoteEligibleFromGermany=${
      position.remoteEligibleFromGermany === null
        ? 'not stated'
        : position.remoteEligibleFromGermany
    }; languageDecision=${position.languageDecision}; languageReason=${
      position.languageReason
    }; deadline=${
      position.applicationDeadline
        ? position.applicationDeadline.toISOString().slice(0, 10)
        : 'not stated'
    }; funding=${position.funding || 'not stated'}; salary=${position.salary || 'not stated'}; requiredQualifications=${
      position.requiredQualifications.join('; ') || 'not stated'
    }; employmentRequirements=${position.employmentRequirements.join('; ') || 'not stated'}`,
  ].join('\n\n');

  const sources = [
    'PhD description',
    ...(selected ? [`selected CV: ${selected.cvFilename}`] : []),
    ...(reference ? [`reference letter: ${reference.referenceFilename}`] : []),
    ...documents
      .filter((doc) => doc.profileId !== selection.cvProfileId && doc.cvText.trim())
      .map((doc) => `CV excerpt: ${doc.cvFilename}`),
    ...(bestMatch ? ['stored PhD match assessment'] : []),
  ];

  return {
    system: chatSystemPrompt('phd'),
    context: chatContextPrompt({
      target: 'phd',
      title: position.title,
      organization: position.institution,
      location: position.location,
      description: truncate(position.description ?? '', 5_500),
      facts,
      matchContext,
      selectedCv: truncate(selected?.cvText ?? '', 2_500),
      referenceLetter: truncate(reference?.referenceText ?? '', 1_500),
      otherDocumentExcerpts: otherExcerpts,
      currentLetter: truncate(latestLetter?.letterText ?? '', 1_800),
      limitations,
    }),
    selectedProfileId: selection.cvProfileId,
    selectedLetterId: latestLetter?._id ? String(latestLetter._id) : null,
    targetHash: targetMeta({ type: 'phd', position }).hash,
    documentIds: documents.flatMap((doc) =>
      [doc.cvDocumentId, doc.referenceDocumentId].filter((id): id is string => Boolean(id)),
    ),
    sources,
    limitations,
  };
}

export async function buildGroundedChatContext(
  target: ChatTarget,
  question: string,
): Promise<GroundedChatContext> {
  return target.type === 'job'
    ? jobContext(target.job, question)
    : phdContext(target.position, question);
}

async function defaultResponder(input: ChatResponderInput) {
  const messages: ChatMessage[] = [
    { role: 'system', content: input.system },
    { role: 'user', content: input.context },
    ...input.history,
    { role: 'user', content: input.question },
  ];
  const result = await chatCompletion({
    model: input.model,
    messages,
    temperature: 0.25,
    maxTokens: input.maxTokens,
    retries: 2,
  });
  return { content: result.content, model: result.model };
}

export async function getLatestChatSession(target: ChatTarget) {
  return ChatSessionModel.findOne(targetFilter(target)).sort({ updatedAt: -1 });
}

export async function createChatSession(target: ChatTarget) {
  const meta = targetMeta(target);
  return ChatSessionModel.create({
    ...targetFilter(target),
    title: target.type === 'job' ? meta.title : `${meta.title} — PhD`,
    messages: [],
  });
}

export async function clearChatSessions(target: ChatTarget): Promise<number> {
  const result = await ChatSessionModel.deleteMany(targetFilter(target));
  return result.deletedCount ?? 0;
}

export async function sendChatMessage(input: {
  target: ChatTarget;
  content: string;
  sessionId?: string;
  responder?: ChatResponder;
}) {
  const content = input.content.trim();
  if (!content) throw badRequest('Chat message cannot be empty.');
  if (content.length > 4_000) throw badRequest('Chat message is too long (maximum 4000 characters).');

  const settings = await getSettings();
  const model = resolveModel(settings);
  if (!model) {
    throw badRequest('No AI model is selected. Choose a model in Settings before using chat.');
  }

  let session = input.sessionId
    ? await ChatSessionModel.findOne({
        _id: input.sessionId,
        ...targetFilter(input.target),
      })
    : await getLatestChatSession(input.target);
  if (input.sessionId && !session) throw notFound('Chat session');
  if (!session) {
    session = await ChatSessionModel.create({
      ...targetFilter(input.target),
      title:
        input.target.type === 'job'
          ? input.target.job.title
          : `${input.target.position.title} — PhD`,
      messages: [],
    });
  }

  const history: ChatMessage[] = session.messages
    .slice(-6)
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: truncate(message.content, 1_500),
    }));

  const grounded = await buildGroundedChatContext(input.target, content);
  const responder = input.responder ?? defaultResponder;
  const reply = await responder({
    model,
    system: grounded.system,
    context: grounded.context,
    history,
    question: content,
    maxTokens: Math.min(1_400, settings.ai.maxOutputTokens),
  });
  if (!reply.content.trim()) throw badRequest('The AI returned an empty chat response.');

  session.messages.push({
    role: 'user',
    content,
    model: '',
    sources: [],
    createdAt: new Date(),
  });
  session.messages.push({
    role: 'assistant',
    content: reply.content.trim(),
    model: reply.model ?? model,
    sources: grounded.sources,
    createdAt: new Date(),
  });
  session.aiModel = reply.model ?? model;
  session.lastMessageAt = new Date();
  session.contextSnapshot = {
    targetContentHash: grounded.targetHash,
    selectedProfile: grounded.selectedProfileId
      ? new Types.ObjectId(grounded.selectedProfileId)
      : null,
    selectedLetter: grounded.selectedLetterId
      ? new Types.ObjectId(grounded.selectedLetterId)
      : null,
    documentIds: grounded.documentIds.map((id) => new Types.ObjectId(id)),
    notes: grounded.limitations,
  };
  if (!session.title) session.title = content.slice(0, 80);
  await session.save();

  return { session, reply: reply.content.trim(), model: reply.model ?? model, sources: grounded.sources };
}
