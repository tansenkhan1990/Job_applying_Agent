import { env } from '../../../config/env.js';
import { logger } from '../../../utils/logger.js';
import { normalizePhdListing, type RawPhdListing } from '../normalize.js';
import type { PhdSourceAdapter } from '../types.js';

/**
 * Generic adapter for a permitted JSON feed. The feed must expose an array (or an object with
 * `positions`/`items`) of objects using the documented field names. It is disabled until
 * PHD_FEED_URL is configured; no HTML scraping or pagination bypass is attempted.
 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asDate(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function mapItem(item: Record<string, unknown>): RawPhdListing | null {
  const url = asString(item.url) || asString(item.applicationUrl);
  const title = asString(item.title);
  const institution = asString(item.institution) || asString(item.university);
  if (!url || !title || !institution) return null;

  return {
    source: 'phd_feed',
    sourceJobId:
      asString(item.id) ||
      asString(item.sourceJobId) ||
      asString(item.url).slice(0, 120),
    sourceLabel: env.PHD_FEED_LABEL,
    simulated: false,
    url,
    applicationUrl: asString(item.applicationUrl),
    institution,
    title,
    researchGroup: asString(item.researchGroup) || asString(item.group),
    supervisor: asString(item.supervisor),
    department: asString(item.department),
    location: asString(item.location),
    country: asString(item.country),
    workArrangement: ['remote', 'hybrid', 'onsite'].includes(asString(item.workArrangement))
      ? (item.workArrangement as RawPhdListing['workArrangement'])
      : 'unknown',
    remoteEligibleFromGermany:
      typeof item.remoteEligibleFromGermany === 'boolean' ? item.remoteEligibleFromGermany : null,
    researchTopic: asString(item.researchTopic) || asString(item.topic),
    description: asString(item.description),
    requiredQualifications: asStringArray(item.requiredQualifications),
    requiredSkills: asStringArray(item.requiredSkills),
    preferredSkills: asStringArray(item.preferredSkills),
    requiredLanguages: asStringArray(item.requiredLanguages),
    funding: asString(item.funding),
    salary: asString(item.salary),
    employmentRequirements: asStringArray(item.employmentRequirements),
    postedAt: asDate(item.postedAt),
    applicationDeadline: asDate(item.applicationDeadline) || asDate(item.deadline),
    deadlineTimezone:
      asString(item.deadlineTimezone) || asString(item.timezone) || asString(item.deadlineTz),
    closed: item.closed === true || item.status === 'closed' || item.status === 'filled',
    expectedStartDate: asString(item.expectedStartDate),
  };
}

async function fetchFeedListings(maxPositions: number) {
  if (!env.PHD_FEED_URL.trim()) return [];
  const url = new URL(env.PHD_FEED_URL);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('PHD_FEED_URL must use http or https.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'PersonalJobAgent/1.0 (local use)' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`PhD feed returned HTTP ${response.status}.`);
    }
    const payload = (await response.json()) as unknown;
    const items = Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object'
        ? (
            (payload as { positions?: unknown[]; items?: unknown[] }).positions ??
            (payload as { items?: unknown[] }).items ??
            []
          )
        : [];
    const listings = items
      .slice(0, maxPositions)
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map(mapItem)
      .filter((item): item is RawPhdListing => item !== null)
      .map((item) => normalizePhdListing(item))
      .filter((item): item is NonNullable<typeof item> => item !== null);

    logger.info({ found: listings.length }, 'PhD feed fetched');
    return listings;
  } finally {
    clearTimeout(timer);
  }
}

export const phdFeedAdapter: PhdSourceAdapter = {
  id: 'phd_feed',
  label: 'Configured PhD feed',
  description:
    'Reads a permitted JSON feed configured with PHD_FEED_URL. No scraping, no pagination bypass. Disabled until configured.',
  simulated: false,
  isConfigured: () => Boolean(env.PHD_FEED_URL.trim()),
  searchPositions: ({ maxPositions }) => fetchFeedListings(maxPositions),
  async getPosition(sourceJobId) {
    const listings = await fetchFeedListings(500);
    return listings.find((listing) => listing.sourceJobId === sourceJobId) ?? null;
  },
};
