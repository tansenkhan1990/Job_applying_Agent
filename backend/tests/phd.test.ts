import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { AppSettingModel } from '../src/models/AppSetting.js';
import { defaultSettings } from '../src/config/defaults.js';
import { getSettings } from '../src/services/settingsService.js';
import { PhdPositionModel } from '../src/models/PhdPosition.js';
import { PhdMatchModel } from '../src/models/PhdMatch.js';
import { CandidateProfileModel } from '../src/models/CandidateProfile.js';
import { ChatSessionModel } from '../src/models/ChatSession.js';
import { env } from '../src/config/env.js';
import { phdMockAdapter } from '../src/services/phd/adapters/mock.js';
import { phdFeedAdapter } from '../src/services/phd/adapters/feed.js';
import { seedPhdPositionsIfEmpty } from '../src/services/phd/bootstrap.js';
import { sendChatMessage, type ChatResponderInput } from '../src/services/ai/chat.js';
import { scorePhdFit } from '../src/services/phd/scoring.js';
import { seedApprovedProfiles } from './helpers.js';

const app = createApp();

describe('PhD mock source', () => {
  it('labels every fixture as simulated and uses example.org links', async () => {
    const listings = await phdMockAdapter.searchPositions({ maxPositions: 20 });
    expect(listings.length).toBe(11);
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
  it('stores fully funded in-scope positions from every target region', async () => {
    const response = await request(app).post('/api/phd/search').send({}).expect(201);
    expect(response.body.created).toBe(9);
    // The German-mandatory role and the unfunded Dutch hybrid role are filtered out.
    expect(response.body.filteredOut).toBe(2);

    const list = await request(app).get('/api/phd/positions?limit=50').expect(200);
    expect(list.body.total).toBe(9);
    const titles = list.body.items.map((item: { title: string }) => item.title);
    expect(titles.some((title: string) => /Deutschkenntnisse/.test(title))).toBe(false);
    expect(titles.some((title: string) => /hybrid, Netherlands/.test(title))).toBe(false);

    const countries = new Set(
      list.body.items.map((item: { country: string }) => item.country),
    );
    for (const country of [
      'Germany',
      'Netherlands',
      'Canada',
      'United States',
      'Turkey',
      'Malaysia',
    ]) {
      expect(countries.has(country)).toBe(true);
    }

    const remote = list.body.items.find(
      (item: { country: string }) => item.country === 'Netherlands',
    );
    expect(remote.workArrangement).toBe('remote');
    expect(remote.remoteEligibleFromGermany).toBe(true);
    expect(remote.simulated).toBe(true);
    expect(
      list.body.items.every((item: { fundingStatus: string }) => item.fundingStatus === 'funded'),
    ).toBe(true);

    // On-site, hybrid and remote positions are all in scope; only the work arrangement differs.
    const arrangements = new Set(
      list.body.items.map((item: { workArrangement: string }) => item.workArrangement),
    );
    expect([...arrangements].sort()).toEqual(['hybrid', 'onsite', 'remote']);
  });

  it('lists on-site positions from every target region and only narrows on an explicit request', async () => {
    await request(app).post('/api/phd/search').send({}).expect(201);

    const all = await request(app).get('/api/phd/positions?limit=50').expect(200);
    const onsite = all.body.items.filter(
      (item: { workArrangement: string }) => item.workArrangement === 'onsite',
    );
    expect(onsite.length).toBeGreaterThan(0);
    for (const country of ['Canada', 'United States', 'Turkey']) {
      expect(
        onsite.some((item: { country: string }) => item.country === country),
        `expected an on-site position in ${country}`,
      ).toBe(true);
    }

    const onlyOnsite = await request(app)
      .get('/api/phd/positions?limit=50&workArrangement=onsite')
      .expect(200);
    expect(onlyOnsite.body.total).toBe(onsite.length);
    expect(
      onlyOnsite.body.items.every(
        (item: { workArrangement: string }) => item.workArrangement === 'onsite',
      ),
    ).toBe(true);
  });

  it('seeds the store on startup only while no position is stored yet', async () => {
    expect(await seedPhdPositionsIfEmpty()).toBe(9);
    expect(await PhdPositionModel.countDocuments()).toBe(9);

    // A store that already holds positions is left untouched.
    expect(await seedPhdPositionsIfEmpty()).toBe(0);
    expect(await PhdPositionModel.countDocuments()).toBe(9);
  });

  it('matches free-text filters literally instead of failing on regular-expression characters', async () => {
    await request(app).post('/api/phd/search').send({}).expect(201);

    for (const query of [
      'q=C%2B%2B',
      'q=%5B',
      'institution=Foo%20%5BBar%5D',
      'topic=(m%2Fw%2Fd)',
      'country=Malaysia',
    ]) {
      const response = await request(app)
        .get(`/api/phd/positions?limit=50&${query}`)
        .expect(200);
      expect(Array.isArray(response.body.items)).toBe(true);
    }

    const knowledge = await request(app)
      .get('/api/phd/positions?limit=50&q=Knowledge%20Graphs')
      .expect(200);
    expect(knowledge.body.total).toBeGreaterThan(0);
    expect(knowledge.body.items.every((item: { title: string }) => /knowledge graphs/i.test(item.title))).toBe(
      true,
    );
  });

  it('enables the simulated PhD source once for settings that predate the default', async () => {
    const legacy = structuredClone(defaultSettings());
    legacy.sources.phd_mock = { enabled: false };
    legacy.sources.phd_feed = { enabled: false };
    await AppSettingModel.create({ key: 'global', value: legacy });

    const migrated = await getSettings();
    expect(migrated.sources.phd_mock.enabled).toBe(true);

    // The migration is one-time, so a manual disable afterwards is respected.
    await request(app)
      .patch('/api/settings')
      .send({ sources: { phd_mock: { enabled: false } } })
      .expect(200);
    expect((await getSettings()).sources.phd_mock.enabled).toBe(false);
  });

  it('stores only fully funded, in-scope positions in Europe, Turkey, the USA, Canada and Malaysia', async () => {
    env.PHD_FEED_URL = 'https://example.org/phd-feed.json';
    const fundedItem = (id: string, overrides: Record<string, unknown>) => ({
      id,
      url: `https://example.org/phd/${id}`,
      institution: 'Example University',
      applicationDeadline: '2027-06-30',
      deadlineTimezone: 'UTC',
      description: 'English is the working language.',
      ...overrides,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            positions: [
              fundedItem('ca', {
                title: 'PhD in machine learning for data platforms',
                country: 'Canada',
                location: 'Toronto, Canada',
                description: 'The position is fully funded for four years. English is the working language.',
              }),
              fundedItem('tr', {
                title: 'PhD in applied cryptography and network security',
                country: 'Turkey',
                location: 'Ankara, Turkey',
                workArrangement: 'onsite',
                description: 'Fully funded doctoral contract. English is the working language.',
              }),
              fundedItem('my', {
                title: 'PhD in data science and knowledge graphs',
                country: 'Malaysia',
                location: 'Kuala Lumpur, Malaysia',
                description: 'Fully funded doctoral studentship. English is the working language.',
              }),
              fundedItem('in', {
                title: 'PhD in machine learning',
                country: 'India',
                location: 'Bangalore, India',
                description: 'Fully funded position. English is the working language.',
              }),
              fundedItem('de-unfunded', {
                title: 'PhD in machine learning',
                country: 'Germany',
                location: 'Berlin, Germany',
              }),
              fundedItem('de-self', {
                title: 'PhD in data engineering',
                country: 'Germany',
                location: 'Munich, Germany',
                description: 'This is a self-funded position; applicants must secure their own funding.',
              }),
              fundedItem('de-other-area', {
                title: 'PhD in marine biology',
                country: 'Germany',
                location: 'Bremen, Germany',
                description: 'Fully funded position. English is the working language.',
              }),
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    await request(app)
      .patch('/api/settings')
      .send({ sources: { phd_mock: { enabled: false }, phd_feed: { enabled: true } } })
      .expect(200);

    try {
      const run = await request(app).post('/api/phd/search').send({}).expect(201);
      expect(run.body.discovered).toBe(7);
      expect(run.body.created).toBe(3);
      expect(run.body.filteredOut).toBe(4);

      const list = await request(app).get('/api/phd/positions?limit=50').expect(200);
      expect(list.body.total).toBe(3);
      const countries = list.body.items
        .map((item: { country: string }) => item.country)
        .sort();
      expect(countries).toEqual(['Canada', 'Malaysia', 'Turkey']);
      for (const item of list.body.items as Array<{ fundingStatus: string }>) {
        expect(item.fundingStatus).toBe('funded');
      }

      // The excluded rows stay inspectable through the review view, but never by default.
      const review = await request(app).get('/api/phd/positions?limit=50&funded=false').expect(200);
      expect(review.body.total).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      env.PHD_FEED_URL = '';
      await request(app)
        .patch('/api/settings')
        .send({ sources: { phd_mock: { enabled: true }, phd_feed: { enabled: false } } })
        .expect(200);
    }
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
  });

  it('backfills a deterministic score for every listed position without a manual step', async () => {
    await seedApprovedProfiles();
    await request(app).post('/api/phd/search').send({}).expect(201);
    expect(await PhdMatchModel.countDocuments()).toBe(0);

    const list = await request(app).get('/api/phd/positions?limit=50').expect(200);
    expect(list.body.items).toHaveLength(9);
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
    expect(await PhdMatchModel.countDocuments()).toBe(27);
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

describe('PhD deadline verification', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    env.PHD_FEED_URL = '';
  });

  async function seedFeedPosition() {
    return PhdPositionModel.create({
      source: 'phd_feed',
      sourceJobId: 'feed-verify-1',
      sourceLabel: 'Configured PhD feed',
      simulated: false,
      url: 'https://example.org/phd/verify-1',
      canonicalUrl: 'https://example.org/phd/verify-1',
      institution: 'Example University',
      title: 'Doctoral Researcher in Knowledge Graphs',
      description: 'English is the working language. Master degree in computer science.',
      country: 'Germany',
      location: 'Berlin, Germany',
      researchArea: 'ai',
      postedAt: new Date(Date.now() - 100 * 86_400_000),
      applicationDeadline: new Date(Date.now() + 30 * 86_400_000),
      deadlineHasTime: false,
      deadlineStatus: 'open',
      status: 'active',
      fingerprint: 'feed-verify-fingerprint',
      contentHash: 'feed-verify-hash',
    });
  }

  function feedResponse(items: unknown[]) {
    return new Response(JSON.stringify({ positions: items }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('closes a position when the source reports it filled, and removes it from open results', async () => {
    env.PHD_FEED_URL = 'https://example.org/phd-feed.json';
    const position = await seedFeedPosition();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        feedResponse([
          {
            id: 'feed-verify-1',
            title: 'Doctoral Researcher in Knowledge Graphs',
            institution: 'Example University',
            url: 'https://example.org/phd/verify-1',
            country: 'Germany',
            description: 'English is the working language. Master degree in computer science.',
            applicationDeadline: '2027-01-15',
            status: 'filled',
          },
        ]),
      ),
    );

    const response = await request(app)
      .post(`/api/phd/positions/${String(position._id)}/verify`)
      .send({})
      .expect(200);
    expect(response.body.verification.status).toBe('unavailable');
    expect(response.body.position.status).toBe('closed');
    expect(response.body.position.lastVerifiedAt).toBeTruthy();
    expect(response.body.position.deadlineHasTime).toBe(false);

    const open = await request(app).get('/api/phd/positions?limit=50').expect(200);
    expect(open.body.items.map((item: { id: string }) => item.id)).not.toContain(
      String(position._id),
    );
  });

  it('does not mark a position closed when it is merely absent from the current feed', async () => {
    env.PHD_FEED_URL = 'https://example.org/phd-feed.json';
    const position = await seedFeedPosition();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(feedResponse([])));

    const response = await request(app)
      .post(`/api/phd/positions/${String(position._id)}/verify`)
      .send({})
      .expect(200);
    expect(response.body.verification.status).toBe('unknown');
    expect(response.body.verification.evidence).toMatch(/not marked closed automatically/i);
    expect(response.body.position.status).toBe('active');

    const stored = await PhdPositionModel.findById(position._id);
    expect(stored?.status).toBe('active');
    // A missing entry is not a verification: no timestamp is claimed and nothing is closed.
    expect(stored?.lastVerifiedAt).toBeNull();
  });

  it('refuses to pretend a simulated fixture can be verified', async () => {
    const position = await PhdPositionModel.findOne({ source: 'phd_mock' });
    if (!position) {
      await request(app).post('/api/phd/search').send({}).expect(201);
    }
    const simulated = await PhdPositionModel.findOne({ source: 'phd_mock' });
    const response = await request(app)
      .post(`/api/phd/positions/${String(simulated!._id)}/verify`)
      .send({})
      .expect(200);
    expect(response.body.verification.status).toBe('unknown');
    expect(response.body.verification.evidence).toMatch(/simulated fixture/i);
  });
});
