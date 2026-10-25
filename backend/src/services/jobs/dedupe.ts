import type { Types } from 'mongoose';
import { JobModel } from '../../models/Job.js';
import { logger } from '../../utils/logger.js';
import { contentHash, jobFingerprint } from './normalize.js';
import type { JobListing } from './types.js';

export interface UpsertResult {
  created: number;
  updated: number;
  duplicates: number;
  jobIds: Types.ObjectId[];
}

function jobFields(listing: JobListing) {
  return {
    source: listing.source,
    sourceJobId: listing.sourceJobId,
    sourceLabel: listing.sourceLabel,
    url: listing.url,
    canonicalUrl: listing.canonicalUrl,
    applicationUrl: listing.applicationUrl,
    employer: listing.employer,
    title: listing.title,
    location: listing.location,
    country: listing.country,
    remote: listing.remote,
    workArrangement: listing.workArrangement,
    employmentType: listing.employmentType,
    salary: listing.salary,
    tags: listing.tags,
    description: listing.description,
    descriptionHtml: listing.descriptionHtml ?? '',
    postedAt: listing.postedAt,
    expiresAt: listing.expiresAt,
    languageRequirement: listing.languageRequirement,
    seniority: listing.seniority,
    fingerprint: jobFingerprint(listing.employer, listing.title, listing.location),
    contentHash: contentHash(listing),
  };
}

export async function upsertJobListings(
  listings: JobListing[],
  options: { searchRunId?: Types.ObjectId | null } = {},
): Promise<UpsertResult> {
  const result: UpsertResult = { created: 0, updated: 0, duplicates: 0, jobIds: [] };
  const seen = new Set<string>();

  for (const listing of listings) {
    const key = `${listing.source}:${listing.sourceJobId}`;
    if (seen.has(key)) {
      result.duplicates += 1;
      continue;
    }
    seen.add(key);

    const fields = jobFields(listing);
    const fingerprintWindow = new Date(Date.now() - 60 * 86_400_000);

    let existing = await JobModel.findOne({
      $or: [
        { source: listing.source, sourceJobId: listing.sourceJobId },
        { canonicalUrl: listing.canonicalUrl },
        {
          fingerprint: fields.fingerprint,
          discoveredAt: { $gte: fingerprintWindow },
          status: { $ne: 'duplicate' },
        },
      ],
    });

    if (existing) {
      const sameSource =
        existing.source === listing.source && existing.sourceJobId === listing.sourceJobId;
      if (!sameSource) {
        result.duplicates += 1;
        await JobModel.updateOne(
          { _id: existing._id },
          {
            $set: { lastVerifiedAt: new Date() },
            $addToSet: { mergedSources: listing.source },
          },
        );
        result.jobIds.push(existing._id);
        continue;
      }

      const changed = existing.contentHash !== fields.contentHash;
      const expiresAt = listing.expiresAt;
      await JobModel.updateOne(
        { _id: existing._id },
        {
          $set: {
            ...fields,
            lastVerifiedAt: new Date(),
            status:
              expiresAt && expiresAt.getTime() < Date.now()
                ? 'expired'
                : existing.status === 'unavailable' || existing.status === 'expired'
                  ? 'active'
                  : existing.status,
            ...(changed ? { statusNote: '' } : {}),
          },
        },
      );
      result.updated += 1;
      result.jobIds.push(existing._id);
      continue;
    }

    try {
      const created = await JobModel.create({
        ...fields,
        discoveredAt: new Date(),
        lastVerifiedAt: new Date(),
        status: listing.expiresAt && listing.expiresAt.getTime() < Date.now() ? 'expired' : 'active',
        searchRunId: options.searchRunId ?? null,
        mergedSources: [],
      });
      result.created += 1;
      result.jobIds.push(created._id);
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as { code?: number }).code === 11000) {
        const raced = await JobModel.findOne({
          $or: [
            { source: listing.source, sourceJobId: listing.sourceJobId },
            { canonicalUrl: listing.canonicalUrl },
          ],
        });
        if (raced) {
          result.duplicates += 1;
          result.jobIds.push(raced._id);
          continue;
        }
      }
      logger.error(
        { source: listing.source, error: error instanceof Error ? error.message : 'unknown' },
        'Failed to persist job listing',
      );
      throw error;
    }
  }

  return result;
}
