import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { JobModel } from '../src/models/Job.js';
import { runDiscovery } from '../src/services/jobs/discovery.js';
import { applyDeterministicFilters } from '../src/services/jobs/filters.js';
import { sourceStatuses } from '../src/services/jobs/adapters/index.js';
import {
  buildSearchQueries,
  decodeResultUrl,
  extractPageText,
  parseDuckDuckGoResults,
  webSearchAdapter,
} from '../src/services/jobs/adapters/websearch.js';
import type { JobSearchCriteria } from '../src/services/jobs/types.js';
import { updateSettings } from '../src/services/settingsService.js';

const criteria: JobSearchCriteria = {
  countries: ['Germany'],
  remoteScope: ['Germany', 'European Union'],
  languages: ['English'],
  workArrangements: ['remote', 'hybrid', 'onsite'],
  seniority: ['mid', 'senior'],
  targetTitles: ['Full Stack Developer', 'AI Engineer'],
  profileKinds: ['full_stack', 'ai_engineer'],
  includeKeywords: [],
  excludeKeywords: [],
  excludeInternships: true,
  excludeUnpaid: true,
  excludeGermanRequired: true,
  freshnessDays: 365,
  maxAgeMonths: 3,
  maxJobs: 5,
};

const SEARCH_HTML = `<html><body>
<div class="result results_links">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcareers.example.com%2Fjobs%2F123&amp;rut=abc">Senior Full Stack Developer - Example Commerce</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">We are hiring a Senior Full Stack Developer in Berlin to build checkout services.</a>
  </div>
</div>
<div class="result results_links">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fblog.example.com%2Fbest-engineering-jobs&amp;rut=xyz">Top 50 engineering jobs in Germany</a>
    </h2>
    <div class="result__snippet">A round-up of job boards and salary guides.</div>
  </div>
</div>
<div class="result results_links">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.linkedin.com%2Fjobs%2Fview%2F999">Already applied role on a login-walled network</a>
    </h2>
    <div class="result__snippet">Members only.</div>
  </div>
</div>
</body></html>`;

const JOB_PAGE_HTML = `<html><head><title>Senior Full Stack Developer - Example Commerce GmbH</title></head>
<body>
<nav>Home About Contact</nav>
<script>window.analytics = {tracking: true};</script>
<main>
  <h1>Senior Full Stack Developer (m/w/d)</h1>
  <p>Example Commerce GmbH is looking for a Senior Full Stack Developer to join our checkout team in Berlin.</p>
  <p>You will build and operate TypeScript, React and Node.js services, design REST APIs and improve our CI/CD pipelines.</p>
  <p>Requirements: 5+ years of professional software engineering experience with TypeScript and Node.js. English is our working language; German is not required.</p>
  <p>We offer a hybrid work model, 30 days of vacation and a learning budget.</p>
  <p>Apply by sending your CV through our application form.</p>
  <p>Our office is in Berlin, Germany, close to public transport, with regular team events and a dog-friendly workspace.</p>
</main>
</body></html>`;

const BLOG_PAGE_HTML = `<html><head><title>Top 50 engineering jobs in Germany</title></head>
<body><main>
  <h1>Top 50 engineering jobs in Germany</h1>
  <p>This article lists fifty open engineering roles across Berlin, Munich and Hamburg, with salary ranges and links to the original postings on each company's career page.</p>
  <p>It is updated every month, so bookmark it and check back for new entries. The selection covers frontend, backend, data and platform engineering roles at startups and mid-sized companies.</p>
</main></body></html>`;

const postedAt = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);

const EXTRACTION = {
  isJobPosting: true,
  title: 'Senior Full Stack Developer',
  employer: 'Example Commerce GmbH',
  location: 'Berlin, Germany',
  remote: false,
  workArrangement: 'hybrid',
  employmentType: 'Full-time',
  salary: 'EUR 75,000 - 90,000',
  tags: ['TypeScript', 'React', 'Node.js'],
  description:
    'Build and operate TypeScript, React and Node.js services for the checkout team, design REST APIs and improve CI/CD pipelines. English is the working language; German is not required.',
  postedAt,
  expiresAt: '',
  applicationUrl: 'https://careers.example.com/jobs/123/apply',
  confidence: 0.92,
};

