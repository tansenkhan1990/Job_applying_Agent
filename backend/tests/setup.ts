import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach } from 'vitest';

const testDocsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-agent-docs-'));
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.OPENROUTER_API_KEY = '';
process.env.DOCUMENTS_PATH = testDocsDir;
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/job_agent_test_unused';
process.env.APPROVAL_REQUIRED = 'true';
process.env.ENABLE_MOCK_SOURCE = 'true';
process.env.ALLOW_MOCK_SUBMISSION = 'true';
process.env.BROWSER_RUNNER_TOKEN = 'test-runner-token';
process.env.FRONTEND_ORIGIN = 'http://localhost:5173';

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri('job_agent_test'));
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
});

beforeEach(async () => {
  const collections = await mongoose.connection.db?.collections();
  for (const collection of collections ?? []) {
    await collection.deleteMany({});
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
