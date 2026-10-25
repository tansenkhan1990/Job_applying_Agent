import { logger } from '../../../utils/logger.js';
import { stripHtml } from '../../../utils/text.js';
import { detectCountry, normalizeListing } from '../normalize.js';
import type { JobListing, JobSearchCriteria, JobSourceAdapter } from '../types.js';

/**
 * Remotive public remote-jobs API.
 * Docs: https://remotive.com/api/remote-jobs
 * The API asks for attribution, sensible limits and no abuse: we make one
 * request per run, request at most 50 jobs, and store results for the UI.
 */
const API_URL = 'https://remotive.com/api/remote-jobs';

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  category: string;
  tags: string[];
  job_type: string;
  publication_date: string;
  candidate_required_location: string;
  salary: string;
  description: string;
}

function parseDate(value: string): Date | null {
  if (!value) return null;
  const normalized = /Z$|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function mapJob(item: RemotiveJob): JobListing {
  const location = item.candidate_required_location || 'Remote';
  return normalizeListing({
    source: 'remotive',
    sourceJobId: String(item.id),
    sourceLabel: 'Remotive',
    url: item.url,
    applicationUrl: item.url,
    employer: item.company_name,
    title: item.title,
    location,
    country: detectCountry(location),
    remote: true,
    workArrangement: 'remote',
    employmentType: item.job_type ?? '',
    salary: item.salary ?? '',
    tags: [item.category, ...(item.tags ?? [])].filter(Boolean).slice(0, 20),
    descriptionHtml: item.description,
    description: stripHtml(item.description ?? ''),
    postedAt: parseDate(item.publication_date),
    expiresAt: null,
  });
}

export const remotiveAdapter: JobSourceAdapter = {
  id: 'remotive',
  label: 'Remotive',
  description:
    'Public remote-job API with worldwide and EU-remote roles. One bounded request per run, with attribution to Remotive.',
  requiresConfiguration: false,
  isConfigured: () => true,

  async searchJobs(criteria: JobSearchCriteria): Promise<JobListing[]> {
    const keyword =
      criteria.includeKeywords[0] ??
      (criteria.targetTitles.length > 0 ? 'engineer' : 'developer');
    const params = new URLSearchParams({ limit: '50', search: keyword });
    const response = await fetch(`${API_URL}?${params.toString()}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'PersonalJobAgent/1.0 (local personal job search)',
      },
      signal: AbortSignal.timeout(25_000),
    });
    if (response.status === 429) throw new Error('Remotive rate limit reached (HTTP 429)');
    if (!response.ok) throw new Error(`Remotive API returned HTTP ${response.status}`);

    const json = (await response.json()) as { jobs?: RemotiveJob[] };
    const listings = (json.jobs ?? [])
      .filter((item) => item.id && item.url && item.title && item.company_name)
      .map(mapJob);

    logger.info({ source: 'remotive', fetched: listings.length }, 'Remotive search complete');
    return listings;
  },

  async getJobDetails(): Promise<JobListing | null> {
    // The API has no per-id endpoint; details are stored during discovery.
    return null;
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
        evidence: `Availability check failed: ${error instanceof Error ? error.message : 'unknown'}`,
      };
    }
  },
};
