import { Router } from 'express';
import { healthRouter } from './health.js';
import { settingsRouter } from './settings.js';
import { aiRouter } from './ai.js';
import { profilesRouter } from './profiles.js';
import { documentsRouter } from './documents.js';
import { jobsRouter } from './jobs.js';
import { matchesRouter } from './matches.js';
import { applicationsRouter } from './applications.js';
import { searchRunsRouter } from './searchRuns.js';
import { dashboardRouter } from './dashboard.js';
import { automationRouter } from './automation.js';

export const apiRouter = Router();

apiRouter.use('/health', healthRouter);
apiRouter.use('/settings', settingsRouter);
apiRouter.use('/ai', aiRouter);
apiRouter.use('/profiles', profilesRouter);
apiRouter.use('/documents', documentsRouter);
apiRouter.use('/jobs', jobsRouter);
apiRouter.use('/matches', matchesRouter);
apiRouter.use('/applications', applicationsRouter);
apiRouter.use('/search-runs', searchRunsRouter);
apiRouter.use('/dashboard', dashboardRouter);
apiRouter.use('/automation', automationRouter);
