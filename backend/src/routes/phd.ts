import { Router } from 'express';
import { z } from 'zod';
import { PhdPositionModel } from '../models/PhdPosition.js';
import { PhdMatchModel } from '../models/PhdMatch.js';
import { CoverLetterModel } from '../models/CoverLetter.js';
import { objectIdSchema, profileKindSchema } from '../schemas.js';
import { paginationSchema, parsePagination, paginated } from '../utils/pagination.js';
import { serialize } from '../utils/serialize.js';
import { notFound } from '../utils/errors.js';
import { runPhdDiscovery } from '../services/phd/discovery.js';
import { phdAdapters, phdSourceStatuses } from '../services/phd/adapters/index.js';
import { ensureDeterministicPhdMatches, matchPhdPosition } from '../services/phd/matching.js';
import { assessPhdDeadline, PHD_TARGET_RESEARCH_AREAS } from '../services/phd/metadata.js';
import { startOfUtcDay } from '../services/jobs/age.js';
import { getSettings } from '../services/settingsService.js';
import {
  editPhdLetter,
  generatePhdLetter,
  getPhdLetterOptions,
  listPhdLetters,
  phdLetterDownload,
  setPhdLetterPreferences,
} from '../services/phd/letters.js';
import { renderLetterDocx, renderLetterPdf } from '../services/coverLetters/render.js';
import {
  clearChatSessions,
  createChatSession,
  getLatestChatSession,
  sendChatMessage,
} from '../services/ai/chat.js';

export const phdRouter = Router();

const listQuery = paginationSchema.extend({
  q: z.string().max(200).optional(),
  country: z.string().max(80).optional(),
  languageDecision: z.enum(['Eligible', 'Excluded', 'Needs Review']).optional(),
  status: z.enum(['active', 'expired', 'closed', 'duplicate']).optional(),
  saved: z.enum(['true', 'false']).optional(),
  reviewed: z.enum(['true', 'false']).optional(),
  hasCoverLetter: z.enum(['true', 'false']).optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  maxScore: z.coerce.number().min(0).max(100).optional(),
  profileKind: profileKindSchema.optional(),
  topic: z.string().max(120).optional(),
  researchArea: z.enum(['ai', 'cybersecurity', 'software_engineering', 'data', 'other']).optional(),
  institution: z.string().max(160).optional(),
  deadlineStatus: z.enum(['open', 'expired', 'unknown', 'closed']).optional(),
  // Results are fully funded only. "false" exposes advertisements without funding evidence so
  // they can be reviewed, and is never the default.
  funded: z.enum(['true', 'false']).optional(),
  deadlineWithinDays: z.coerce.number().int().min(1).max(365).optional(),
  sort: z.enum(['newest', 'oldest', 'score', 'deadline', 'institution', 'title']).default('newest'),
});

function buildItems(
  positions: Array<{
    _id: unknown;
    description?: string | null;
    applicationDeadline?: Date | null;
    deadlineTimezone?: string | null;
    deadlineHasTime?: boolean | null;
    rollingAdmissions?: boolean | null;
    status?: string | null;
  }>,
  matches: unknown[],
) {
  const best = new Map<string, { score?: number }>();
  for (const match of matches) {
    const { position, score } = match as { position?: unknown; score?: number };
    const key = String(position);
    const current = best.get(key);
    if (!current || (score ?? 0) > (current.score ?? 0)) best.set(key, match as { score?: number });
  }
  return positions.map((position) => {
    const data = serialize<Record<string, unknown>>(position);
    delete data.description;
    // Deadline status can change after discovery, so display the current assessment instead of
    // the value stored at the last source fetch.
    const deadline = assessPhdDeadline({
      deadline: position.applicationDeadline ?? null,
      timezone: position.deadlineTimezone,
      hasTime: position.deadlineHasTime ?? false,
      closed: position.status === 'closed',
      rolling: position.rollingAdmissions ?? false,
    });
    return {
      ...data,
      deadlineStatus: deadline.status,
      deadlineNote: deadline.note,
      descriptionPreview: (position.description ?? '').slice(0, 320),
      bestMatch: best.get(String(position._id)) ? serialize(best.get(String(position._id))) : null,
    };
  });
}

phdRouter.post('/search', async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  res.status(201).json(await runPhdDiscovery({ trigger: 'manual' }));
});

phdRouter.get('/sources', async (_req, res) => {
  res.json(await phdSourceStatuses());
});

