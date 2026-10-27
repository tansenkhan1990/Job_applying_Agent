import { z } from 'zod';
import { env } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';
import {
  decodeHtmlEntities,
  stripHtml,
  truncate,
  uniqueStrings,
} from '../../../utils/text.js';
import { completeStructured } from '../../ai/client.js';
import { jobPostingExtractionPrompt } from '../../ai/prompts.js';
import { getSettings, resolveModel } from '../../settingsService.js';
import { normalizeListing } from '../normalize.js';
import { sortByAgePriority } from '../age.js';
import type { JobListing, JobSearchCriteria, JobSourceAdapter } from '../types.js';

/**
 * Open-web job source: a DuckDuckGo search built from the candidate's own target titles and
 * keywords, followed by fetching each candidate page and letting the configured AI model turn
 * it into one structured vacancy.
 *
 * Why a search engine instead of another board: boards only ever expose their own inventory, so
 * a run that reads two boards can only ever find those two boards' jobs. Searching the open web
 * reaches company career pages, ATS pages and smaller boards that no feed aggregates.
 *
 * Politeness: no credentials are used, queries are sequential with a delay between them, page
 * fetches are capped per run, the crawler honours the page's own robots-hostile signals by only
 * fetching search results once, and nothing is republished — each listing links to its origin.
 */

const SOURCE_ID = 'web_search';
const SOURCE_LABEL = 'Web search (DuckDuckGo)';
const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const HITS_PER_QUERY = 10;
const MAX_PAGE_BYTES = 600_000;
const PAGE_TEXT_CHARS = 12_000;
const MIN_DESCRIPTION_CHARS = 200;
const MIN_CONFIDENCE = 0.4;
/** DuckDuckGo challenges automated clients quickly, so queries are few and well spaced. */
const SEARCH_DELAY_MS = 5_000;
const PAGE_DELAY_MS = 500;

/**
 * Applicant-tracking-system hosts. Each URL there is exactly one advertised vacancy, which is
 * what this source needs: a plain "<title> jobs <country>" query returns aggregator *index*
 * pages (Stepstone, Jooble, Indeed, Glassdoor) that no amount of extraction can turn into a
 * single job. Operands rotate across queries so one run still covers several systems.
 */
const ATS_HOSTS = [
  'jobs.lever.co',
  'job-boards.greenhouse.io',
  'jobs.ashbyhq.com',
  'apply.workable.com',
  'jobs.smartrecruiters.com',
  'jobs.personio.de',
  'join.com',
  'recruitee.com',
];

/**
 * Search-result and listing-index domains. Their pages are indexes of many vacancies, so the
 * extractor would reject them after paying for a model call; excluding them keeps the results
 * on real postings on company career pages.
 */
const AGGREGATOR_EXCLUSIONS = [
  'stepstone.de',
  'jooble.org',
  'indeed.com',
  'glassdoor.com',
  'linkedin.com',
  'xing.com',
  'englishjobsingermany.com',
  'nextraise.ai',
  'stellenanzeigen.de',
  'jobrapido.com',
  'jobs.de',
  'karriere.de',
  'jobware.de',
  'kimeta.de',
  'meinestadt.de',
];

/**
 * Hosts that never yield a usable vacancy in a bounded fetch: login-walled networks, bot-hostile
 * aggregators and general media. Skipping them saves requests and AI calls.
 */
const BLOCKED_HOST_PATTERNS = [
  /(^|\.)linkedin\.com$/,
  /(^|\.)xing\.com$/,
  /(^|\.)glassdoor\./,
  /(^|\.)indeed\./,
  /(^|\.)stepstone\./,
  /(^|\.)facebook\.com$/,
  /(^|\.)instagram\.com$/,
  /(^|\.)pinterest\./,
  /(^|\.)tiktok\.com$/,
  /(^|\.)youtube\.com$/,
  /(^|\.)wikipedia\.org$/,
  /(^|\.)duckduckgo\.com$/,
  /(^|\.)google\./,
];