function enableAi() {
  env.OPENROUTER_API_KEY = 'test-key';
  env.aiConfigured = true;
  env.OPENROUTER_MODEL = 'test/model';
  env.AI_MAX_RETRIES = 0;
  env.AI_TIMEOUT_MS = 2_000;
}

function restoreEnv() {
  env.OPENROUTER_API_KEY = '';
  env.aiConfigured = false;
  env.OPENROUTER_MODEL = '';
  env.AI_MAX_RETRIES = 3;
  env.AI_TIMEOUT_MS = 90_000;
  env.JOB_WEB_SEARCH_ENABLED = false;
  env.JOB_WEB_SEARCH_MAX_QUERIES = 4;
  env.JOB_WEB_SEARCH_MAX_PAGES = 6;
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const htmlResponse = (html: string) =>
  new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

/**
 * Stub the network calls a web-search run makes: DuckDuckGo, one job page, one index page, and
 * the OpenRouter model list plus chat completion.
 *
 * Without an explicit `extraction` the model is answered per page: the extraction prompt carries
 * the page URL, so the index page is told it is not a vacancy.
 */
function stubWeb(extraction?: unknown) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target.endsWith('/models')) return jsonResponse({ data: [] });
    if (target.includes('chat/completions')) {
      const body = typeof init?.body === 'string' ? init.body : '';
      const reply =
        extraction ?? (body.includes('blog.example.com') ? { ...EXTRACTION, isJobPosting: false } : EXTRACTION);
      return jsonResponse({
        model: 'test/model',
        choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: 'stop' }],
      });
    }
    if (target.includes('html.duckduckgo.com')) return htmlResponse(SEARCH_HTML);
    if (target.includes('careers.example.com/jobs/123')) return htmlResponse(JOB_PAGE_HTML);
    if (target.includes('blog.example.com')) return htmlResponse(BLOG_PAGE_HTML);
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  restoreEnv();
});

describe('web search query building', () => {
  it('searches with the candidate target titles and their country', () => {
    const queries = buildSearchQueries(criteria, 4);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain('"Full Stack Developer"');
    expect(queries[0]).toContain('Germany');
    expect(queries[1]).toContain('"AI Engineer"');
  });

  it('aims half the queries at single-vacancy ATS pages and excludes aggregator indexes', () => {
    const [atsQuery, openQuery] = buildSearchQueries(criteria, 2);
    expect(atsQuery).toContain('site:jobs.lever.co');
    expect(atsQuery).toContain('site:job-boards.greenhouse.io');
    expect(atsQuery).not.toContain('-site:');

    expect(openQuery).toContain('-site:stepstone.de');
    expect(openQuery).toContain('-site:jooble.org');
    expect(openQuery).not.toContain('site:jobs.lever.co');
  });

  it('adds include keywords as skills and caps the query count', () => {
    const queries = buildSearchQueries(
      { ...criteria, includeKeywords: ['TypeScript', 'PostgreSQL', 'Docker'] },
      2,
    );
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain('TypeScript PostgreSQL');
    expect(queries[0]).not.toContain('Docker');
  });

  it('rotates CV-derived profile skills across queries instead of repeating the same pair', () => {
    const queries = buildSearchQueries(
      {
        ...criteria,
        targetTitles: ['Full Stack Developer', 'AI Engineer', 'DevOps Engineer'],
        includeKeywords: [],
        profileSkills: ['TypeScript', 'React', 'Node.js', 'Python', 'FastAPI', 'AWS'],
      },
      3,
    );
    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain('TypeScript React');
    expect(queries[1]).toContain('Node.js Python');
    expect(queries[2]).toContain('FastAPI AWS');
  });

  it('spreads a small query budget across every profile instead of one block of titles', () => {
    // Target titles are the concatenated title lists of the enabled profiles.
    const targetTitles = ['Full Stack Developer', 'Frontend Engineer', 'Backend Engineer', 'AI Engineer', 'LLM Engineer', 'Applied AI Engineer', 'DevOps Engineer', 'Cloud Engineer', 'Platform Engineer'];
    const queries = buildSearchQueries({ ...criteria, targetTitles }, 3);
    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain('Full Stack Developer');
    expect(queries[1]).toContain('AI Engineer');
    expect(queries[2]).toContain('DevOps Engineer');
  });

  it('falls back to a generic query when no titles are configured', () => {
    const queries = buildSearchQueries({ ...criteria, targetTitles: [], countries: [] }, 1);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('"software engineer"');
    expect(queries[0]).toContain('remote');
  });
});