phdRouter.get('/positions', async (req, res) => {
  const query = listQuery.parse(req.query);
  const pagination = parsePagination(query);
  const settings = await getSettings();
  const filter: Record<string, unknown> = {};
  const now = new Date();
  const todayStart = startOfUtcDay(now);
  if (query.country) filter.country = { $regex: query.country, $options: 'i' };
  if (query.languageDecision) {
    filter.languageDecision = query.languageDecision;
  } else if (settings.phd.excludeGermanRequired) {
    // English-first default: German-mandatory advertisements are hidden unless the caller
    // explicitly asks for them. Unclear language requirements stay, flagged for review.
    filter.languageDecision = { $ne: 'Excluded' };
  }
  // Only positions whose advertisement explicitly evidences funding are listed by default.
  filter.fundingStatus = query.funded === 'false' ? { $ne: 'funded' } : 'funded';
  if (query.researchArea) filter.researchArea = query.researchArea;
  else filter.researchArea = { $in: [...PHD_TARGET_RESEARCH_AREAS] };
  if (query.institution) {
    filter.institution = { $regex: query.institution, $options: 'i' };
  }
  if (query.status) filter.status = query.status;

  // Active opportunities are deadline-verified by default. Unknown deadlines live in their own
  // review group and are never silently presented as open. Expired and closed positions can be
  // inspected explicitly but are excluded from normal results.
  const deadlineFilter =
    query.deadlineStatus ?? (query.status && query.status !== 'active' ? undefined : 'open');
  if (deadlineFilter === 'open') {
    if (!query.status) filter.status = 'active';
    filter.$and = [
      ...((filter.$and as unknown[]) ?? []),
      {
        $or: [
          {
            $and: [{ deadlineHasTime: true }, { applicationDeadline: { $gte: now } }],
          },
          {
            $and: [
              { deadlineHasTime: { $ne: true } },
              { applicationDeadline: { $gte: todayStart } },
            ],
          },
          // Rolling admission is open by the source's own statement and has no deadline.
          { rollingAdmissions: true, applicationDeadline: null },
        ],
      },
    ];
  } else if (deadlineFilter === 'unknown') {
    if (!query.status) filter.status = 'active';
    filter.applicationDeadline = null;
    filter.rollingAdmissions = { $ne: true };
  } else if (deadlineFilter === 'expired') {
    filter.status = 'expired';
  } else if (deadlineFilter === 'closed') {
    filter.status = 'closed';
  }
  if (query.deadlineWithinDays) {
    filter.applicationDeadline = {
      $gte: now,
      $lte: new Date(now.getTime() + query.deadlineWithinDays * 86_400_000),
    };
  }
  if (query.saved === 'true') filter.saved = true;
  if (query.reviewed === 'false') filter.reviewedAt = null;
  if (query.reviewed === 'true') filter.reviewedAt = { $ne: null };
  if (query.topic) {
    filter.$or = [
      { researchTopic: { $regex: query.topic, $options: 'i' } },
      { title: { $regex: query.topic, $options: 'i' } },
    ];
  }
  if (query.q) {
    filter.$and = [
      ...((filter.$and as unknown[]) ?? []),
      {
        $or: [
          { title: { $regex: query.q, $options: 'i' } },
          { institution: { $regex: query.q, $options: 'i' } },
          { researchTopic: { $regex: query.q, $options: 'i' } },
          { location: { $regex: query.q, $options: 'i' } },
        ],
      },
    ];
  }

  if (query.hasCoverLetter === 'true' || query.hasCoverLetter === 'false') {
    const withLetters = await CoverLetterModel.distinct('phdPosition', { letterType: 'phd' });
    const clause =
      query.hasCoverLetter === 'true' ? { $in: withLetters } : { $nin: withLetters };
    filter.$and = [...((filter.$and as unknown[]) ?? []), { _id: clause }];
  }

  if (query.minScore !== undefined || query.maxScore !== undefined || query.profileKind) {
    const matchFilter: Record<string, unknown> = {};
    if (query.minScore !== undefined) matchFilter.score = { $gte: query.minScore };
    if (query.maxScore !== undefined) {
      matchFilter.score = { ...(matchFilter.score as object), $lte: query.maxScore };
    }
    if (query.profileKind) matchFilter.profileKind = query.profileKind;
    const ids = await PhdMatchModel.find(matchFilter).distinct('position');
    filter._id = { $in: ids };
  }

  if (query.sort === 'score') {
    const pool = await PhdPositionModel.find(filter).limit(1_000);
    const poolIds = pool.map((position) => position._id);
    const poolMatches = await PhdMatchModel.find({ position: { $in: poolIds } }).populate(
      'profile',
      'label kind',
    );
    const best = new Map<string, { score?: number }>();
    for (const match of poolMatches) {
      const key = String(match.position);
      const current = best.get(key);
      if (!current || (match.score ?? 0) > (current.score ?? 0)) best.set(key, match);
    }
    pool.sort(
      (a, b) => (best.get(String(b._id))?.score ?? -1) - (best.get(String(a._id))?.score ?? -1),
    );
    const total = pool.length;
    const positions = pool.slice(pagination.skip, pagination.skip + pagination.limit);
    await ensureDeterministicPhdMatches(positions.map((position) => String(position._id)));
    const ids = new Set(positions.map((position) => String(position._id)));
    const matches = poolMatches.filter((match) => ids.has(String(match.position)));
    return res.json(paginated(buildItems(positions, matches), total, pagination));
  }

  const sort: Record<string, 1 | -1> =
    query.sort === 'oldest'
      ? { postedAt: 1, discoveredAt: 1 }
      : query.sort === 'deadline'
        ? { applicationDeadline: 1 }
        : query.sort === 'institution'
          ? { institution: 1 }
          : query.sort === 'title'
            ? { title: 1 }
            : { postedAt: -1, discoveredAt: -1 };

  const matchFilter: Record<string, unknown> = {};
  if (query.profileKind) matchFilter.profileKind = query.profileKind;

  const [positions, total] = await Promise.all([
    PhdPositionModel.find(filter).sort(sort).skip(pagination.skip).limit(pagination.limit),
    PhdPositionModel.countDocuments(filter),
  ]);
  await ensureDeterministicPhdMatches(positions.map((position) => String(position._id)));
  const matches = await PhdMatchModel.find({
    ...matchFilter,
    position: { $in: positions.map((position) => position._id) },
  }).populate('profile', 'label kind');

  res.json(paginated(buildItems(positions, matches), total, pagination));
});