const JOB_HOST_HINTS = [
  'job',
  'career',
  'karriere',
  'stelle',
  'bewerb',
  'apply',
  'hiring',
  'talent',
  'greenhouse',
  'lever',
  'workday',
  'smartrecruiters',
  'recruitee',
  'personio',
  'ashby',
  'workable',
  'join',
];

/** Paths that are listings of many vacancies rather than one posting. */
const INDEX_PATH_PATTERNS = [
  /\/(?:jobs?|stellenangebote|careers?|vacancies)\/?$/i,
  /\/(?:q|search|jobs\/search|suche)[-\/]/i,
  /\/jobs-in[-\/]/i,
  /\/stellenangebote[-\/]/i,
];

const JOB_PATH_HINTS = [
  '/job',
  '/jobs',
  '/career',
  '/stellen',
  '/stelle',
  '/position',
  '/vacanc',
  '/apply',
  '/karriere',
  '/bewerb',
];

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}

const extractionSchema = z.object({
  isJobPosting: z.boolean(),
  title: z.string().max(300),
  employer: z.string().max(200),
  location: z.string().max(200),
  remote: z.boolean(),
  workArrangement: z.enum(['remote', 'hybrid', 'onsite', 'unknown']),
  employmentType: z.string().max(120),
  salary: z.string().max(200),
  tags: z.array(z.string().max(60)).max(20),
  description: z.string().max(6_000),
  postedAt: z.string().max(40),
  expiresAt: z.string().max(40),
  applicationUrl: z.string().max(600),
  confidence: z.number().min(0).max(1),
});

type Extraction = z.infer<typeof extractionSchema>;

function delay(ms: number): Promise<void> {
  // Tests stub fetch and must not wait on crawler politeness timers.
  return env.isTest ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

const ATS_HOSTS_PER_QUERY = 4;

/**
 * Target titles arrive as the concatenated title lists of every enabled profile, so taking the
 * first N would search one profile only. Sampling evenly across the list means a small query
 * budget still covers every profile (three profiles of seven titles and three queries search
 * the first title of each profile).
 */
function sampleEvenly<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const picked: T[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = items[Math.floor((index * items.length) / count)];
    if (item !== undefined && !picked.includes(item)) picked.push(item);
  }
  return picked;
}

function atsClause(queryIndex: number): string {
  const start = (((queryIndex - (queryIndex % 2)) / 2) * ATS_HOSTS_PER_QUERY) % ATS_HOSTS.length;
  const hosts = Array.from(
    { length: ATS_HOSTS_PER_QUERY },
    (_, offset) => ATS_HOSTS[(start + offset) % ATS_HOSTS.length]!,
  );
  return `(${hosts.map((host) => `site:${host}`).join(' OR ')})`;
}

/**
 * Queries are the candidate's own target titles, so a run searches for the roles they actually
 * want instead of one generic keyword. Extra include-keywords (skills) are appended to keep the
 * engine focused on the candidate's stack.
 *
 * Queries alternate between two shapes, because a single shape cannot reach both halves of the
 * market: an ATS-scoped query returns individual vacancies (one posting per URL, which is what
 * the extractor needs), while an open-web query with the aggregator index pages excluded
 * reaches company career pages that no ATS hosts.
 */
