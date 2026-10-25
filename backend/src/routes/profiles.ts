import { Router } from 'express';
import { z } from 'zod';
import { objectIdSchema, profileUpdateSchema } from '../schemas.js';
import { PROFILE_KINDS, PROFILE_LABELS } from '../config/defaults.js';
import { CandidateProfileModel } from '../models/CandidateProfile.js';
import { listProfiles, updateProfile } from '../services/profilesService.js';
import { extractProfileFromCv } from '../services/profileExtraction.js';
import { conflict, notFound } from '../utils/errors.js';
import { serialize } from '../utils/serialize.js';
import { DocumentModel } from '../models/Document.js';

export const profilesRouter = Router();

profilesRouter.get('/', async (_req, res) => {
  const profiles = await listProfiles();
  const ids = profiles.flatMap((profile) =>
    [profile.cvDocument, profile.coverLetterDocument].filter(Boolean),
  );
  const docs = await DocumentModel.find({ _id: { $in: ids } });
  const docMap = new Map(docs.map((doc) => [String(doc._id), serialize(doc)]));

  res.json(
    profiles.map((profile) => ({
      ...serialize(profile),
      cvDocumentInfo: profile.cvDocument ? docMap.get(String(profile.cvDocument)) ?? null : null,
      coverLetterDocumentInfo: profile.coverLetterDocument
        ? docMap.get(String(profile.coverLetterDocument)) ?? null
        : null,
    })),
  );
});

profilesRouter.post('/', async (req, res) => {
  const body = z
    .object({
      kind: z.enum(PROFILE_KINDS),
      name: z.string().max(120).optional(),
      targetTitles: z.array(z.string().max(120)).max(30).optional(),
      skills: z.array(z.string().max(80)).max(100).optional(),
    })
    .strict()
    .parse(req.body);

  const existing = await CandidateProfileModel.findOne({ kind: body.kind });
  if (existing) {
    throw conflict('A profile for this career path already exists.', { profileId: String(existing._id) });
  }
  const profile = await CandidateProfileModel.create({
    kind: body.kind,
    label: PROFILE_LABELS[body.kind],
    name: body.name ?? '',
    targetTitles: body.targetTitles ?? [],
    skills: body.skills ?? [],
    status: 'draft',
    extractionSource: 'manual',
  });
  res.status(201).json(serialize(profile));
});

profilesRouter.get('/:id', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const profile = await CandidateProfileModel.findById(id);
  if (!profile) throw notFound('Candidate profile');
  res.json(serialize(profile));
});

profilesRouter.patch('/:id', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const patch = profileUpdateSchema.parse(req.body);
  const profile = await updateProfile(id, patch);
  res.json(serialize(profile));
});

profilesRouter.post('/:id/extract', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const result = await extractProfileFromCv(id);
  res.json({
    profile: serialize(result.profile),
    source: result.source,
    model: result.model,
    warnings: result.warnings,
  });
});
