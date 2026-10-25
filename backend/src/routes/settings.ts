import { Router } from 'express';
import { settingsPatchSchema } from '../schemas.js';
import { getSettings, updateSettings } from '../services/settingsService.js';
import { sourceStatuses } from '../services/jobs/adapters/index.js';
import { aiStatus } from '../services/ai/status.js';
import { serialize } from '../utils/serialize.js';

export const settingsRouter = Router();

settingsRouter.get('/', async (_req, res) => {
  const [settings, sources, ai] = await Promise.all([getSettings(), sourceStatuses(), aiStatus()]);
  res.json({ settings, sources, ai });
});

settingsRouter.patch('/', async (req, res) => {
  const patch = settingsPatchSchema.parse(req.body);
  const settings = await updateSettings(patch);
  const [sources, ai] = await Promise.all([sourceStatuses(), aiStatus()]);
  res.json({ settings: serialize(settings), sources, ai });
});
