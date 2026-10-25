import { Router } from 'express';
import { dashboardSummary } from '../services/applications/service.js';
import { serializeList } from '../utils/serialize.js';

export const dashboardRouter = Router();

dashboardRouter.get('/summary', async (_req, res) => {
  const summary = await dashboardSummary();
  // Lean documents still contain _id/__v; expose the same `id` shape as every other API.
  res.json({
    ...summary,
    topMatches: serializeList(summary.topMatches),
    recentRuns: serializeList(summary.recentRuns),
  });
});
