import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { apiRouter } from './routes/index.js';
import { apiNotFound, errorHandler } from './middleware/errorHandler.js';
import { AppError } from './utils/errors.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.use(
    helmet({
      crossOriginResourcePolicy: false,
      contentSecurityPolicy: false,
    }),
  );
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || env.frontendOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new AppError(403, 'FORBIDDEN', `Origin not allowed by CORS: ${origin}`));
      },
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const existing = req.headers['x-request-id'];
        const id = typeof existing === 'string' && existing.length <= 100 ? existing : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: {
        ignore: (req) => req.url === '/api/health',
      },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  const limiter = rateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: (req) => req.path === '/health',
    message: {
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down and try again.' },
    },
  });

  app.use('/api', limiter);
  app.use('/api', (req, _res, next) => {
    // Reduce accidental exposure if this is ever bound beyond localhost.
    if (env.NODE_ENV === 'production' && req.hostname && !['localhost', '127.0.0.1', 'backend'].includes(req.hostname)) {
      logger.debug({ host: req.hostname }, 'Request received on a non-local hostname');
    }
    next();
  });

  app.use('/api', apiRouter);
  app.use('/api', apiNotFound);
  app.use(errorHandler);

  return app;
}
