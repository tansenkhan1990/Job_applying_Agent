import { Router } from 'express';
import { dashboardSummary } from '../services/applications/service.js';

export const dashboardRouter = Router();

dashboardRouter.get('/summary', async (_req, res) => {
  res.json(await dashboardSummary());
});
