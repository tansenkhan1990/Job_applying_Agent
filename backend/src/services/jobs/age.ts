export type AgeEligibility = 'Eligible' | 'Too Recent' | 'Unknown' | 'Expired';

export interface JobAgeAssessment {
  ageEligibility: AgeEligibility;
  /** Earliest posting date still accepted. Postings on or before this date are too old. */
  eligibleAfter: Date | null;
  ageCheckAt: Date;
  ageReason: string;
}

/** Postings this many calendar months old (or older) are excluded. */
export const MAX_JOB_AGE_MONTHS = 3;

export function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
}

/**
 * Adds calendar months, clamping the day to the end of the target month.
 * Example: Jan 31 + 1 month = Feb 28 (or Feb 29 in a leap year).
 */
export function addCalendarMonths(date: Date, months: number): Date {
  const target = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + months,
      1,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
  const lastDayOfMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDayOfMonth));
  return target;
}

function formatDate(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : 'unknown';
}

/**
 * Determines whether a vacancy is recent enough to be shown and applied to.
 * Uses the original posting date only. `firstSeenAt`/`discoveredAt` are never used as a
 * substitute: an unknown original date stays Unknown and cannot be auto-applied to.
 *
 * The comparison is date-based in UTC: on 25 October 2026 the cutoff is 25 July 2026, so
 * a job posted on 25 July is already three calendar months old and is excluded, while a
 * job posted on 26 July is still eligible. No fixed 90-day arithmetic is used.
 */
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a source-provided calendar date (YYYY-MM-DD) as a UTC-anchored calendar day. */
export function parseLocalCalendarDate(value: string | null | undefined): Date | null {
  if (!value || !LOCAL_DATE_PATTERN.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed;
}

/** The earliest posting date that is still inside the allowed window. */
export function jobAgeCutoff(months = MAX_JOB_AGE_MONTHS, now = new Date()): Date {
  return addCalendarMonths(startOfUtcDay(now), -months);
}

export function assessJobAge(input: {
  postedAt: Date | null | undefined;
  /** The job's local posting date, used instead of the UTC day when the source provides it. */
  postedLocalDate?: string | null;
  expiresAt?: Date | null;
  status?: string | null;
  now?: Date;
  months?: number;
}): JobAgeAssessment {
  const now = input.now ?? new Date();
  const ageCheckAt = now;
  const months = input.months ?? MAX_JOB_AGE_MONTHS;

  const expiredByDate = Boolean(input.expiresAt && input.expiresAt.getTime() < now.getTime());
  const expiredByStatus = input.status === 'expired' || input.status === 'unavailable';
  if (expiredByDate || expiredByStatus) {
    return {
      ageEligibility: 'Expired',
      eligibleAfter: null,
      ageCheckAt,
      ageReason: expiredByDate
        ? `The posting expired on ${formatDate(input.expiresAt ?? null)}.`
        : 'The listing is marked expired or unavailable.',
    };
  }

  if (!input.postedAt) {
    return {
      ageEligibility: 'Unknown',
      eligibleAfter: null,
      ageCheckAt,
      ageReason:
        'The original posting date is unknown. First-seen and discovery dates are not accepted as evidence; this job cannot be applied to automatically.',
    };
  }

  const postedDay = parseLocalCalendarDate(input.postedLocalDate) ?? startOfUtcDay(input.postedAt);
  const cutoff = jobAgeCutoff(months, now);

  if (postedDay.getTime() <= cutoff.getTime()) {
    return {
      ageEligibility: 'Expired',
      eligibleAfter: cutoff,
      ageCheckAt,
      ageReason: `Posted on ${formatDate(postedDay)}, which is ${months} or more calendar months ago (cutoff ${formatDate(cutoff)}).`,
    };
  }

  return {
    ageEligibility: 'Eligible',
    eligibleAfter: cutoff,
    ageCheckAt,
    ageReason: `Posted on ${formatDate(postedDay)} and less than ${months} calendar months old (cutoff ${formatDate(cutoff)}).`,
  };
}

const AGE_PRIORITY: Record<AgeEligibility, number> = {
  Eligible: 0,
  'Too Recent': 1,
  Unknown: 2,
  Expired: 3,
};

/**
 * Discovery feeds are newest-first. Putting age-eligible postings first lets a bounded run
 * spend its budget on the vacancies that can actually enter the application queue.
 */
export function sortByAgePriority<T extends { ageEligibility: AgeEligibility; postedAt: Date | null }>(
  listings: T[],
): T[] {
  return [...listings].sort((a, b) => {
    const priority = AGE_PRIORITY[a.ageEligibility] - AGE_PRIORITY[b.ageEligibility];
    if (priority !== 0) return priority;
    return (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0);
  });
}
