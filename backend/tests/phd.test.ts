import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { PhdPositionModel } from '../src/models/PhdPosition.js';
import { PhdMatchModel } from '../src/models/PhdMatch.js';
import { ApplicationModel } from '../src/models/Application.js';
import { CandidateProfileModel } from '../src/models/CandidateProfile.js';
import { ChatSessionModel } from '../src/models/ChatSession.js';
import { env } from '../src/config/env.js';
import { phdMockAdapter } from '../src/services/phd/adapters/mock.js';
import { phdFeedAdapter } from '../src/services/phd/adapters/feed.js';
import { sendChatMessage, type ChatResponderInput } from '../src/services/ai/chat.js';
import { scorePhdFit } from '../src/services/phd/scoring.js';
import { seedApprovedProfiles } from './helpers.js';

const app = createApp();

describe('PhD mock source', () => {
  it('labels every fixture as simulated and uses example.org links', async () => {
    const listings = await phdMockAdapter.searchPositions({ maxPositions: 20 });
    expect(listings.length).toBe(7);
    expect(listings.every((listing) => listing.simulated)).toBe(true);
    expect(listings.every((listing) => listing.url.startsWith('https://example.org/'))).toBe(true);
  });
});

describe('configured PhD feed adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    env.PHD_FEED_URL = '';
  });

  it('normalizes a permitted JSON feed without inventing fields', async () => {
    env.PHD_FEED_URL = 'https://example.org/phd-feed.json';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          positions: [
            {
              id: 'feed-1',
              title: 'Doctoral Researcher in Knowledge Graphs',
              institution: 'Example University',
              url: 'https://example.org/phd/1',
              country: 'Germany',
              location: 'Berlin, Germany',
              researchTopic: 'Knowledge graphs and RAG',
              description: 'English is our working language.',
              postedAt: '2026-10-01',
              applicationDeadline: '2027-01-15',
            },
            {
              id: 'feed-2',
              title: 'PhD in Graph Learning (on-site)',
              institution: 'Example Overseas University',
              url: 'https://example.org/phd/2',
              country: 'United States',
              location: 'Boston',
              workArrangement: 'onsite',
              description: 'On-site doctoral position in the United States.',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const listings = await phdFeedAdapter.searchPositions({ maxPositions: 10 });
    expect(listings).toHaveLength(2);
    expect(listings.every((listing) => listing.simulated === false)).toBe(true);
    expect(listings[0].sourceJobId).toBe('feed-1');
    expect(listings[0].country).toBe('Germany');
    expect(listings[0].postedAt?.toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(listings[0].applicationDeadline?.toISOString().slice(0, 10)).toBe('2027-01-15');
    expect(listings[0].salary).toBe('');
    expect(listings[0].requiredQualifications).toEqual([]);
    // The non-German on-site position is stored by the adapter but excluded by discovery.
    expect(listings[1].country).toBe('United States');
    expect(listings[1].workArrangement).toBe('onsite');
  });
});

describe('PhD discovery', () => {
  it('stores German positions and explicitly remote EU positions only', async () => {
    const response = await request(app).post('/api/phd/search').send({}).expect(201);
    expect(response.body.created).toBe(5);
    // The Dutch hybrid role and the German-mandatory role are filtered out.
    expect(response.body.filteredOut).toBe(2);

    const list = await request(app).get('/api/phd/positions?limit=50').expect(200);
    expect(list.body.total).toBe(5);
    const titles = list.body.items.map((item: { title: string }) => item.title);
    expect(titles.some((title: string) => /Deutschkenntnisse/.test(title))).toBe(false);
    expect(titles.some((title: string) => /hybrid, Netherlands/.test(title))).toBe(false);

    const outside = list.body.items.filter(
      (item: { country: string }) => item.country !== 'Germany',
    );
    expect(outside).toHaveLength(1);
    expect(outside[0].workArrangement).toBe('remote');
    expect(outside[0].remoteEligibleFromGermany).toBe(true);
    expect(outside[0].simulated).toBe(true);
  });

  it('keeps previously discovered positions when a source fails', async () => {
    await request(app).post('/api/phd/search').send({}).expect(201);
    const before = await PhdPositionModel.countDocuments();
    // Disable the only configured source; discovery is refused but stored rows remain.
    await request(app)
      .patch('/api/settings')
      .send({ sources: { phd_mock: { enabled: false } } })
      .expect(200);
    await request(app).post('/api/phd/search').send({}).expect(400);
    expect(await PhdPositionModel.countDocuments()).toBe(before);
    await request(app)
      .patch('/api/settings')
      .send({ sources: { phd_mock: { enabled: true } } })
      .expect(200);
  });
});

describe('PhD matching and letters', () => {
  it('produces an explained estimate, flags mandatory gaps, and versions letters', async () => {
    await seedApprovedProfiles();
    await request(app).post('/api/phd/search').send({}).expect(201);

    const position = await PhdPositionModel.findOne({ sourceJobId: 'mock-phd-kg-001' });
    expect(position).not.toBeNull();

    const matchResponse = await request(app)
      .post(`/api/phd/positions/${String(position!._id)}/match`)
      .send({})
      .expect(200);
    expect(matchResponse.body.matches).toHaveLength(3);
    const best = [...matchResponse.body.matches].sort(
      (a: { score: number }, b: { score: number }) => b.score - a.score,
    )[0];
    expect(best.score).toBeGreaterThanOrEqual(0);
    expect(best.score).toBeLessThanOrEqual(100);
    expect(best.explanation).toMatch(/Estimated profile match/);
    expect(best.scoreCategories.length).toBeGreaterThanOrEqual(3);
    expect(best.matchedTopics).toContain('Knowledge graphs');
    // The seeded profiles have no education records, so the master's requirement is flagged.
    expect(best.mandatoryMissing.length).toBeGreaterThan(0);

    const profile = await CandidateProfileModel.findOne({ kind: 'ai_engineer' });
    const options = await request(app)
      .get(`/api/phd/positions/${String(position!._id)}/cover-letter/options`)
      .expect(200);
    expect(options.body.positionId).toBe(String(position!._id));
    expect(options.body.profiles).toHaveLength(3);
    expect(options.body.selectionRationale).toMatch(/Selected .* CV/);

    const preferences = await request(app)
      .patch(`/api/phd/positions/${String(position!._id)}/letter-preferences`)
      .send({ cvProfileId: String(profile!._id), referenceProfileId: String(profile!._id) })
      .expect(200);
    expect(preferences.body.selectedCvProfileId).toBe(String(profile!._id));
    expect(preferences.body.selectedReferenceProfileId).toBe(String(profile!._id));

    const letterResponse = await request(app)
      .post(`/api/phd/positions/${String(position!._id)}/cover-letter`)
      .send({ profileId: String(profile!._id) })
      .expect(201);
    expect(letterResponse.body.letter.source).toBe('template');
    expect(letterResponse.body.letter.letterType).toBe('phd');
    expect(letterResponse.body.letter.profile).toBe(String(profile!._id));
    expect(letterResponse.body.letter.referenceProfile).toBe(String(profile!._id));
    expect(letterResponse.body.letter.referenceLetterDocument).toBeTruthy();
    expect(letterResponse.body.letter.letterText).toContain('Demo University of Technology');
    expect(letterResponse.body.letter.version).toBe(1);

    const list = await request(app)
      .get(`/api/phd/positions/${String(position!._id)}/cover-letters`)
      .expect(200);
    expect(list.body).toHaveLength(1);

    const editedText = `${letterResponse.body.letter.letterText}\n\nAdditional paragraph edited by the candidate.`;
    const edit = await request(app)
      .patch(`/api/phd/positions/${String(position!._id)}/cover-letters/${letterResponse.body.letter.id}`)
      .send({ letterText: editedText })
      .expect(200);
    expect(edit.body.letter.editedByUser).toBe(true);
    expect(edit.body.letter.version).toBe(1);
    expect(edit.body.letter.revisions).toHaveLength(1);
    expect(edit.body.letter.revisions[0].text).toBe(letterResponse.body.letter.letterText);

    const regenerated = await request(app)
      .post(`/api/phd/positions/${String(position!._id)}/cover-letter`)
      .send({ profileId: String(profile!._id), instructions: 'Shorter version.' })
      .expect(201);
    expect(regenerated.body.letter.version).toBe(2);

    // Generating a letter is never an application side effect.
    expect(await ApplicationModel.countDocuments()).toBe(0);
  });

  it('backfills a deterministic score for every listed position without a manual step', async () => {
    await seedApprovedProfiles();
    await request(app).post('/api/phd/search').send({}).expect(201);
    expect(await PhdMatchModel.countDocuments()).toBe(0);

    const list = await request(app).get('/api/phd/positions?limit=50').expect(200);
    expect(list.body.items).toHaveLength(5);
    for (const item of list.body.items as Array<{
      bestMatch: { score: number; explanation: string } | null;
    }>) {
      expect(item.bestMatch).not.toBeNull();
      expect(item.bestMatch!.score).toBeGreaterThanOrEqual(0);
      expect(item.bestMatch!.score).toBeLessThanOrEqual(100);
      expect(item.bestMatch!.explanation).toMatch(/Estimated profile match/);
    }

    const detail = await request(app)
      .get(`/api/phd/positions/${list.body.items[0].id}`)
      .expect(200);
    expect(detail.body.matches).toHaveLength(3);
    expect(await PhdMatchModel.countDocuments()).toBe(15);
  });

  it('scores topic evidence without inventing a probability', async () => {
    await seedApprovedProfiles();
    await request(app).post('/api/phd/search').send({}).expect(201);
    const profile = await CandidateProfileModel.findOne({ kind: 'ai_engineer' });
    await CandidateProfileModel.updateOne(
      { _id: profile!._id },
      {
        $set: {
          education: [{ degree: 'MSc Computer Science', institution: 'Example University', year: '2021' }],
          publications: [
            'Knowledge graph embeddings for retrieval-augmented generation',
            'Evaluating graph neural networks on temporal knowledge graphs',
          ],
        },
      },
    );
    const updated = await CandidateProfileModel.findById(profile!._id);
    const position = await PhdPositionModel.findOne({ sourceJobId: 'mock-phd-kg-001' });
    const fit = scorePhdFit(position!, updated!);
    expect(fit.score).toBeGreaterThan(50);
    expect(fit.matchedPublications.length).toBeGreaterThan(0);
    expect(fit.mandatoryMissing).toHaveLength(0);
    expect(fit.explanation).toMatch(/not a prediction/i);
    expect(fit.categories.reduce((sum, category) => sum + category.weight, 0)).toBeLessThanOrEqual(100);
    expect(await PhdMatchModel.countDocuments()).toBe(0);
  });

  it('keeps a PhD-scoped chat conversation with research grounding', async () => {
    await seedApprovedProfiles();
    await request(app).patch('/api/settings').send({ ai: { model: 'test/chat-model' } }).expect(200);
    await request(app).post('/api/phd/search').send({}).expect(201);
    const position = await PhdPositionModel.findOne({ sourceJobId: 'mock-phd-kg-001' });

    const seen: ChatResponderInput[] = [];
    const responder = async (input: ChatResponderInput) => {
      seen.push(input);
      return { content: `PhD grounded answer ${seen.length}`, model: 'test/chat-model' };
    };

    const first = await sendChatMessage({
      target: { type: 'phd', position: position! },
      content: 'Does my education fit this doctoral project?',
      responder,
    });
    expect(first.session.targetType).toBe('phd');
    expect(String(first.session.phdPosition)).toBe(String(position!._id));
    expect(first.session.job).toBeNull();
    expect(first.session.messages).toHaveLength(2);
    expect(seen[0].context).toContain(position!.institution);
    expect(seen[0].context).toMatch(/PHD FACTS/);
    expect(seen[0].system).toMatch(/PhD position/);
    expect(seen[0].history).toEqual([]);

    const followUp = await sendChatMessage({
      target: { type: 'phd', position: position! },
      content: 'What should I emphasise in the academic letter?',
      sessionId: String(first.session._id),
      responder,
    });
    expect(followUp.session.messages).toHaveLength(4);
    expect(seen[1].history.map((message) => message.content)).toEqual([
      'Does my education fit this doctoral project?',
      'PhD grounded answer 1',
    ]);

    // PhD conversations are never stored as job conversations.
    expect(await ChatSessionModel.countDocuments({ targetType: 'job' })).toBe(0);
    expect(await ChatSessionModel.countDocuments({ phdPosition: position!._id })).toBe(1);

    // A second PhD position has its own empty transcript and rejects the first session id.
    const other = await PhdPositionModel.findOne({ sourceJobId: 'mock-phd-rag-002' });
    expect(other).not.toBeNull();
    const otherFirst = await sendChatMessage({
      target: { type: 'phd', position: other! },
      content: 'Which publication fits this position?',
      responder,
    });
    expect(seen[2].history).toEqual([]);
    expect(seen[2].context).toContain(other!.institution);
    await expect(
      sendChatMessage({
        target: { type: 'phd', position: other! },
        content: 'Show the other conversation',
        sessionId: String(first.session._id),
        responder,
      }),
    ).rejects.toThrow(/Chat session/);
    expect(await ChatSessionModel.countDocuments({ phdPosition: other!._id })).toBe(1);
    expect(otherFirst.session.messages).toHaveLength(2);
  });
});
