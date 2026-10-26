import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { CandidateProfileModel } from '../src/models/CandidateProfile.js';
import { seedApprovedProfiles } from './helpers.js';

const app = createApp();

describe('candidate profile research fields', () => {
  it('persists edited experience, education, projects, publications and certifications', async () => {
    await seedApprovedProfiles();
    const profile = await CandidateProfileModel.findOne({ kind: 'ai_engineer' });

    const response = await request(app)
      .patch(`/api/profiles/${String(profile!._id)}`)
      .send({
        experience: [
          {
            title: 'Research Assistant',
            employer: 'Example University',
            startDate: '2020',
            endDate: '2021',
            summary: 'Knowledge-graph retrieval experiments.',
          },
        ],
        education: [
          { degree: 'MSc Computer Science', institution: 'Example University', year: '2021' },
        ],
        projects: [
          {
            name: 'RAG evaluation harness',
            summary: 'Measured retrieval quality on a public corpus.',
            technologies: ['Python', 'FAISS'],
          },
        ],
        publications: ['Knowledge graph embeddings for retrieval-augmented generation'],
        certifications: ['AWS Cloud Practitioner'],
      })
      .expect(200);

    expect(response.body.experience).toHaveLength(1);
    expect(response.body.experience[0].title).toBe('Research Assistant');
    expect(response.body.education[0].degree).toBe('MSc Computer Science');
    expect(response.body.projects[0].technologies).toEqual(['Python', 'FAISS']);
    expect(response.body.publications).toEqual([
      'Knowledge graph embeddings for retrieval-augmented generation',
    ]);
    expect(response.body.certifications).toEqual(['AWS Cloud Practitioner']);

    const stored = await CandidateProfileModel.findById(profile!._id);
    expect(stored?.publications).toHaveLength(1);
    expect(stored?.education[0]?.institution).toBe('Example University');
  });

  it('rejects malformed entries instead of silently dropping them', async () => {
    await seedApprovedProfiles();
    const profile = await CandidateProfileModel.findOne({ kind: 'full_stack' });
    await request(app)
      .patch(`/api/profiles/${String(profile!._id)}`)
      .send({ education: [{ degree: 'MSc Computer Science' }] })
      .expect(400);
  });
});
