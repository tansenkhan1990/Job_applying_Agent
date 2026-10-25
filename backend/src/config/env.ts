import fs from 'node:fs';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

// Support running from backend/ (dev) or /app (container), with the repo .env as fallback.
loadEnv({
  path: [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../.env')],
  quiet: true,
});

const boolFromEnv = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return fallback;
      return value === 'true' || value === '1' || value === 'yes';
    });

const intFromEnv = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value) => {
      const parsed = Number.parseInt(value ?? '', 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    })
    .pipe(z.number().int().min(min).max(max));

function defaultDocumentsPath(): string {
  if (process.env.DOCUMENTS_PATH) return process.env.DOCUMENTS_PATH;
  const local = path.resolve(process.cwd(), 'documents');
  if (fs.existsSync(local)) return local;
  return path.resolve(process.cwd(), '../documents');
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/job_agent'),

  OPENROUTER_API_KEY: z.string().default(''),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_MODEL: z.string().default(''),
  OPENROUTER_HTTP_REFERER: z.string().default('http://localhost:5173'),
  OPENROUTER_APP_TITLE: z.string().default('Personal Job Agent'),

  AI_TIMEOUT_MS: intFromEnv(90_000, 5_000, 300_000),
  AI_MAX_RETRIES: intFromEnv(3, 0, 6),
  AI_MAX_OUTPUT_TOKENS: intFromEnv(2_000, 256, 8_000),
  AI_MAX_INPUT_CHARS: intFromEnv(24_000, 2_000, 120_000),

  DOCUMENTS_PATH: z.string().default(defaultDocumentsPath()),
  MAX_DOCUMENT_SIZE_MB: intFromEnv(10, 1, 50),

  APPROVAL_REQUIRED: boolFromEnv(true),
  // Shared secret used only by the local host browser runner. Empty disables the runner API.
  BROWSER_RUNNER_TOKEN: z.string().default(''),
  FRONTEND_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SCHEDULER_ENABLED: boolFromEnv(false),
  ENABLE_MOCK_SOURCE: boolFromEnv(true),
  ALLOW_MOCK_SUBMISSION: boolFromEnv(false),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Never print the raw environment; only the invalid variable names.
  const fields = Object.keys(parsed.error.flatten().fieldErrors).join(', ');
  throw new Error(`Invalid environment configuration: ${fields}`);
}

const raw = parsed.data;

export const env = {
  ...raw,
  isTest: raw.NODE_ENV === 'test',
  frontendOrigins: raw.FRONTEND_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  documentsPath: path.resolve(raw.DOCUMENTS_PATH),
  maxDocumentSizeBytes: raw.MAX_DOCUMENT_SIZE_MB * 1024 * 1024,
  aiConfigured: raw.OPENROUTER_API_KEY.trim().length > 0,
};

export type Env = typeof env;