phdRouter.get('/positions/:id', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const position = await PhdPositionModel.findById(id);
  if (!position) throw notFound('PhD position');
  await ensureDeterministicPhdMatches([String(position._id)]);
  const matches = await PhdMatchModel.find({ position: position._id })
    .sort({ score: -1 })
    .populate('profile', 'label kind status name');
  const data = serialize<Record<string, unknown>>(position);
  const deadline = assessPhdDeadline({
    deadline: position.applicationDeadline,
    timezone: position.deadlineTimezone,
    hasTime: position.deadlineHasTime,
    closed: position.status === 'closed',
    rolling: position.rollingAdmissions ?? false,
  });
  data.deadlineStatus = deadline.status;
  data.deadlineNote = deadline.note;
  res.json({ position: data, matches: matches.map((match) => serialize(match)) });
});

phdRouter.patch('/positions/:id/state', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const body = z
    .object({ saved: z.boolean().optional(), reviewed: z.boolean().optional() })
    .parse(req.body ?? {});
  const update: Record<string, unknown> = {};
  if (body.saved !== undefined) update.saved = body.saved;
  if (body.reviewed !== undefined) update.reviewedAt = body.reviewed ? new Date() : null;
  const position = await PhdPositionModel.findByIdAndUpdate(id, { $set: update }, { new: true });
  if (!position) throw notFound('PhD position');
  res.json({ position: serialize(position) });
});

const phdMatchSchema = z
  .object({
    profileIds: z.array(objectIdSchema).max(3).optional(),
    profileKinds: z.array(profileKindSchema).max(3).optional(),
  })
  .strict()
  .default({});

