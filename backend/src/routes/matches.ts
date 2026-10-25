import { Router } from 'express';
import { z } from 'zod';
import { JobMatchModel } from '../models/JobMatch.js';
import { objectIdSchema, profileKindSchema } from '../schemas.js';
import { paginationSchema, parsePagination, paginated } from '../utils/pagination.js';
import { notFound } from '../utils/errors.js';
import { serialize } from '../utils/serialize.js';

export const matchesRouter = Router();

const matchListQuery = paginationSchema.extend({
  profileKind: profileKindSchema.optional(),
  profileId: objectIdSchema.optional(),
  jobId: objectIdSchema.optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
});

matchesRouter.get('/', async (req, res) => {
  const query = matchListQuery.parse(req.query);
  const pagination = parsePagination(query);

  const filter: Record<string, unknown> = {};
  if (query.profileKind) filter.profileKind = query.profileKind;
  if (query.profileId) filter.profile = query.profileId;
  if (query.jobId) filter.job = query.jobId;
  if (query.minScore !== undefined) filter.score = { $gte: query.minScore };

  const [matches, total] = await Promise.all([
    JobMatchModel.find(filter)
      .sort({ score: -1, evaluatedAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit)
      .populate('job', 'title employer location url status source workArrangement languageRequirement')
      .populate('profile', 'label kind status'),
    JobMatchModel.countDocuments(filter),
  ]);

  res.json(paginated(matches.map((match) => serialize(match)), total, pagination));
});

matchesRouter.get('/:id', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const match = await JobMatchModel.findById(id)
    .populate('job')
    .populate('profile');
  if (!match) throw notFound('Match');
  res.json(serialize(match));
});
