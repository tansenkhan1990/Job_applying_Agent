import { logger } from '../../../utils/logger.js';
import { normalizeForMatch, stripHtml } from '../../../utils/text.js';
import { detectCountry, normalizeListing } from '../normalize.js';
import { sortByAgePriority } from '../age.js';
import { titleRelevance } from '../filters.js';
import type { JobListing, JobSearchCriteria, JobSourceAdapter } from '../types.js';

/**
 * Arbeitnow public job-board API (Germany-focused).
 * Docs: https://www.arbeitnow.com/blog/job-board-api
 * Terms: free public API, do not abuse, link back to the site.
 * We poll at most 2 pages per run and keep the original listing URL.
 */
const API_URL = 'https://www.arbeitnow.com/api/job-board-api';

interface ArbeitnowJob {
  slug: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  url: string;
  tags: string[];
  job_types: string[];
  location: string;
  created_at: number;
}

async function fetchPage(page: number): Promise<{ data: ArbeitnowJob[]; next: string | null }> {
  const response = await fetch(`${API_URL}?page=${page}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'PersonalJobAgent/1.0 (local personal job search)',
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (response.status === 429) throw new Error('Arbeitnow rate limit reached (HTTP 429)');
  if (!response.ok) throw new Error(`Arbeitnow API returned HTTP ${response.status}`);
  const json = (await response.json()) as {
    data?: ArbeitnowJob[];
    links?: { next?: string | null };
  };
  return { data: json.data ?? [], next: json.links?.next ?? null };
}

function mapJob(item: ArbeitnowJob): JobListing {
  const location = (item.location ?? '').trim() || (item.remote ? 'Remote' : '');
  const listing = normalizeListing({
    source: 'arbeitnow',
    sourceJobId: item.slug,
    sourceLabel: 'Arbeitnow',
    url: item.url,
    applicationUrl: item.url,
    employer: item.company_name,
    title: item.title,
    location,
    country: detectCountry(location),
    remote: Boolean(item.remote),
    employmentType: (item.job_types ?? []).join(', '),
    salary: '',
    tags: [...(item.tags ?? []), ...(item.job_types ?? [])].slice(0, 20),
    descriptionHtml: item.description,
    description: stripHtml(item.description ?? ''),
    postedAt: item.created_at ? new Date(item.created_at * 1000) : null,
    expiresAt: null,
  });
  return listing;
}

export const arbeitnowAdapter: JobSourceAdapter = {
  id: 'arbeitnow',
  label: 'Arbeitnow',
  description:
    'Free public job-board API focused on Germany. Search is limited to the latest pages per run; results link back to Arbeitnow.',
  requiresConfiguration: false,
  isConfigured: () => true,

  async searchJobs(criteria: JobSearchCriteria): Promise<JobListing[]> {
    // The public feed is newest-first and only postings inside the calendar-month window
    // are kept, so one or two bounded pages are enough.
    const maxPages = Math.min(2, Math.max(1, Math.ceil(criteria.maxJobs / 50)));
    const listings: JobListing[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= maxPages; page += 1) {
      const { data } = await fetchPage(page);
      for (const item of data) {
        if (!item.slug || !item.url || !item.company_name || !item.title) continue;
        if (seen.has(item.slug)) continue;

        if (criteria.targetTitles.length > 0 && criteria.includeKeywords.length === 0) {
          const relevant = titleRelevance(item.title, criteria.targetTitles);
          if (relevant === 0) continue;
        }
        if (criteria.includeKeywords.length > 0) {
          const text = normalizeForMatch(`${item.title} ${item.description}`);
          if (!criteria.includeKeywords.some((keyword) => text.includes(normalizeForMatch(keyword)))) {
            continue;
          }
        }

        seen.add(item.slug);
        listings.push(mapJob(item));
        if (listings.length >= criteria.maxJobs * 20) break;
      }
      if (listings.length >= criteria.maxJobs * 20) break;
      if (data.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    logger.info({ source: 'arbeitnow', fetched: listings.length, pages: maxPages }, 'Arbeitnow search complete');
    return sortByAgePriority(listings);
  },

  async getJobDetails(sourceJobId: string): Promise<JobListing | null> {
    // The public API has no per-job endpoint. The stored listing remains authoritative.
    const { data } = await fetchPage(1);
    const found = data.find((item) => item.slug === sourceJobId);
    return found ? mapJob(found) : null;
  },

  async verifyJob(listing) {
    try {
      const response = await fetch(listing.url, {
        method: 'GET',
        headers: { 'User-Agent': 'PersonalJobAgent/1.0 (local personal job search)' },
        signal: AbortSignal.timeout(10_000),
        redirect: 'follow',
      });
      if (response.status === 404 || response.status === 410) {
        return { status: 'unavailable', evidence: `HTTP ${response.status} from listing URL` };
      }
      if (response.ok) {
        return { status: 'available', evidence: `HTTP ${response.status} from listing URL` };
      }
      return { status: 'unknown', evidence: `HTTP ${response.status} from listing URL` };
    } catch (error) {
      return {
        status: 'unknown',
        evidence: `Availability check failed: ${error instanceof Error ? error.message : 'unknown'}`
      };
    }
  },
};
