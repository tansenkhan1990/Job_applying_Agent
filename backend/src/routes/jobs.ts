import { Router } from 'express';
import { z } from 'zod';
import { JobModel } from '../models/Job.js';
import { JobMatchModel } from '../models/JobMatch.js';
import { CoverLetterModel } from '../models/CoverLetter.js';
import { objectIdSchema, jobSearchSchema, matchRequestSchema, profileKindSchema } from '../schemas.js';
import { paginationSchema, parsePagination, paginated } from '../utils/pagination.js';
import { runDiscovery, getSourceConfigStatuses } from '../services/jobs/discovery.js';
import { ensureDeterministicMatches, matchJob } from '../services/matching/index.js';
import { verifyJobAvailability } from '../services/jobs/verify.js';
import { renderLetterDocx, renderLetterPdf } from '../services/coverLetters/render.js';
import {
  clearChatSessions,
  createChatSession,
  getLatestChatSession,
  sendChatMessage,
} from '../services/ai/chat.js';
import {
  editJobLetter,
  generateJobLetter,
  getJobLetterOptions,
  jobLetterDownload,
  listJobLetters,
  setJobLetterPreferences,
} from '../services/coverLetters/jobLetters.js';
import { escapeRegExp } from '../utils/text.js';
import { classifyLanguage } from '../services/jobs/language.js';
import { assessJobAge, effectiveMaxAgeMonths, jobAgeCutoff } from '../services/jobs/age.js';
import { getSettings } from '../services/settingsService.js';
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
  postedWithinDays: z.coerce.number().int().min(1).max(3650).optional(),
  maxScore: z.coerce.number().min(0).max(100).optional(),
  employer: z.string().max(160).optional(),
  seniority: z.string().max(20).optional(),
  employmentType: z.string().max(80).optional(),
  workArrangement: z.enum(['remote', 'hybrid', 'onsite', 'unknown']).optional(),
  country: z.string().max(80).optional(),
  locationScope: z.enum(['germany', 'outside_germany_remote']).optional(),
  remoteEligibleFromGermany: z.enum(['true', 'false']).optional(),
  minSalary: z.coerce.number().min(0).max(1_000_000).optional(),
  saved: z.enum(['true', 'false']).optional(),
  reviewed: z.enum(['true', 'false']).optional(),
  hasCoverLetter: z.enum(['true', 'false']).optional(),
  category: z
    .enum(['fullstack', 'backend', 'ai', 'devops_cloud', 'software'])
    .optional(),
  sort: z.enum(['newest', 'oldest', 'score', 'company', 'title']).default('newest'),
});

const CATEGORY_PATTERNS: Record<string, RegExp> = {
  fullstack: /full[- ]?stack/i,
  backend: /backend|back[- ]end|api engineer|server[- ]side/i,
  ai: /\bai\b|llm|machine learning|generative|genai|rag|nlp|deep learning/i,
  devops_cloud: /devops|cloud|platform|sre|site reliability|kubernetes/i,
  software: /software engineer|software developer|application developer/i,
};

