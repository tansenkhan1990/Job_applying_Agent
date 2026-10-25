import { Router } from 'express';
import { z } from 'zod';
import { availableModels, aiStatus, testAiConnection } from '../services/ai/status.js';

export const aiRouter = Router();

aiRouter.get('/status', async (_req, res) => {
  res.json(await aiStatus());
});

aiRouter.get('/models', async (req, res) => {
  const force = req.query.force === 'true';
  res.json(await availableModels(force));
});

aiRouter.post('/test', async (req, res) => {
  const body = z.object({ model: z.string().max(200).optional() }).parse(req.body ?? {});
  res.json(await testAiConnection(body));
});