describe('DuckDuckGo result parsing', () => {
  it('unwraps redirect links and rejects ads, internal links and login-walled hosts', () => {
    expect(
      decodeResultUrl(
        '//duckduckgo.com/l/?uddg=https%3A%2F%2Fcareers.example.com%2Fjobs%2F123&amp;rut=abc',
      ),
    ).toBe('https://careers.example.com/jobs/123');
    expect(decodeResultUrl('//duckduckgo.com/y.js?ad_provider=x&u3=abc')).toBe('');
    expect(decodeResultUrl('https://www.linkedin.com/jobs/view/999')).toBe('');
    expect(decodeResultUrl('javascript:void(0)')).toBe('');
  });

  it('pairs each result with its own snippet and skips duplicate destinations', () => {
    const hits = parseDuckDuckGoResults(SEARCH_HTML, 10);
    expect(hits.map((hit) => hit.url)).toEqual([
      'https://careers.example.com/jobs/123',
      'https://blog.example.com/best-engineering-jobs',
    ]);
    expect(hits[0]!.title).toContain('Senior Full Stack Developer');
    expect(hits[0]!.snippet).toContain('build checkout services');
    expect(hits[1]!.snippet).toContain('round-up of job boards');

    const duplicated = parseDuckDuckGoResults(`${SEARCH_HTML}${SEARCH_HTML}`, 10);
    expect(duplicated).toHaveLength(2);
  });

  it('strips scripts, styles and markup from a fetched page', () => {
    const text = extractPageText(JOB_PAGE_HTML);
    expect(text).toContain('Example Commerce GmbH is looking for a Senior Full Stack Developer');
    expect(text).not.toContain('window.analytics');
    expect(text).not.toContain('<p>');
  });
});

