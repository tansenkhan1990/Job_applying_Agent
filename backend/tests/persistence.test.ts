import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { describe, expect, it } from 'vitest';
import { ApplicationModel } from '../src/models/Application.js';

/**
 * Docker Compose mounts a named volume at /data/db. This test exercises the same property
 * without Docker: an application record written before the database process stops is still
 * there after a new process starts on the same data directory.
 */
describe('application history durability', () => {
  it('survives a database restart on the same data directory', async () => {
    const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'job-agent-db-'));
    const dbName = 'restart_test';

    let mongod = await MongoMemoryServer.create({
      instance: { dbPath, storageEngine: 'wiredTiger' },
    });
    const first = mongoose.createConnection(mongod.getUri(dbName));
    await first.asPromise();
    const FirstApplication = first.model('Application', ApplicationModel.schema);

    const created = await FirstApplication.create({
      job: new mongoose.Types.ObjectId(),
      profile: new mongoose.Types.ObjectId(),
      employer: 'Example GmbH',
      jobTitle: 'Senior Full Stack Engineer',
      jobUrl: 'https://example.com/jobs/42',
      postedAt: new Date('2026-06-01T00:00:00.000Z'),
      ageEligibility: 'Eligible',
      status: 'SUBMITTED',
      appliedAt: new Date('2026-10-24T09:00:00.000Z'),
      idempotencyKey: 'restart-test-key',
      statusHistory: [
        {
          from: 'APPROVED',
          to: 'SUBMITTED',
          at: new Date('2026-10-24T09:00:00.000Z'),
          reason: 'User confirmed the employer receipt page',
          source: 'user',
          reference: 'confirmation-101',
        },
      ],
      workflow: {
        status: 'SUBMITTED',
        confirmation: {
          confirmedAt: new Date('2026-10-24T09:00:00.000Z'),
          method: 'manual',
          evidence: 'Receipt page',
          confirmationId: '101',
        },
      },
    });

    await first.close();
    await mongod.stop();

    mongod = await MongoMemoryServer.create({
      instance: { dbPath, storageEngine: 'wiredTiger' },
    });
    const second = mongoose.createConnection(mongod.getUri(dbName));
    await second.asPromise();
    const SecondApplication = second.model('Application', ApplicationModel.schema);

    const restored = await SecondApplication.findById(created._id).lean();
    expect(restored?.jobTitle).toBe('Senior Full Stack Engineer');
    expect(restored?.status).toBe('SUBMITTED');
    expect(restored?.appliedAt?.toISOString()).toBe('2026-10-24T09:00:00.000Z');
    expect(restored?.statusHistory).toHaveLength(1);
    expect(restored?.statusHistory[0]?.at?.toISOString()).toBe('2026-10-24T09:00:00.000Z');
    expect(restored?.idempotencyKey).toBe('restart-test-key');

    await second.close();
    await mongod.stop();
  }, 60_000);
});