function buildJobList(
  jobs: Array<{
    _id: unknown;
    description?: string | null;
    postedAt?: Date | null;
    postedLocalDate?: string | null;
    expiresAt?: Date | null;
    status?: string | null;
  }>,
  matches: unknown[],
  maxAgeMonths: number,
) {
  const bestByJob = new Map<string, unknown>();
  for (const match of matches) {
    const { job, score } = match as { job?: unknown; score?: number };
    const key = String(job);
    const current = bestByJob.get(key) as { score?: number } | undefined;
    if (!current || (score ?? 0) > (current.score ?? 0)) bestByJob.set(key, match);
  }

  return jobs.map((job) => {
    const data = serialize<Record<string, unknown>>(job);
    delete data.description;
    // Recompute instead of trusting the classification stored at discovery time, so jobs
    // saved under an older age rule never show a stale badge.
    const age = assessJobAge({
      postedAt: job.postedAt,
      postedLocalDate: job.postedLocalDate,
      expiresAt: job.expiresAt,
      status: job.status,
      months: maxAgeMonths,
    });
    data.ageEligibility = age.ageEligibility;
    data.eligibleAfter = age.eligibleAfter;
    data.ageCheckAt = age.ageCheckAt;
    data.ageReason = age.ageReason;
    const best = bestByJob.get(String(job._id));
    return {
      ...data,
      descriptionPreview: (job.description ?? '').slice(0, 320),
      bestMatch: best ? serialize(best) : null,
    };
  });
}

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
  const settings = await getSettings();
  const maxAgeMonths = effectiveMaxAgeMonths(settings.search.maxAgeMonths);
  const cutoff = jobAgeCutoff(maxAgeMonths);

  const filter: Record<string, unknown> = {};
  // Expired, unavailable and duplicate rows never belong in normal results; they stay
  // reachable only by asking for that status explicitly.
  filter.status = query.status ?? 'active';
  if (query.source) filter.source = query.source;
  // Language eligibility is a mandatory filter: unless the caller explicitly asks for
  // excluded listings, the configured default hides mandatory-German vacancies.
  const excludeGermanRequired =
    query.excludeGermanRequired === 'true' ||
    (query.excludeGermanRequired === undefined &&
      query.languageDecision === undefined &&
      settings.search.excludeGermanRequired);
  if (excludeGermanRequired) {
    filter.languageDecision = { $ne: 'Excluded' };
    filter.languageRequirement = { $ne: 'german_required' };
  } else if (query.languageDecision) {
    filter.languageDecision = query.languageDecision;
  }
  if (query.germanOptional === 'true') filter.germanOptional = true;
  if (query.englishRequired === 'true') filter.englishRequired = true;
  if (query.ageEligibility === 'Unknown') {
    // Separate review view: listings whose original posting date cannot be verified. They are
    // never mixed into normal results and can never be prepared for an application.
    filter.postedAt = null;
  } else {
    if (query.ageEligibility) filter.ageEligibility = query.ageEligibility;
    // Every posting-date filter is clamped to the three-calendar-month floor. A custom or
    // broader range can narrow results, but it can never reveal an older vacancy.
    const requestedAfter =
      query.postedAfter ??
      (query.postedWithinDays
        ? new Date(Date.now() - query.postedWithinDays * 86_400_000)
        : null);
    const lowerBound =
      requestedAfter && requestedAfter.getTime() > cutoff.getTime() ? requestedAfter : cutoff;
    filter.postedAt = {
      $gt: cutoff,
      ...(requestedAfter ? { $gte: lowerBound } : {}),
      ...(query.postedBefore ? { $lte: query.postedBefore } : {}),
    };
    // Listings without a verifiable original date are excluded from normal results even
    // when the caller supplies a broad or custom date range.
    filter.postedAt = { ...(filter.postedAt as object), $ne: null };
  }
  // Every free-text filter is escaped: the user's text is matched literally, so a title such
  // as "C++ Developer" can be searched for and a stray bracket cannot break the query.
  if (query.employer) filter.employer = { $regex: escapeRegExp(query.employer), $options: 'i' };
  if (query.seniority) filter.seniority = query.seniority;
  if (query.employmentType) {
    filter.employmentType = { $regex: escapeRegExp(query.employmentType), $options: 'i' };
  }
  if (query.workArrangement) filter.workArrangement = query.workArrangement;
  if (query.country) filter.country = { $regex: escapeRegExp(query.country), $options: 'i' };
  if (query.remoteEligibleFromGermany === 'true') filter.remoteEligibleFromGermany = true;
  if (query.remoteEligibleFromGermany === 'false') filter.remoteEligibleFromGermany = false;
  // salaryMax is the upper bound of the advertised range; only use it when the source
  // actually published a number (missing salaries stay null and are excluded).
  if (query.minSalary !== undefined) filter.salaryMax = { $gte: query.minSalary };
  if (query.locationScope === 'germany') {
    filter.country = 'Germany';
  } else if (query.locationScope === 'outside_germany_remote') {
    filter.workArrangement = 'remote';
    filter.country = { $nin: ['Germany', ''] };
  }
  if (query.saved === 'true') filter.saved = true;
  if (query.reviewed === 'false') filter.reviewedAt = null;
  if (query.reviewed === 'true') filter.reviewedAt = { $ne: null };
  if (query.category) {
    filter.title = { $regex: CATEGORY_PATTERNS[query.category].source, $options: 'i' };
  }
  if (query.hasCoverLetter === 'true' || query.hasCoverLetter === 'false') {
    const letterJobIds = await CoverLetterModel.distinct('job');
    const clause = query.hasCoverLetter === 'true' ? { $in: letterJobIds } : { $nin: letterJobIds };
    filter.$and = [...((filter.$and as unknown[]) ?? []), { _id: clause }];
  }
  if (query.q) {
    const pattern = escapeRegExp(query.q);
    filter.$or = [
      { title: { $regex: pattern, $options: 'i' } },
      { employer: { $regex: pattern, $options: 'i' } },
      { location: { $regex: pattern, $options: 'i' } },
    ];
  }

  if (query.minScore !== undefined || query.maxScore !== undefined || query.profileKind) {
    const matchFilter: Record<string, unknown> = {};
    if (query.minScore !== undefined) matchFilter.score = { ...(matchFilter.score as object), $gte: query.minScore };
    if (query.maxScore !== undefined) matchFilter.score = { ...(matchFilter.score as object), $lte: query.maxScore };
    if (query.profileKind) matchFilter.profileKind = query.profileKind;
    const jobIds = await JobMatchModel.find(matchFilter)
      .distinct('job');
    filter._id = { $in: jobIds };
  }

  const jobSort: Record<string, 1 | -1> =
    query.sort === 'oldest'
      ? { postedAt: 1, discoveredAt: 1 }
      : query.sort === 'company'
        ? { employer: 1 }
        : query.sort === 'title'
          ? { title: 1 }
          : { postedAt: -1, discoveredAt: -1 };

  if (query.sort === 'score') {
    // The best match score lives in a separate collection, so sort a bounded candidate pool
    // in memory. The local dashboard holds far fewer rows than this cap.
    const pool = await JobModel.find(filter).limit(1_000);
    const poolIds = pool.map((job) => job._id);
    const poolMatches = await JobMatchModel.find({ job: { $in: poolIds } }).populate('profile', 'label kind');
    const best = new Map<string, { score?: number }>();
    for (const match of poolMatches) {
      const key = String(match.job);
      const current = best.get(key);
      if (!current || (match.score ?? 0) > (current.score ?? 0)) best.set(key, match);
    }
    pool.sort(
      (a, b) =>
        (best.get(String(b._id))?.score ?? -1) - (best.get(String(a._id))?.score ?? -1),
    );
    const total = pool.length;
    const jobs = pool.slice(pagination.skip, pagination.skip + pagination.limit);
    const jobIds = jobs.map((job) => job._id);
    await ensureDeterministicMatches(jobIds.map(String));
    const matches = await JobMatchModel.find({ job: { $in: jobIds } }).populate(
      'profile',
      'label kind',
    );
    return res.json(
      paginated(
        buildJobList(jobs, matches, maxAgeMonths),
        total,
        pagination,
      ),
    );
  }

  const [jobs, total] = await Promise.all([
    JobModel.find(filter).sort(jobSort).skip(pagination.skip).limit(pagination.limit),
    JobModel.countDocuments(filter),
  ]);

  const jobIds = jobs.map((job) => job._id);
  await ensureDeterministicMatches(jobIds.map(String));
  const matchFilter: Record<string, unknown> = { job: { $in: jobIds } };
  if (query.profileKind) matchFilter.profileKind = query.profileKind;
  const matches = await JobMatchModel.find(matchFilter).populate('profile', 'label kind');

  res.json(
    paginated(
      buildJobList(jobs, matches, maxAgeMonths),
      total,
      pagination,
    ),
  );
});

