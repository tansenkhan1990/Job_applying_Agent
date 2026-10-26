import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { describe, expect, it } from 'vitest';
import { ApplicationModel } from '../src/models/Application.js';
import { ChatSessionModel } from '../src/models/ChatSession.js';
import { CoverLetterModel } from '../src/models/CoverLetter.js';

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
    const FirstLetter = first.model('CoverLetter', CoverLetterModel.schema);
    const FirstChat = first.model('ChatSession', ChatSessionModel.schema);

    const jobId = new mongoose.Types.ObjectId();
    const profileId = new mongoose.Types.ObjectId();

    const created = await FirstApplication.create({
      job: jobId,
      profile: profileId,
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

    const letter = await FirstLetter.create({
      job: jobId,
      letterType: 'job',
      profile: profileId,
      referenceProfile: profileId,
      version: 1,
      subjectLine: 'Application for Senior Full Stack Engineer',
      letterText: 'Dear Hiring Manager,\n\nI am applying for the role.',
      generatedText: 'Dear Hiring Manager,\n\nI am applying for the role.',
      editedByUser: true,
      contentHash: 'letter-content-hash',
      source: 'edited',
      model: 'deterministic-template',
      jobContentHash: 'job-snapshot-hash',
      selectionRationale: 'Selected the full-stack CV and its existing letter.',
    });

    const chat = await FirstChat.create({
      targetType: 'job',
      job: jobId,
      title: 'Senior Full Stack Engineer',
      aiModel: 'test/chat-model',
      messages: [
        { role: 'user', content: 'Why am I a good match?', model: '', sources: [], createdAt: new Date() },
        {
          role: 'assistant',
          content: 'Your TypeScript work is evidenced in the selected CV.',
          model: 'test/chat-model',
          sources: ['job description', 'selected CV'],
          createdAt: new Date(),
        },
      ],
      lastMessageAt: new Date(),
    });

    await first.close();
    await mongod.stop();

    mongod = await MongoMemoryServer.create({
      instance: { dbPath, storageEngine: 'wiredTiger' },
    });
    const second = mongoose.createConnection(mongod.getUri(dbName));
    await second.asPromise();
    const SecondApplication = second.model('Application', ApplicationModel.schema);
    const SecondLetter = second.model('CoverLetter', CoverLetterModel.schema);
    const SecondChat = second.model('ChatSession', ChatSessionModel.schema);

    const restored = await SecondApplication.findById(created._id).lean();
    expect(restored?.jobTitle).toBe('Senior Full Stack Engineer');
    expect(restored?.status).toBe('SUBMITTED');
    expect(restored?.appliedAt?.toISOString()).toBe('2026-10-24T09:00:00.000Z');
    expect(restored?.statusHistory).toHaveLength(1);
    expect(restored?.statusHistory[0]?.at?.toISOString()).toBe('2026-10-24T09:00:00.000Z');
    expect(restored?.idempotencyKey).toBe('restart-test-key');

    const restoredLetter = await SecondLetter.findById(letter._id).lean();
    expect(restoredLetter?.letterText).toContain('I am applying for the role');
    expect(restoredLetter?.version).toBe(1);
    expect(restoredLetter?.editedByUser).toBe(true);
    expect(restoredLetter?.jobContentHash).toBe('job-snapshot-hash');
    expect(String(restoredLetter?.job)).toBe(String(jobId));

    const restoredChat = await SecondChat.findById(chat._id).lean();
    expect(restoredChat?.messages).toHaveLength(2);
    expect(restoredChat?.messages[1]?.sources).toContain('job description');
    expect(String(restoredChat?.job)).toBe(String(jobId));

    await second.close();
    await mongod.stop();
  }, 60_000);
});