export function buildSearchQueries(criteria: JobSearchCriteria, maxQueries: number): string[] {
  const titles = uniqueStrings(criteria.targetTitles);
  const keywords = uniqueStrings(criteria.includeKeywords);
  const terms = titles.length > 0 ? titles : keywords;
  const effectiveTerms = sampleEvenly(
    terms.length > 0 ? terms : ['software engineer'],
    Math.max(1, maxQueries),
  );
  const location = locationTerm(criteria);
  // Skills rotate across queries (two per query) so each query carries a different slice of the
  // candidate's CV stack instead of the same two keywords every time.
  const skillPool = uniqueStrings([...keywords, ...(criteria.profileSkills ?? [])]);
  const useSkills = titles.length > 0 && skillPool.length > 0;
  const exclusions = AGGREGATOR_EXCLUSIONS.map((host) => `-site:${host}`).join(' ');

  return effectiveTerms
    .map((term, index) => {
      const parts = [`"${term}"`];
      if (useSkills) {
        const start = (index * 2) % skillPool.length;
        const picked = Array.from({ length: Math.min(2, skillPool.length) }, (_, offset) => skillPool[(start + offset) % skillPool.length]!);
        parts.push(picked.join(' '));
      }
      if (location) parts.push(location);
      parts.push(index % 2 === 0 ? atsClause(index) : `jobs ${exclusions}`);
      return parts.join(' ');
    })
    .slice(0, Math.max(1, maxQueries));
}

function locationTerm(criteria: JobSearchCriteria): string {
  const countries = uniqueStrings(criteria.countries);
  if (countries.length > 0) return countries[0]!;
  return criteria.workArrangements.includes('remote') || criteria.remoteScope.length > 0
    ? 'remote'
    : '';
}

function isBlockedHost(hostname: string): boolean {
  return BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

/**
 * DuckDuckGo links most results through its own redirector. Unwrap `uddg`, then keep only real
 * http(s) destinations so the crawler never follows an ad or an internal page.
 */
export function decodeResultUrl(href: string): string {
  const trimmed = decodeHtmlEntities(href ?? '').trim();
  if (!trimmed) return '';
  const absolute = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
  try {
    const wrapper = new URL(absolute, 'https://duckduckgo.com');
    const target = wrapper.searchParams.get('uddg');
    if (target) {
      const unwrapped = new URL(target);
      if (unwrapped.protocol !== 'http:' && unwrapped.protocol !== 'https:') return '';
      if (isBlockedHost(unwrapped.hostname)) return '';
      return unwrapped.toString();
    }
    if (wrapper.hostname.endsWith('duckduckgo.com')) return '';
    if (wrapper.protocol !== 'http:' && wrapper.protocol !== 'https:') return '';
    if (isBlockedHost(wrapper.hostname)) return '';
    return wrapper.toString();
  } catch {
    return '';
  }
}

const RESULT_ANCHOR = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
const RESULT_ANCHOR_OPEN = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>/i;
const RESULT_SNIPPET =
  /<(?:a|div|span|td)\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span|td)>/i;
const HREF_ATTR = /href="([^"]*)"/i;

/**
 * Parse the DuckDuckGo HTML endpoint. Each result is an anchor carrying `result__a`; the snippet
 * that belongs to it is the next `result__snippet` element before the following result anchor.
 */
export function parseDuckDuckGoResults(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  RESULT_ANCHOR.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = RESULT_ANCHOR.exec(html)) !== null && hits.length < limit) {
    const tag = match[0];
    const url = decodeResultUrl(HREF_ATTR.exec(tag)?.[1] ?? '');
    if (!url || seen.has(url)) continue;

    const rest = html.slice(match.index + tag.length);
    const nextStart = rest.search(RESULT_ANCHOR_OPEN);
    const block = nextStart === -1 ? rest : rest.slice(0, nextStart);
    const snippet = RESULT_SNIPPET.exec(block)?.[1] ?? '';

    seen.add(url);
    hits.push({
      url,
      title: stripHtml(match[1]).slice(0, 300),
      snippet: truncate(stripHtml(snippet), 400),
    });
  }

  return hits;
}

/**
 * DuckDuckGo answers automated clients with an HTTP 202 CAPTCHA page ("Unfortunately, bots use
 * DuckDuckGo too"). That is not a transient per-query failure: the remaining queries would hit
 * the same wall, so the source stops instead of hammering the endpoint.
 */