jobsRouter.get('/:id', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const job = await JobModel.findById(id);
  if (!job) throw notFound('Job');
  await ensureDeterministicMatches([String(job._id)]);
  const matches = await JobMatchModel.find({ job: job._id })
    .sort({ score: -1 })
    .populate('profile', 'label kind status');
  const settings = await getSettings();
  const age = assessJobAge({
    postedAt: job.postedAt,
    postedLocalDate: job.postedLocalDate,
    expiresAt: job.expiresAt,
    status: job.status,
    months: effectiveMaxAgeMonths(settings.search.maxAgeMonths),
  });
  const data = serialize<Record<string, unknown>>(job);
  data.ageEligibility = age.ageEligibility;
  data.eligibleAfter = age.eligibleAfter;
  data.ageCheckAt = age.ageCheckAt;
  data.ageReason = age.ageReason;
  res.json({
    job: data,
    matches: matches.map((match) => serialize(match)),
  });
});

const jobStateSchema = z.object({
  saved: z.boolean().optional(),
  reviewed: z.boolean().optional(),
});

const jobLetterSchema = z.object({
  profileId: objectIdSchema.optional(),
  referenceProfileId: objectIdSchema.optional(),
  instructions: z.string().max(2_000).optional(),
});

const letterPreferenceSchema = z.object({
  cvProfileId: objectIdSchema.optional(),
  referenceProfileId: objectIdSchema.optional(),
});