describe('web search source', () => {
  it('is only usable when an AI key is configured', async () => {
    expect(webSearchAdapter.isConfigured()).toBe(false);
    enableAi();
    expect(webSearchAdapter.isConfigured()).toBe(true);

    const status = (await sourceStatuses()).find((source) => source.id === 'web_search');
    expect(status).toBeDefined();
    expect(status?.configured).toBe(true);
    expect(status?.note).toContain('OPENROUTER_API_KEY');
  });

  it('refuses to run without an AI model instead of returning nothing silently', async () => {
    enableAi();
    env.OPENROUTER_MODEL = '';
    await updateSettings({ ai: { model: '' } });
    await expect(webSearchAdapter.searchJobs(criteria)).rejects.toThrow(/AI model/);
  });

  it('turns search hits into listings and rejects pages that are not one vacancy', async () => {
    enableAi();
    env.JOB_WEB_SEARCH_MAX_QUERIES = 2;
    env.JOB_WEB_SEARCH_MAX_PAGES = 4;

    const fetchMock = stubWeb();

    const listings = await webSearchAdapter.searchJobs(criteria);

    expect(listings).toHaveLength(1);
    const [listing] = listings;
    expect(listing!.source).toBe('web_search');
    expect(listing!.sourceLabel).toContain('DuckDuckGo');
    expect(listing!.title).toBe('Senior Full Stack Developer');
    expect(listing!.employer).toBe('Example Commerce GmbH');
    expect(listing!.country).toBe('Germany');
    expect(listing!.workArrangement).toBe('hybrid');
    expect(listing!.applicationUrl).toBe('https://careers.example.com/jobs/123/apply');
    expect(listing!.postedAt?.toISOString().slice(0, 10)).toBe(postedAt);
    expect(applyDeterministicFilters(listing!, criteria).included).toBe(true);

    // DuckDuckGo is queried, and only the two allowed result pages are fetched.
    const calls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calls.some((call) => call.includes('html.duckduckgo.com'))).toBe(true);
    expect(calls.some((call) => call.includes('linkedin.com'))).toBe(false);
    expect(calls.filter((call) => call.includes('blog.example.com'))).toHaveLength(1);
  });

  it('drops a page that claims to be a vacancy with too little confidence', async () => {
    enableAi();
    env.JOB_WEB_SEARCH_MAX_QUERIES = 1;
    env.JOB_WEB_SEARCH_MAX_PAGES = 1;
    stubWeb({ ...EXTRACTION, confidence: 0.1 });

    await expect(webSearchAdapter.searchJobs(criteria)).resolves.toEqual([]);
  });

  it('stops searching when DuckDuckGo serves its bot check and reports why', async () => {
    enableAi();
    env.JOB_WEB_SEARCH_MAX_QUERIES = 3;
    const fetchMock = vi.fn(async (_url: string | URL | Request) =>
      new Response('<html><body>Select all squares containing a duck</body></html>', {
        status: 202,
        headers: { 'content-type': 'text/html' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(webSearchAdapter.searchJobs(criteria)).rejects.toThrow(/bot check/i);
    // Later queries would hit the same wall, so the source must not keep trying.
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('duckduckgo'))).toHaveLength(1);
  });

  it('keeps the listings it already found when a later query is challenged', async () => {
    enableAi();
    env.JOB_WEB_SEARCH_MAX_QUERIES = 3;
    env.JOB_WEB_SEARCH_MAX_PAGES = 4;

    let searches = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('html.duckduckgo.com')) {
        searches += 1;
        if (searches > 1) return new Response('challenge', { status: 202 });
        return htmlResponse(SEARCH_HTML);
      }
      if (target.endsWith('/models')) return jsonResponse({ data: [] });
      if (target.includes('chat/completions')) {
        const body = typeof init?.body === 'string' ? init.body : '';
        const reply = body.includes('blog.example.com') ? { ...EXTRACTION, isJobPosting: false } : EXTRACTION;
        return jsonResponse({
          model: 'test/model',
          choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: 'stop' }],
        });
      }
      if (target.includes('careers.example.com/jobs/123')) return htmlResponse(JOB_PAGE_HTML);
      if (target.includes('blog.example.com')) return htmlResponse(BLOG_PAGE_HTML);
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const listings = await webSearchAdapter.searchJobs(criteria);
    expect(searches).toBe(2);
    expect(listings).toHaveLength(1);
    expect(listings[0]!.title).toBe('Senior Full Stack Developer');
  });

  it('runs inside discovery and the listing reaches the jobs API', async () => {
    enableAi();
    await updateSettings({
      search: { sources: { arbeitnow: false, remotive: false, mock: false, web_search: true } },
      sources: {
        arbeitnow: { enabled: false },
        remotive: { enabled: false },
        mock: { enabled: false },
        web_search: { enabled: true },
      },
    });
    stubWeb();

    const result = await runDiscovery({ trigger: 'manual' });
    expect(result.status).toBe('completed');
    expect(result.created).toBe(1);
    expect(result.sources.map((source) => source.source)).toEqual(['web_search']);

    const stored = await JobModel.find({ source: 'web_search' });
    expect(stored).toHaveLength(1);

    const response = await request(createApp()).get('/api/jobs').expect(200);
    const items = response.body.items ?? response.body.jobs ?? response.body;
    expect(Array.isArray(items)).toBe(true);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Senior Full Stack Developer');
    expect(items[0].source).toBe('web_search');
  });

  it('records why each rejected listing was dropped in the run diagnostics', async () => {
    enableAi();
    await updateSettings({
      search: { sources: { arbeitnow: false, remotive: false, mock: false, web_search: true } },
      sources: {
        arbeitnow: { enabled: false },
        remotive: { enabled: false },
        mock: { enabled: false },
        web_search: { enabled: true },
      },
    });
    // The extractor returns a vacancy whose text makes German mandatory, so the language rule
    // rejects it and the rejection is counted under its rule name.
    stubWeb({
      ...EXTRACTION,
      description:
        'Build TypeScript services. Sehr gute Deutschkenntnisse (C1) sind zwingend erforderlich fuer die Kommunikation mit Kunden.',
    });

    const result = await runDiscovery({ trigger: 'manual' });
    const [source] = result.sources;
    expect(source!.source).toBe('web_search');
    // Both fetched result pages return the same German-mandatory extraction, so both are rejected.
    expect(source!.found).toBe(2);
    expect(source!.created).toBe(0);
    expect(source!.filtered).toBe(2);
    expect(source!.rejectionReasons.language_excluded).toBe(2);
  });
});
