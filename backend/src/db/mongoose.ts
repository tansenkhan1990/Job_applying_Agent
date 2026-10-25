import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/async.js';

mongoose.set('strictQuery', true);

export async function connectDb(uri = env.MONGODB_URI, attempts = 10): Promise<void> {
  mongoose.set('bufferCommands', false);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 5_000,
        connectTimeoutMS: 10_000,
        maxPoolSize: 10,
      });
      logger.info({ attempt }, 'Connected to MongoDB');
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      logger.warn({ attempt, attempts, error: message }, 'MongoDB connection failed');
      if (attempt === attempts) throw error;
      await sleep(Math.min(2_000 * attempt, 10_000));
    }
  }
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

export function dbReady(): boolean {
  return mongoose.connection.readyState === 1;
}

export async function pingDb(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    if (!mongoose.connection.db) throw new Error('No MongoDB connection');
    await mongoose.connection.db.admin().ping();
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'unknown error',
    };
  }
}

export async function withTransaction<T>(fn: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
