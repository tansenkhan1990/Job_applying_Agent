import { Router } from 'express';
import { z } from 'zod';
import { JobModel } from '../models/Job.js';
import { JobMatchModel } from '../models/JobMatch.js';
import { ApplicationModel } from '../models/Application.js';
import { objectIdSchema, jobSearchSchema, matchRequestSchema, profileKindSchema } from '../schemas.js';
import { paginationSchema, parsePagination, paginated } from '../utils/pagination.js';
import { runDiscovery, getSourceConfigStatuses } from '../services/jobs/discovery.js';
import { matchJob } from '../services/matching/index.js';
import { verifyJobAvailability } from '../services/jobs/verify.js';
import { classifyLanguage } from '../services/jobs/language.js';
import { assessJobAge } from '../services/jobs/age.js';
import { notFound } from '../utils/errors.js';
import { serialize } from '../utils/serialize.js';

export const jobsRouter = Router();

const jobListQuery = paginationSchema.extend({
  q: z.string().max(200).optional(),
  status: z.enum(['active', 'expired', 'unavailable', 'duplicate']).optional(),
  source: z.string().max(40).optional(),
  profileKind: profileKindSchema.optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  // "true" hides vacancies whose posting mandates German. Optional/unknown postings stay.
  excludeGermanRequired: z.enum(['true', 'false']).optional(),
  languageDecision: z.enum(['Eligible', 'Excluded', 'Needs Review']).optional(),
  germanOptional: z.enum(['true', 'false']).optional(),
  englishRequired: z.enum(['true', 'false']).optional(),
  ageEligibility: z.enum(['Eligible', 'Too Recent', 'Unknown', 'Expired']).optional(),
  postedBefore: z.coerce.date().optional(),
  postedAfter: z.coerce.date().optional(),
});

jobsRouter.post('/search', async (req, res) => {
  const body = jobSearchSchema.parse(req.body ?? {});
  const result = await runDiscovery({ trigger: 'manual', overrides: body });
  res.status(201).json(result);
});

jobsRouter.get('/sources', async (_req, res) => {
  res.json(await getSourceConfigStatuses());
});

jobsRouter.get('/', async (req, res) => {
  const query = jobListQuery.parse(req.query);
  const pagination = parsePagination(query);

  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.source) filter.source = query.source;
  if (query.excludeGermanRequired === 'true') {
    filter.languageDecision = { $ne: 'Excluded' };
    filter.languageRequirement = { $ne: 'german_required' };
  } else if (query.languageDecision) {
    filter.languageDecision = query.languageDecision;
  }
  if (query.germanOptional === 'true') filter.germanOptional = true;
  if (query.englishRequired === 'true') filter.englishRequired = true;
  if (query.ageEligibility) filter.ageEligibility = query.ageEligibility;
  if (query.postedBefore) filter.postedAt = { ...(filter.postedAt as object), $lte: query.postedBefore };
  if (query.postedAfter) filter.postedAt = { ...(filter.postedAt as object), $gte: query.postedAfter };
  if (query.q) {
    filter.$or = [
      { title: { $regex: query.q, $options: 'i' } },
      { employer: { $regex: query.q, $options: 'i' } },
      { location: { $regex: query.q, $options: 'i' } },
    ];
  }

  if (query.minScore !== undefined || query.profileKind) {
    const matchFilter: Record<string, unknown> = {};
    if (query.minScore !== undefined) matchFilter.score = { $gte: query.minScore };
    if (query.profileKind) matchFilter.profileKind = query.profileKind;
    const jobIds = await JobMatchModel.find(matchFilter).distinct('job');
    filter._id = { $in: jobIds };
  }

  const [jobs, total] = await Promise.all([
    JobModel.find(filter)
      .sort({ discoveredAt: -1 })
      .skip(pagination.skip)
      .limit(pagination.limit),
    JobModel.countDocuments(filter),
  ]);

  const jobIds = jobs.map((job) => job._id);
  const matchFilter: Record<string, unknown> = { job: { $in: jobIds } };
  if (query.profileKind) matchFilter.profileKind = query.profileKind;
  const matches = await JobMatchModel.find(matchFilter).populate('profile', 'label kind');
  const bestByJob = new Map<string, unknown>();
  for (const match of matches) {
    const key = String(match.job);
    const current = bestByJob.get(key) as { score?: number } | undefined;
    if (!current || (match.score ?? 0) > (current.score ?? 0)) bestByJob.set(key, match);
  }

  // Show whether a stored vacancy already has an application, so an applied job is never
  // re-prepared by mistake.
  const applications = await ApplicationModel.find({ job: { $in: jobIds } })
    .select('job status appliedAt submission.attemptedAt')
    .sort({ createdAt: -1 });
  const applicationByJob = new Map<string, (typeof applications)[number]>();
  for (const application of applications) {
    const key = String(application.job);
    const current = applicationByJob.get(key);
    if (!current || (current.status !== 'SUBMITTED' && application.status === 'SUBMITTED')) {
      applicationByJob.set(key, application);
    }
  }

  const items = jobs.map((job) => {
    const data = serialize<Record<string, unknown>>(job);
    delete data.description;
    const application = applicationByJob.get(String(job._id));
    return {
      ...data,
      descriptionPreview: (job.description ?? '').slice(0, 320),
      bestMatch: bestByJob.get(String(job._id)) ? serialize(bestByJob.get(String(job._id))) : null,
      application: application
        ? {
            id: String(application._id),
            status: application.status,
            appliedAt: application.appliedAt ?? application.submission?.attemptedAt ?? null,
          }
        : null,
    };
  });

  res.json(paginated(items, total, pagination));
});

jobsRouter.get('/:id', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const job = await JobModel.findById(id);
  if (!job) throw notFound('Job');
  const matches = await JobMatchModel.find({ job: job._id })
    .sort({ score: -1 })
    .populate('profile', 'label kind status');
  res.json({
    job: serialize(job),
    matches: matches.map((match) => serialize(match)),
  });
});

jobsRouter.post('/:id/age-check', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const job = await JobModel.findById(id);
  if (!job) throw notFound('Job');
  const assessment = assessJobAge({
    postedAt: job.postedAt,
    postedLocalDate: job.postedLocalDate,
    expiresAt: job.expiresAt,
    status: job.status,
  });
  const updated = await JobModel.findByIdAndUpdate(
    id,
    { $set: { ...assessment } },
    { new: true },
  );
  res.json({ job: serialize(updated), assessment });
});

jobsRouter.post('/:id/classify-language', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const job = await JobModel.findById(id);
  if (!job) throw notFound('Job');

  const classification = classifyLanguage({
    title: job.title,
    location: job.location,
    description: job.description,
  });
  const update = {
    ...classification,
    languageClassifiedAt: new Date(),
  };
  const updated = await JobModel.findByIdAndUpdate(id, { $set: update }, { new: true });
  res.json({ job: serialize(updated) });
});

jobsRouter.post('/:id/match', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const body = matchRequestSchema.parse(req.body ?? {});
  const matches = await matchJob(id, body);
  res.json({ matches: matches.map((match) => serialize(match)) });
});

jobsRouter.post('/:id/verify', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const result = await verifyJobAvailability(id);
  const job = await JobModel.findById(id);
  if (!job) throw notFound('Job');
  res.json({ verification: result, job: serialize(job) });
});