class SearchChallengeError extends Error {
  constructor() {
    super(
      'DuckDuckGo served its bot check (CAPTCHA) instead of results. Wait a while before running discovery again, and keep the query count low.',
    );
    this.name = 'SearchChallengeError';
  }
}

const CHALLENGE_BODY = /unusual traffic|captcha|select all squares|anomaly/i;

async function duckDuckGoSearch(query: string): Promise<SearchHit[]> {
  const response = await fetch(SEARCH_ENDPOINT, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9,de;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ q: query, kl: 'wt-wt' }).toString(),
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 202) throw new SearchChallengeError();
  if (!response.ok) {
    throw new Error(`DuckDuckGo search returned HTTP ${response.status}`);
  }
  const html = await response.text();
  const hits = parseDuckDuckGoResults(html, HITS_PER_QUERY);
  if (hits.length === 0 && CHALLENGE_BODY.test(html)) throw new SearchChallengeError();
  return hits;
}

/** Strip chrome from a page so the model sees the posting text, not navigation and scripts. */
export function extractPageText(html: string): string {
  const reduced = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  return truncate(stripHtml(reduced), PAGE_TEXT_CHARS);
}

interface FetchedPage {
  url: string;
  title: string;
  text: string;
}

async function fetchPage(url: string): Promise<FetchedPage | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,de;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) return null;

    const html = (await response.text()).slice(0, MAX_PAGE_BYTES);
    const text = extractPageText(html);
    if (text.length < MIN_DESCRIPTION_CHARS) return null;
    const title = stripHtml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').slice(0, 300);
    return { url, title, text };
  } catch (error) {
    logger.debug(
      { url, error: error instanceof Error ? error.message : 'unknown' },
      'Web search page fetch failed',
    );
    return null;
  }
}

/**
 * Prefer results that are one advertised vacancy, and push index pages to the back so the
 * bounded page budget is spent on postings the extractor can actually read.
 */
function rankCandidates(hits: SearchHit[]): SearchHit[] {
  const score = (hit: SearchHit) => {
    let host = '';
    let path = '';
    try {
      const url = new URL(hit.url);
      host = url.hostname.toLowerCase();
      path = url.pathname.toLowerCase();
    } catch {
      return 0;
    }
    let value = 0;
    if (ATS_HOSTS.some((ats) => host === ats || host.endsWith(`.${ats}`))) value += 4;
    if (JOB_HOST_HINTS.some((hint) => host.includes(hint))) value += 2;
    if (JOB_PATH_HINTS.some((hint) => path.includes(hint))) value += 2;
    if (/\/(?:job|position|vacanc|stelle)[^/]*\d/i.test(path)) value += 1;
    if (INDEX_PATH_PATTERNS.some((pattern) => pattern.test(path))) value -= 3;
    return value;
  };
  return [...hits].sort((a, b) => score(b) - score(a));
}

