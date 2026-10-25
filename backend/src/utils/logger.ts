import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Structured logs. CV text, job descriptions, prompts, application answers and
 * API keys are redacted. Callers log identifiers and counts, never full documents.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'job-agent-backend' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.text',
      '*.description',
      '*.cvText',
      '*.coverLetterText',
      '*.letterText',
      '*.apiKey',
      '*.answer',
      '*.answers',
      '*.password',
      '*.token',
      'apiKey',
      'OPENROUTER_API_KEY',
    ],
    censor: '[redacted]',
  },
});
