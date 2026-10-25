import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { objectIdSchema, assistantProgressSchema, runnerHeartbeatSchema } from '../schemas.js';
import {
  claimNextSession,
  getAssistantControl,
  readCoverLetterFile,
  readCvFile,
  recordProgress,
  runnerHeartbeat,
} from '../services/automation/assistant.js';
import { AppError } from '../utils/errors.js';

export const automationRouter = Router();

function timingSafeEqualText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return result === 0;
}

/**
 * Only the local host runner may call these endpoints. The runner never receives the
 * OpenRouter key and the token is not exposed to the React app.
 */
const requireRunner: RequestHandler = (req, _res, next) => {
  if (!env.BROWSER_RUNNER_TOKEN.trim()) {
    next(
      new AppError(
        503,
        'RUNNER_DISABLED',
        'The browser runner API is disabled. Set BROWSER_RUNNER_TOKEN in .env and restart the backend.',
      ),
    );
    return;
  }
  const header = req.header('x-runner-token') ?? '';
  const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!timingSafeEqualText(header, env.BROWSER_RUNNER_TOKEN) && !timingSafeEqualText(bearer, env.BROWSER_RUNNER_TOKEN)) {
    next(new AppError(401, 'UNAUTHORIZED', 'Invalid browser runner token.'));
    return;
  }
  next();
};

automationRouter.use(requireRunner);

function runnerIdFrom(req: { header(name: string): string | undefined }): string {
  const id = (req.header('x-runner-id') ?? '').trim();
  if (!id) throw new AppError(400, 'BAD_REQUEST', 'x-runner-id header is required.');
  return id.slice(0, 120);
}

automationRouter.post('/heartbeat', async (req, res) => {
  const body = runnerHeartbeatSchema.parse(req.body ?? {});
  res.json(await runnerHeartbeat(body));
});

automationRouter.get('/next', async (req, res) => {
  const runnerId = runnerIdFrom(req);
  const session = await claimNextSession(runnerId);
  if (!session) {
    res.status(204).end();
    return;
  }
  res.json(session);
});

automationRouter.get('/applications/:id/control', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const runnerId = runnerIdFrom(req);
  res.json(await getAssistantControl(id, runnerId));
});

automationRouter.post('/applications/:id/progress', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const body = assistantProgressSchema.parse(req.body ?? {});
  const application = await recordProgress(id, body);
  res.json({ ok: true, status: application.workflow?.status ?? '' });
});

const filesQuery = z.object({ kind: z.enum(['cv', 'cover-letter']) });

automationRouter.get('/applications/:id/files/:kind', async (req, res) => {
  const id = objectIdSchema.parse(req.params.id);
  const { kind } = filesQuery.parse(req.params);
  const file = kind === 'cv' ? await readCvFile(id) : await readCoverLetterFile(id);
  res.setHeader('Content-Type', file.contentType);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${file.filename.replace(/"/g, '')}"`,
  );
  res.send(file.data);
});