jobsRouter.get('/:id/cover-letter/options', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  res.json(await getJobLetterOptions(id));
});

jobsRouter.patch('/:id/letter-preferences', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const body = letterPreferenceSchema.parse(req.body ?? {});
  res.json(await setJobLetterPreferences({ jobId: id, ...body }));
});

jobsRouter.post('/:id/cover-letter', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const body = jobLetterSchema.parse(req.body ?? {});
  const letter = await generateJobLetter({ jobId: id, ...body });
  res.status(201).json({ letter: serialize(letter) });
});

jobsRouter.get('/:id/cover-letters', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const query = z.object({ profileId: objectIdSchema.optional() }).parse(req.query);
  res.json((await listJobLetters(id, query.profileId)).map((letter) => serialize(letter)));
});

jobsRouter.patch('/:id/cover-letters/:letterId', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const letterId = objectIdSchema.parse(req.params.letterId);
  const body = z.object({ letterText: z.string().min(1).max(8_000) }).parse(req.body ?? {});
  const letter = await editJobLetter({ jobId: id, letterId, letterText: body.letterText });
  res.json({ letter: serialize(letter) });
});

jobsRouter.get('/:id/cover-letters/:letterId/download', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const letterId = objectIdSchema.parse(req.params.letterId);
  const query = z.object({ format: z.enum(['pdf', 'docx']).default('pdf') }).parse(req.query);
  const { letter, job, profile } = await jobLetterDownload({ jobId: id, letterId });
  const content = {
    subjectLine: letter.subjectLine,
    letterText: letter.letterText,
    candidateName: profile?.name ?? '',
  };
  const safeName = `${(job.employer || 'employer').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-cover-letter`;
  if (query.format === 'docx') {
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.docx"`);
    res.send(await renderLetterDocx(content));
    return;
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
  res.send(await renderLetterPdf(content));
});

/** Personal dashboard state: save/unsave and mark reviewed. */
jobsRouter.patch('/:id/state', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const body = jobStateSchema.parse(req.body ?? {});
  const update: Record<string, unknown> = {};
  if (body.saved !== undefined) update.saved = body.saved;
  if (body.reviewed !== undefined) update.reviewedAt = body.reviewed ? new Date() : null;
  const job = await JobModel.findByIdAndUpdate(id, { $set: update }, { new: true });
  if (!job) throw notFound('Job');
  res.json({ job: serialize(job) });
});

const chatMessageSchema = z.object({
  content: z.string().min(1).max(4_000),
  sessionId: objectIdSchema.optional(),
});

jobsRouter.get('/:id/chat', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const job = await JobModel.findById(id);
  if (!job) throw notFound('Job');
  const session = await getLatestChatSession({ type: 'job', job });
  res.json({ session: session ? serialize(session) : null });
});

jobsRouter.post('/:id/chat', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const job = await JobModel.findById(id);
  if (!job) throw notFound('Job');
  const session = await createChatSession({ type: 'job', job });
  res.status(201).json({ session: serialize(session) });
});

jobsRouter.delete('/:id/chat', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const job = await JobModel.findById(id);
  if (!job) throw notFound('Job');
  const deleted = await clearChatSessions({ type: 'job', job });
  res.json({ deleted });
});

jobsRouter.post('/:id/chat/messages', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const job = await JobModel.findById(id);
  if (!job) throw notFound('Job');
  const body = chatMessageSchema.parse(req.body ?? {});
  const result = await sendChatMessage({
    target: { type: 'job', job },
    content: body.content,
    sessionId: body.sessionId,
  });
  res.status(201).json({
    session: serialize(result.session),
    reply: result.reply,
    model: result.model,
    sources: result.sources,
  });
});

jobsRouter.post('/:id/age-check', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const job = await JobModel.findById(id);
  if (!job) throw notFound('Job');
  const settings = await getSettings();
  const assessment = assessJobAge({
    postedAt: job.postedAt,
    postedLocalDate: job.postedLocalDate,
    expiresAt: job.expiresAt,
    status: job.status,
    months: effectiveMaxAgeMonths(settings.search.maxAgeMonths),
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
