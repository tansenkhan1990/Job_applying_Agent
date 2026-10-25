import { CandidateProfileModel } from '../models/CandidateProfile.js';
import { DocumentModel } from '../models/Document.js';
import { DEFAULT_PROFILES, PROFILE_KINDS, PROFILE_LABELS, type ProfileKind } from '../config/defaults.js';
import { notFound } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export async function ensureDefaultProfiles(): Promise<void> {
  for (const seed of DEFAULT_PROFILES) {
    await CandidateProfileModel.updateOne(
      { kind: seed.kind },
      {
        $setOnInsert: {
          kind: seed.kind,
          label: PROFILE_LABELS[seed.kind],
          name: '',
          targetTitles: seed.targetTitles,
          skills: seed.skills,
          workPreferences: seed.workPreferences,
          status: 'draft',
          extractionSource: 'default',
        },
      },
      { upsert: true },
    );
  }
  logger.info({ profiles: PROFILE_KINDS.length }, 'Career profiles ensured');
}

/**
 * Link the most recently mapped CV / cover letter documents to each profile.
 * Documents are the source of truth for the mapping; profiles cache the pair.
 */
export async function linkProfileDocuments(): Promise<void> {
  const docs = await DocumentModel.find({
    profileKind: { $in: PROFILE_KINDS },
    docType: { $in: ['cv', 'cover_letter'] },
    missing: false,
    status: { $in: ['processed', 'needs_ocr'] },
  })
    .sort({ lastScannedAt: -1, updatedAt: -1 })
    .lean();

  for (const kind of PROFILE_KINDS) {
    const cv = docs.find((doc) => doc.profileKind === kind && doc.docType === 'cv');
    const cover = docs.find((doc) => doc.profileKind === kind && doc.docType === 'cover_letter');
    await CandidateProfileModel.updateOne(
      { kind },
      {
        $set: {
          cvDocument: cv?._id ?? null,
          coverLetterDocument: cover?._id ?? null,
        },
      },
    );
  }
}

export async function listProfiles() {
  return CandidateProfileModel.find().sort({ createdAt: 1 });
}

export async function getProfileByIdOrKind(input: { id?: string; kind?: ProfileKind }) {
  const profile = input.id
    ? await CandidateProfileModel.findById(input.id)
    : input.kind
      ? await CandidateProfileModel.findOne({ kind: input.kind })
      : null;
  if (!profile) throw notFound('Candidate profile');
  return profile;
}

export async function updateProfile(id: string, patch: Record<string, unknown>) {
  const profile = await CandidateProfileModel.findById(id);
  if (!profile) throw notFound('Candidate profile');

  const editable = [
    'name',
    'targetTitles',
    'skills',
    'experienceSummary',
    'yearsExperience',
    'location',
    'languages',
    'experience',
    'education',
    'certifications',
    'projects',
    'publications',
    'workPreferences',
    'status',
    'reviewNotes',
  ] as const;

  for (const key of editable) {
    if (patch[key] !== undefined) {
      (profile as unknown as Record<string, unknown>)[key] = patch[key];
    }
  }
  profile.extractionSource = profile.extractionSource === 'default' ? 'manual' : profile.extractionSource;
  await profile.save();
  return profile;
}
