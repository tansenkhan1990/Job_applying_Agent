import { Types } from 'mongoose';
import { JobModel } from '../../models/Job.js';
import { JobMatchModel } from '../../models/JobMatch.js';
import { CoverLetterModel } from '../../models/CoverLetter.js';
import { CandidateProfileModel } from '../../models/CandidateProfile.js';
import { notFound, badRequest } from '../../utils/errors.js';
import { sha256 } from '../../utils/hash.js';
import { wordCount } from '../../utils/text.js';
import {
  buildDocumentEvidence,
  loadCandidateDocumentSets,
  selectCandidateDocuments,
  targetContentHash,
  type CandidateDocumentSet,
  type DocumentSelection,
} from '../ai/candidateDocuments.js';
import { generateCoverLetter, saveCoverLetterVersion } from './generate.js';

function currentHash(job: { title: string; employer: string; description?: string | null }): string {
  return targetContentHash([job.title, job.employer, job.description]);
}

async function loadJobAndDocuments(jobId: string) {
  const job = await JobModel.findById(jobId);
  if (!job) throw notFound('Job');
  const documents = await loadCandidateDocumentSets();
  const matches = await JobMatchModel.find({ job: job._id }).select('profile score');
  const matchScores = new Map(matches.map((match) => [String(match.profile), match.score]));
  return { job, documents, matchScores };
}

function selectionFor(
  documents: CandidateDocumentSet[],
  job: { title: string; description?: string | null },
  matchScores: Map<string, number>,
  preferred?: { cvProfileId?: string; referenceProfileId?: string },
) {
  return selectCandidateDocuments({
    documents,
    jobTitle: job.title,
    jobText: `${job.title}\n${job.description ?? ''}`,
    matchScores,
    preferredCvProfileId: preferred?.cvProfileId,
    preferredReferenceProfileId: preferred?.referenceProfileId,
  });
}

export async function getJobLetterOptions(jobId: string) {
  const { job, documents, matchScores } = await loadJobAndDocuments(jobId);
  const auto = selectionFor(documents, job, matchScores);
  const savedCv = job.letterPreferences?.cvProfile ? String(job.letterPreferences.cvProfile) : '';
  const savedReference = job.letterPreferences?.referenceProfile
    ? String(job.letterPreferences.referenceProfile)
    : '';
  const chosen =
    savedCv || savedReference
      ? selectionFor(documents, job, matchScores, {
          cvProfileId: savedCv || undefined,
          referenceProfileId: savedReference || undefined,
        })
      : auto;

  const latest = await CoverLetterModel.findOne({ job: job._id, letterType: 'job' }).sort({
    createdAt: -1,
  });
  const hash = currentHash(job);
  const limitations = [...chosen.selection.limitations];
  if (!(job.description ?? '').trim()) {
    limitations.push(
      'The job description is empty or unavailable. A letter generated now can only use the job title, your CVs and your existing letters.',
    );
  }

  return {
    jobId: String(job._id),
    jobContentHash: hash,
    jobChangedSinceLetter: Boolean(
      latest?.jobContentHash && latest.jobContentHash !== hash,
    ),
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
      score: Math.round((auto.ranked.find((item) => item.document.profileId === doc.profileId)?.score ?? 0) * 100),
      rationale:
        auto.ranked.find((item) => item.document.profileId === doc.profileId)?.rationale ?? '',
    })),
  };
}

