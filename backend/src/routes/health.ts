import fs from 'node:fs/promises';
import { Router } from 'express';
import { env } from '../config/env.js';
import { pingDb } from '../db/mongoose.js';
import { getSettings } from '../services/settingsService.js';
import { adapters } from '../services/jobs/adapters/index.js';
import { withTimeout } from '../utils/async.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  const db = await pingDb();
  let documentsReadable = false;
  try {
    await fs.access(env.documentsPath, fs.constants.R_OK);
    documentsReadable = true;
  } catch {
    documentsReadable = false;
  }

  // Only read persisted settings when the database answered. Otherwise a health probe would
  // wait for the driver's server-selection timeout twice and hang instead of returning 503.
  let settings: Awaited<ReturnType<typeof getSettings>> | null = null;
  if (db.ok) {
    try {
      settings = await withTimeout(getSettings(), 2_000, 'Settings lookup timed out');
    } catch {
      settings = null;
    }
  }

  const healthy = db.ok;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    service: 'job-agent-backend',
    version: '1.0.0',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    checks: {
      mongodb: db,
      documents: { pathConfigured: Boolean(env.documentsPath), readable: documentsReadable },
      ai: { configured: env.aiConfigured, model: settings?.ai.model ?? '' },
      scheduler: { enabled: settings?.schedule.enabled ?? false },
      sources: adapters.map((adapter) => ({ id: adapter.id, configured: adapter.isConfigured() })),
    },
  });
});