phdRouter.post('/positions/:id/verify', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const position = await PhdPositionModel.findById(id);
  if (!position) throw notFound('PhD position');

  const adapter = phdAdapters.find((item) => item.id === position.source);
  let verification: { status: 'available' | 'unavailable' | 'unknown'; evidence: string };

  if (adapter?.simulated) {
    verification = {
      status: 'unknown',
      evidence: 'This is a simulated fixture; there is no live source whose deadline can be verified.',
    };
  } else if (!adapter?.getPosition) {
    verification = {
      status: 'unknown',
      evidence: `Source "${position.source}" has no deadline verifier. Check the official link manually.`,
    };
  } else {
    try {
      const fresh = await adapter.getPosition(position.sourceJobId);
      if (!fresh) {
        // Absence from a feed can mean pagination or a source change. Never turn that into
        // an automatic "closed" verdict.
        verification = {
          status: 'unknown',
          evidence:
            'The position is no longer present in the configured feed. It was not marked closed automatically; check the official link.',
        };
      } else {
        const deadline = assessPhdDeadline({
          deadline: fresh.applicationDeadline,
          timezone: fresh.deadlineTimezone,
          hasTime: fresh.deadlineHasTime,
          closed: fresh.status === 'closed',
          rolling: fresh.rollingAdmissions,
        });
        const nextStatus =
          fresh.status === 'closed'
            ? 'closed'
            : deadline.status === 'expired'
              ? 'expired'
              : 'active';
        await PhdPositionModel.updateOne(
          { _id: position._id },
          {
            $set: {
              applicationDeadline: fresh.applicationDeadline,
              deadlineTimezone: fresh.deadlineTimezone,
              deadlineHasTime: fresh.deadlineHasTime,
              rollingAdmissions: fresh.rollingAdmissions,
              deadlineStatus: deadline.status,
              deadlineNote: deadline.note,
              lastVerifiedAt: new Date(),
              lastSeenAt: new Date(),
              status: nextStatus,
              statusNote:
                nextStatus === 'closed'
                  ? 'The official source states that the position is closed or has been filled.'
                  : nextStatus === 'expired'
                    ? deadline.note
                    : '',
            },
          },
        );
        verification = {
          status: nextStatus === 'active' ? 'available' : 'unavailable',
          evidence: deadline.note,
        };
      }
    } catch (error) {
      verification = {
        status: 'unknown',
        evidence: `Verification failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      };
    }
  }

  const updated = await PhdPositionModel.findById(position._id);
  res.json({ verification, position: serialize(updated) });
});

phdRouter.post('/positions/:id/match', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const body = phdMatchSchema.parse(req.body ?? {});
  const matches = await matchPhdPosition(id, body);
  res.json({ matches: matches.map((match) => serialize(match)) });
});

const phdLetterSchema = z
  .object({
    profileId: objectIdSchema.optional(),
    referenceProfileId: objectIdSchema.optional(),
    instructions: z.string().max(2_000).optional(),
  })
  .strict();

phdRouter.get('/positions/:id/cover-letter/options', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  res.json(await getPhdLetterOptions(id));
});

phdRouter.patch('/positions/:id/letter-preferences', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const body = z
    .object({ cvProfileId: objectIdSchema.optional(), referenceProfileId: objectIdSchema.optional() })
    .strict()
    .parse(req.body ?? {});
  res.json(await setPhdLetterPreferences({ positionId: id, ...body }));
});

const phdChatMessageSchema = z.object({
  content: z.string().min(1).max(4_000),
  sessionId: objectIdSchema.optional(),
});

phdRouter.get('/positions/:id/chat', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const position = await PhdPositionModel.findById(id);
  if (!position) throw notFound('PhD position');
  const session = await getLatestChatSession({ type: 'phd', position });
  res.json({ session: session ? serialize(session) : null });
});

phdRouter.post('/positions/:id/chat', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const position = await PhdPositionModel.findById(id);
  if (!position) throw notFound('PhD position');
  const session = await createChatSession({ type: 'phd', position });
  res.status(201).json({ session: serialize(session) });
});

phdRouter.delete('/positions/:id/chat', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const position = await PhdPositionModel.findById(id);
  if (!position) throw notFound('PhD position');
  const deleted = await clearChatSessions({ type: 'phd', position });
  res.json({ deleted });
});

phdRouter.post('/positions/:id/chat/messages', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const position = await PhdPositionModel.findById(id);
  if (!position) throw notFound('PhD position');
  const body = phdChatMessageSchema.parse(req.body ?? {});
  const result = await sendChatMessage({
    target: { type: 'phd', position },
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

phdRouter.post('/positions/:id/cover-letter', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const body = phdLetterSchema.parse(req.body ?? {});
  const letter = await generatePhdLetter({ positionId: id, ...body });
  res.status(201).json({ letter: serialize(letter) });
});

phdRouter.get('/positions/:id/cover-letters', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const query = z.object({ profileId: objectIdSchema.optional() }).parse(req.query);
  res.json((await listPhdLetters(id, query.profileId)).map((letter) => serialize(letter)));
});

phdRouter.patch('/positions/:id/cover-letters/:letterId', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const letterId = objectIdSchema.parse(req.params.letterId);
  const body = z.object({ letterText: z.string().min(1).max(8_000) }).parse(req.body ?? {});
  const letter = await editPhdLetter({ positionId: id, letterId, letterText: body.letterText });
  res.json({ letter: serialize(letter) });
});

phdRouter.get('/positions/:id/cover-letters/:letterId/download', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const letterId = objectIdSchema.parse(req.params.letterId);
  const query = z.object({ format: z.enum(['pdf', 'docx']).default('pdf') }).parse(req.query);
  const { letter, position, profile } = await phdLetterDownload({ positionId: id, letterId });
  const content = {
    subjectLine: letter.subjectLine,
    letterText: letter.letterText,
    candidateName: profile?.name ?? '',
  };
  const safeName = `${(position.institution || 'institution')
    .replace(/[^a-z0-9]+/gi, '-')
    .toLowerCase()}-phd-cover-letter`;

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
