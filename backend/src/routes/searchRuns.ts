import { Router } from 'express';
import { z } from 'zod';
import { SearchRunModel } from '../models/SearchRun.js';
import { objectIdSchema } from '../schemas.js';
import { paginationSchema, parsePagination, paginated } from '../utils/pagination.js';
import { notFound } from '../utils/errors.js';
import { serialize } from '../utils/serialize.js';

export const searchRunsRouter = Router();

searchRunsRouter.get('/', async (req, res) => {
  const query = paginationSchema.extend({ kind: z.enum(['jobs', 'phd']).optional() }).parse(req.query);
  const pagination = parsePagination(query);
  const filter: Record<string, unknown> = {};
  if (query.kind) filter.kind = query.kind;
  const [runs, total] = await Promise.all([
    SearchRunModel.find(filter).sort({ startedAt: -1 }).skip(pagination.skip).limit(pagination.limit),
    SearchRunModel.countDocuments(filter),
  ]);
  res.json(paginated(runs.map((run) => serialize(run)), total, pagination));
});

searchRunsRouter.get('/:id', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const run = await SearchRunModel.findById(id);
  if (!run) throw notFound('Search run');
  res.json(serialize(run));
});
