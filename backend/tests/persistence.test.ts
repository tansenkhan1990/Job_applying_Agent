import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { describe, expect, it } from 'vitest';
import { JobModel } from '../src/models/Job.js';
import { ChatSessionModel } from '../src/models/ChatSession.js';
import { CoverLetterModel } from '../src/models/CoverLetter.js';

/**
 * Docker Compose mounts a named volume at /data/db. This test exercises the same property
 * without Docker: a saved job, a cover-letter version and a chat transcript written before the
 * database process stops are still there after a new process starts on the same data directory.
 */
describe('saved opportunity durability', () => {
  it('survives a database restart on the same data directory', async () => {
    const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'job-agent-db-'));
    const dbName = 'restart_test';

    let mongod = await MongoMemoryServer.create({
      instance: { dbPath, storageEngine: 'wiredTiger' },
    });
    const first = mongoose.createConnection(mongod.getUri(dbName));
    await first.asPromise();
    const FirstJob = first.model('Job', JobModel.schema);
    const FirstLetter = first.model('CoverLetter', CoverLetterModel.schema);
    const FirstChat = first.model('ChatSession', ChatSessionModel.schema);

    const profileId = new mongoose.Types.ObjectId();

    const job = await FirstJob.create({
      source: 'arbeitnow',
      sourceJobId: 'restart-42',
      sourceLabel: 'Arbeitnow',
      url: 'https://example.com/jobs/42',
      canonicalUrl: 'https://example.com/jobs/42',
      employer: 'Example GmbH',
      title: 'Senior Full Stack Engineer',
      location: 'Berlin',
      country: 'Germany',
      postedAt: new Date('2026-10-01T00:00:00.000Z'),
      ageEligibility: 'Eligible',
      status: 'active',
      saved: true,
      fingerprint: 'restart-test-fingerprint',
    });

    const letter = await FirstLetter.create({
      job: job._id,
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
      job: job._id,
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
    const SecondJob = second.model('Job', JobModel.schema);
    const SecondLetter = second.model('CoverLetter', CoverLetterModel.schema);
    const SecondChat = second.model('ChatSession', ChatSessionModel.schema);

    const restoredJob = await SecondJob.findById(job._id).lean();
    expect(restoredJob?.title).toBe('Senior Full Stack Engineer');
    expect(restoredJob?.saved).toBe(true);
    expect(restoredJob?.status).toBe('active');
    expect(restoredJob?.postedAt?.toISOString()).toBe('2026-10-01T00:00:00.000Z');

    const restoredLetter = await SecondLetter.findById(letter._id).lean();
    expect(restoredLetter?.letterText).toContain('I am applying for the role');
    expect(restoredLetter?.version).toBe(1);
    expect(restoredLetter?.editedByUser).toBe(true);
    expect(restoredLetter?.jobContentHash).toBe('job-snapshot-hash');
    expect(String(restoredLetter?.job)).toBe(String(job._id));

    const restoredChat = await SecondChat.findById(chat._id).lean();
    expect(restoredChat?.messages).toHaveLength(2);
    expect(restoredChat?.messages[1]?.sources).toContain('job description');
    expect(String(restoredChat?.job)).toBe(String(job._id));

    await second.close();
    await mongod.stop();
  }, 60_000);
});