function parseDate(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

/** A page that claims a publication date in the future is a parsing mistake, not a fresh job. */
function parsePostedAt(value: string): Date | null {
  const date = parseDate(value);
  if (!date) return null;
  return date.getTime() > Date.now() + 86_400_000 ? null : date;
}

function toListing(extraction: Extraction, page: FetchedPage): JobListing {
  const location = extraction.location.trim() || (extraction.remote ? 'Remote' : '');
  return normalizeListing({
    source: SOURCE_ID,
    sourceJobId: page.url,
    sourceLabel: SOURCE_LABEL,
    url: page.url,
    applicationUrl: extraction.applicationUrl.trim(),
    employer: extraction.employer,
    title: extraction.title,
    location,
    remote: extraction.remote,
    workArrangement: extraction.workArrangement === 'unknown' ? undefined : extraction.workArrangement,
    employmentType: extraction.employmentType,
    salary: extraction.salary,
    tags: uniqueStrings(extraction.tags).slice(0, 20),
    description: extraction.description,
    postedAt: parsePostedAt(extraction.postedAt),
    expiresAt: parseDate(extraction.expiresAt),
  });
}

export const webSearchAdapter: JobSourceAdapter = {
  id: SOURCE_ID,
  label: SOURCE_LABEL,
  description:
    'Searches the open web with DuckDuckGo using your target titles, then reads each result page and extracts the vacancy with your configured AI model. Reaches company career pages and boards that no feed covers.',
  requiresConfiguration: true,
  note: 'Searches the open web with DuckDuckGo and extracts details with your AI model. Requires OPENROUTER_API_KEY.',
  // The extraction step is what turns a page into a record, so without an AI key this source
  // cannot produce listings at all.
  isConfigured: () => env.aiConfigured,

  async searchJobs(criteria: JobSearchCriteria): Promise<JobListing[]> {
    const settings = await getSettings();
    const model = resolveModel(settings);
    if (!model) {
      throw new Error('No AI model is configured. Choose one in Settings to use web search.');
    }

    const queries = buildSearchQueries(criteria, env.JOB_WEB_SEARCH_MAX_QUERIES);
    const pageBudget = Math.max(1, Math.min(env.JOB_WEB_SEARCH_MAX_PAGES, criteria.maxJobs));

    const collected: SearchHit[] = [];
    const seen = new Set<string>();
    let lastSearchError = '';

    for (const [index, query] of queries.entries()) {
      try {
        const hits = await duckDuckGoSearch(query);
        for (const hit of hits) {
          if (seen.has(hit.url)) continue;
          seen.add(hit.url);
          collected.push(hit);
        }
      } catch (error) {
        lastSearchError = error instanceof Error ? error.message : 'Web search failed';
        logger.warn({ query, error: lastSearchError }, 'Web search query failed');
        // A challenge blocks every later query too, so stop instead of tripping it again.
        if (error instanceof SearchChallengeError) break;
      }
      if (index < queries.length - 1) await delay(SEARCH_DELAY_MS);
    }

    if (collected.length === 0) {
      if (lastSearchError) throw new Error(lastSearchError);
      return [];
    }

    const candidates = rankCandidates(collected).slice(0, pageBudget);
    const listings: JobListing[] = [];
    let pagesRead = 0;
    let rejected = 0;

    for (const [index, hit] of candidates.entries()) {
      if (listings.length >= criteria.maxJobs) break;
      const page = await fetchPage(hit.url);
      if (!page) {
        rejected += 1;
        if (index < candidates.length - 1) await delay(PAGE_DELAY_MS);
        continue;
      }
      pagesRead += 1;

      try {
        const { system, user } = jobPostingExtractionPrompt({
          pageUrl: page.url,
          pageTitle: page.title,
          pageText: page.text,
          targetTitles: criteria.targetTitles,
        });
        const { data } = await completeStructured({
          model,
          task: 'job-page-extraction',
          system,
          user,
          schema: extractionSchema,
          temperature: settings.ai.temperature,
          maxTokens: settings.ai.maxOutputTokens,
        });

        if (
          data.isJobPosting &&
          data.confidence >= MIN_CONFIDENCE &&
          data.title.trim() &&
          data.employer.trim()
        ) {
          listings.push(toListing(data, page));
        } else {
          rejected += 1;
        }
      } catch (error) {
        // One unreadable or refused page must not fail the source: the remaining candidates are
        // still worth reading, and the run summary reports the shortfall.
        rejected += 1;
        logger.warn(
          { url: page.url, error: error instanceof Error ? error.message : 'unknown' },
          'Web search page extraction failed',
        );
      }

      if (index < candidates.length - 1) await delay(PAGE_DELAY_MS);
    }

    logger.info(
      {
        source: SOURCE_ID,
        queries: queries.length,
        results: collected.length,
        pagesRead,
        listings: listings.length,
        rejected,
      },
      'Web search complete',
    );

    return sortByAgePriority(listings);
  },
};