/** Validate and persist a per-job CV/reference choice before generation. */
export async function setJobLetterPreferences(input: {
  jobId: string;
  cvProfileId?: string;
  referenceProfileId?: string;
}) {
  const job = await JobModel.findById(input.jobId);
  if (!job) throw notFound('Job');
  const profiles = await CandidateProfileModel.find({
    _id: {
      $in: [input.cvProfileId, input.referenceProfileId].filter(Boolean),
    },
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
  job.letterPreferences = {
    cvProfile: input.cvProfileId
      ? new Types.ObjectId(input.cvProfileId)
      : job.letterPreferences?.cvProfile ?? null,
    referenceProfile: input.referenceProfileId
      ? new Types.ObjectId(input.referenceProfileId)
      : job.letterPreferences?.referenceProfile ?? null,
    updatedAt: new Date(),
  };
  await job.save();
  return getJobLetterOptions(input.jobId);
}

/**
 * Generate a fresh cover-letter version for a stored vacancy. All three CVs and all three
 * existing letters are loaded; the most relevant are selected and the rest contribute only
 * query-relevant excerpts. This never creates an application and never submits anything.
 */
export async function generateJobLetter(input: {
  jobId: string;
  profileId?: string;
  referenceProfileId?: string;
  instructions?: string;
}) {
  const { job, documents, matchScores } = await loadJobAndDocuments(input.jobId);
  const savedCv = job.letterPreferences?.cvProfile ? String(job.letterPreferences.cvProfile) : '';
  const savedReference = job.letterPreferences?.referenceProfile
    ? String(job.letterPreferences.referenceProfile)
    : '';

  const { selection, ranked } = selectionFor(documents, job, matchScores, {
    cvProfileId: input.profileId ?? savedCv ?? undefined,
    referenceProfileId: input.referenceProfileId ?? savedReference ?? undefined,
  });

  if (!selection.cvProfileId) {
    throw badRequest('No readable CV is available. Map and process a CV before generating a cover letter.');
  }
  const selectedDocument = documents.find((doc) => doc.profileId === selection.cvProfileId);
  if (!selectedDocument?.cvText.trim()) {
    throw badRequest('The selected CV has no extracted text. Reprocess it on the Documents page.');
  }
  const profile = await CandidateProfileModel.findById(selection.cvProfileId);
  if (!profile) throw notFound('Candidate profile');

  const match = await JobMatchModel.findOne({
    job: job._id,
    profile: profile._id,
  }).sort({ score: -1 });
  const evidence = buildDocumentEvidence({
    documents,
    selection,
    jobTitle: job.title,
    jobText: `${job.title}\n${job.description ?? ''}`,
  });

  const letter = await generateCoverLetter({
    job,
    profile,
    match,
    instructions: input.instructions,
    documentEvidence: evidence,
  });

  const previous = await CoverLetterModel.findOne({ job: job._id, letterType: 'job' }).sort({
    version: -1,
  });
  const reference = documents.find(
    (doc) => doc.profileId === selection.referenceProfileId && doc.referenceText.trim(),
  );
  const hash = currentHash(job);
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
    job,
    profile,
    letter,
    letterType: 'job',
    version: (previous?.version ?? 0) + 1,
    referenceLetterDocumentId: reference?.referenceDocumentId ?? null,
    referenceProfileId: selection.referenceProfileId || null,
    jobContentHash: hash,
    selectionRationale: `${selection.rationale} ${
      ranked.find((item) => item.document.profileId === selection.cvProfileId)?.rationale ?? ''
    }`.trim(),
    sourceDocuments,
  });

  job.letterPreferences = {
    cvProfile: new Types.ObjectId(selection.cvProfileId),
    referenceProfile: selection.referenceProfileId
      ? new Types.ObjectId(selection.referenceProfileId)
      : null,
    updatedAt: new Date(),
  };
  await job.save();

  return saved;
}

export async function listJobLetters(jobId: string, profileId?: string) {
  const filter: Record<string, unknown> = { job: jobId, letterType: 'job' };
  if (profileId) filter.profile = profileId;
  return CoverLetterModel.find(filter)
    .sort({ createdAt: -1 })
    .populate('profile', 'label name kind')
    .populate('referenceProfile', 'label name kind');
}

export async function getJobLetter(jobId: string, letterId: string) {
  const letter = await CoverLetterModel.findOne({ _id: letterId, job: jobId, letterType: 'job' });
  if (!letter) throw notFound('Cover letter');
  return letter;
}

export async function editJobLetter(input: { jobId: string; letterId: string; letterText: string }) {
  const letter = await getJobLetter(input.jobId, input.letterId);
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

export async function jobLetterDownload(input: { jobId: string; letterId: string }) {
  const letter = await getJobLetter(input.jobId, input.letterId);
  const job = await JobModel.findById(input.jobId);
  if (!job) throw notFound('Job');
  const profile = await CandidateProfileModel.findById(letter.profile);
  return { letter, job, profile };
}

export type { DocumentSelection };
