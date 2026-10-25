import fs from 'node:fs/promises';
import { Router } from 'express';
import { env } from '../config/env.js';
import { pingDb } from '../db/mongoose.js';
import { getSettings } from '../services/settingsService.js';
import { adapters } from '../services/jobs/adapters/index.js';

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

  let schedulerEnabled = false;
  try {
    const settings = await getSettings();
    schedulerEnabled = settings.schedule.enabled;
  } catch {
    schedulerEnabled = false;
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
      ai: { configured: env.aiConfigured, model: (await getSettings().catch(() => null))?.ai.model ?? '' },
      scheduler: { enabled: schedulerEnabled },
      sources: adapters.map((adapter) => ({ id: adapter.id, configured: adapter.isConfigured() })),
    },
  });
});
