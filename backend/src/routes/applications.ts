import { Router } from 'express';
import { z } from 'zod';
import {
  approveApplicationSchema,
  answerSchema,
  coverLetterEditSchema,
  objectIdSchema,
  prepareApplicationSchema,
  profileKindSchema,
  regenCoverLetterSchema,
  submitApplicationSchema,
} from '../schemas.js';
import { ApplicationModel } from '../models/Application.js';
import { CoverLetterModel } from '../models/CoverLetter.js';
import { CandidateProfileModel } from '../models/CandidateProfile.js';
import {
  answerQuestion,
  applicationsToCsv,
  approveApplication,
  cancelApplication,
  confirmManualSubmission,
  editCoverLetter,
  getApplicationById,
  getApplicationDetail,
  listApplications,
  prepareApplication,
  regenerateCoverLetter,
  submitApplication,
} from '../services/applications/service.js';
import { renderLetterDocx, renderLetterPdf } from '../services/coverLetters/render.js';
import { parsePagination, paginationSchema, paginated } from '../utils/pagination.js';
import { badRequest, conflict, notFound } from '../utils/errors.js';
import { serialize } from '../utils/serialize.js';

export const applicationsRouter = Router();

const listQuery = paginationSchema.extend({
  status: z
    .enum([
      'DISCOVERED',
      'MATCHED',
      'READY_FOR_REVIEW',
      'APPROVED',
      'SUBMITTING',
      'SUBMITTED',
      'FAILED',
      'NEEDS_MANUAL_ACTION',
      'WITHDRAWN',
    ])
    .optional(),
  profileId: objectIdSchema.optional(),
  profileKind: profileKindSchema.optional(),
  employer: z.string().max(160).optional(),
  from: z.string().max(30).optional(),
  to: z.string().max(30).optional(),
});

applicationsRouter.post('/prepare', async (req, res) => {
  const body = prepareApplicationSchema.parse(req.body);
  const result = await prepareApplication(body);
  const detail = await getApplicationDetail(String(result.application._id));
  res.status(result.created ? 201 : 200).json({
    application: serialize(detail),
    created: result.created,
    warnings: result.warnings,
  });
});

applicationsRouter.get('/export.csv', async (req, res) => {
  const query = listQuery.parse(req.query);
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.employer) filter.employer = { $regex: query.employer, $options: 'i' };
  if (query.profileId) filter.profile = query.profileId;
  if (query.profileKind) {
    const profiles = await CandidateProfileModel.find({ kind: query.profileKind }).select('_id');
    filter.profile = { $in: profiles.map((profile) => profile._id) };
  }
  const items = await ApplicationModel.find(filter).sort({ createdAt: -1 }).limit(2000).lean();
  const csv = applicationsToCsv(items as never);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="applications-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

applicationsRouter.get('/', async (req, res) => {
  const query = listQuery.parse(req.query);
  const pagination = parsePagination(query);

  if (query.profileKind) {
    const profiles = await CandidateProfileModel.find({ kind: query.profileKind }).select('_id');
    const profileId = profiles[0]?._id;
    if (!profileId) {
      res.json(paginated([], 0, pagination));
      return;
    }
    const { items, total } = await listApplications({ ...query, profileId: String(profileId), ...pagination });
    res.json(paginated(items.map((item) => serialize(item)), total, pagination));
    return;
  }

  const { items, total } = await listApplications({ ...query, ...pagination });
  res.json(paginated(items.map((item) => serialize(item)), total, pagination));
});

applicationsRouter.get('/:id', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const application = await getApplicationDetail(id);
  res.json(serialize(application));
});

applicationsRouter.post('/:id/approve', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const body = approveApplicationSchema.parse(req.body);
  const application = await approveApplication(id, body);
  res.json(serialize(application));
});

applicationsRouter.post('/:id/submit', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  submitApplicationSchema.parse(req.body ?? {});
  const application = await submitApplication(id);
  const detail = await getApplicationDetail(id);
  res.json(serialize(detail));
});

applicationsRouter.post('/:id/cancel', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const body = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});
  const application = await cancelApplication(id, body.reason);
  res.json(serialize(application));
});

applicationsRouter.post('/:id/confirm-manual', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const body = z
    .object({ confirmed: z.literal(true), note: z.string().max(1000).optional() })
    .parse(req.body ?? {});
  const application = await confirmManualSubmission(id, body);
  res.json(serialize(application));
});

applicationsRouter.patch('/:id/cover-letter', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const body = coverLetterEditSchema.parse(req.body);
  const result = await editCoverLetter(id, body);
  res.json({ application: serialize(result.application), letter: serialize(result.letter) });
});

applicationsRouter.post('/:id/cover-letter/regenerate', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const body = regenCoverLetterSchema.parse(req.body ?? {});
  const result = await regenerateCoverLetter(id, body.instructions);
  res.json({ application: serialize(result.application), letter: serialize(result.letter) });
});

applicationsRouter.post('/:id/questions/answer', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const body = answerSchema.parse(req.body);
  const application = await answerQuestion(id, body);
  res.json(serialize(application));
});

applicationsRouter.get('/:id/cover-letter/download', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const query = z
    .object({
      format: z.enum(['pdf', 'docx']).default('pdf'),
      version: z.coerce.number().int().min(1).optional(),
    })
    .parse(req.query);

  const application = await getApplicationById(id);
  const letter = query.version
    ? await CoverLetterModel.findOne({ application: application._id, version: query.version })
    : await CoverLetterModel.findById(application.currentLetter);
  if (!letter) throw notFound('Cover letter');

  if (letter.source === 'template') {
    // Templates are allowed to download, but the caller should know what it is.
    res.setHeader('X-Cover-Letter-Source', letter.source);
  }

  const profile = await CandidateProfileModel.findById(application.profile);
  const content = {
    subjectLine: letter.subjectLine,
    letterText: letter.letterText,
    candidateName: profile?.name ?? '',
  };
  const safeName = `${(application.employer || 'employer').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-cover-letter`;

  if (query.format === 'docx') {
    const buffer = await renderLetterDocx(content);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.docx"`);
    res.send(buffer);
    return;
  }

  const buffer = await renderLetterPdf(content);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
  res.send(buffer);
});

applicationsRouter.get('/:id/cover-letter/versions', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  await getApplicationById(id);
  const versions = await CoverLetterModel.find({ application: id }).sort({ version: -1 });
  res.json(versions.map((version) => serialize(version)));
});

applicationsRouter.post('/:id/reprepare', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const application = await getApplicationById(id);
  if (!['FAILED', 'WITHDRAWN', 'NEEDS_MANUAL_ACTION'].includes(application.status)) {
    throw conflict('Only failed, withdrawn or manual-action applications can be re-prepared.');
  }
  const result = await prepareApplication({
    jobId: String(application.job),
    profileId: String(application.profile),
  });
  res.status(201).json({ application: serialize(result.application), warnings: result.warnings });
});

