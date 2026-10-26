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

export async function pingDb(
  timeoutMs = 2_000,
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    // Do not wait for the driver's server-selection timeout: a health check must answer
    // quickly even when MongoDB is unreachable, so the container is marked unhealthy and
    // the dashboard can show the degraded state instead of hanging.
    if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
      throw new Error('MongoDB is not connected');
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('MongoDB ping timed out')), timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([mongoose.connection.db.admin().ping(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
