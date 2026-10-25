import { describe, expect, it } from 'vitest';
import { addCalendarMonths, assessJobAge } from '../src/services/jobs/age.js';

describe('calendar-month job age', () => {
  it('treats a job posted exactly three calendar months ago as eligible', () => {
    const result = assessJobAge({
      postedAt: new Date(Date.UTC(2026, 6, 25, 15, 30)),
      now: new Date(Date.UTC(2026, 9, 25, 8, 0)),
    });
    expect(result.ageEligibility).toBe('Eligible');
    expect(result.eligibleAfter?.toISOString().slice(0, 10)).toBe('2026-10-25');
  });

  it('marks a job posted less than three calendar months ago as Too Recent', () => {
    const result = assessJobAge({
      postedAt: new Date(Date.UTC(2026, 6, 26)),
      now: new Date(Date.UTC(2026, 9, 25)),
    });
    expect(result.ageEligibility).toBe('Too Recent');
    expect(result.eligibleAfter?.toISOString().slice(0, 10)).toBe('2026-10-26');
  });

  it('clamps month-end dates instead of using fixed 90-day arithmetic', () => {
    expect(addCalendarMonths(new Date(Date.UTC(2026, 0, 31)), 1).toISOString().slice(0, 10)).toBe(
      '2026-02-28',
    );
    expect(addCalendarMonths(new Date(Date.UTC(2024, 0, 31)), 1).toISOString().slice(0, 10)).toBe(
      '2024-02-29',
    );
    const result = assessJobAge({
      postedAt: new Date(Date.UTC(2026, 0, 31)),
      now: new Date(Date.UTC(2026, 3, 30)),
    });
    expect(result.ageEligibility).toBe('Eligible');
    expect(result.eligibleAfter?.toISOString().slice(0, 10)).toBe('2026-04-30');

    const oneDayEarly = assessJobAge({
      postedAt: new Date(Date.UTC(2026, 0, 31)),
      now: new Date(Date.UTC(2026, 3, 29)),
    });
    expect(oneDayEarly.ageEligibility).toBe('Too Recent');
  });

  it('never treats an unknown posting date as eligible', () => {
    const result = assessJobAge({ postedAt: null, now: new Date() });
    expect(result.ageEligibility).toBe('Unknown');
    expect(result.eligibleAfter).toBeNull();
    expect(result.ageReason).toMatch(/first-seen/i);
  });

  it('marks expired or unavailable postings as Expired', () => {
    const byDate = assessJobAge({
      postedAt: new Date(Date.UTC(2026, 0, 1)),
      expiresAt: new Date(Date.UTC(2026, 5, 1)),
      now: new Date(Date.UTC(2026, 9, 25)),
    });
    expect(byDate.ageEligibility).toBe('Expired');

    const byStatus = assessJobAge({
      postedAt: new Date(Date.UTC(2026, 0, 1)),
      status: 'unavailable',
      now: new Date(Date.UTC(2026, 9, 25)),
    });
    expect(byStatus.ageEligibility).toBe('Expired');
  });

  it('uses the source local calendar date when one is provided', () => {
    // 2026-07-26T02:00+02:00 is 2026-07-26 locally but 2026-07-26T00:00Z.
    const localDay = assessJobAge({
      postedAt: new Date('2026-07-26T02:00:00+02:00'),
      postedLocalDate: '2026-07-26',
      now: new Date(Date.UTC(2026, 9, 26, 1, 0)),
    });
    expect(localDay.ageEligibility).toBe('Eligible');
    expect(localDay.eligibleAfter?.toISOString().slice(0, 10)).toBe('2026-10-26');

    // A late-evening posting in a negative offset keeps its local day, not the UTC day.
    const previousUtcDay = assessJobAge({
      postedAt: new Date('2026-07-25T22:00:00-05:00'),
      postedLocalDate: '2026-07-25',
      now: new Date(Date.UTC(2026, 9, 25, 12, 0)),
    });
    expect(previousUtcDay.ageEligibility).toBe('Eligible');
  });

  it('does not use discovery or first-seen dates as a substitute', async () => {
    const { normalizeListing } = await import('../src/services/jobs/normalize.js');
    const listing = normalizeListing({
      source: 'test',
      sourceJobId: 'recent-repost',
      sourceLabel: 'Test',
      url: 'https://example.com/recent-repost',
      applicationUrl: '',
      employer: 'Example',
      title: 'Senior Backend Engineer',
      location: 'Berlin',
      remote: false,
      employmentType: 'full-time',
      salary: '',
      tags: [],
      description: 'English working language.',
      postedAt: new Date(),
      expiresAt: null,
    });
    expect(listing.ageEligibility).toBe('Too Recent');
    // `discoveredAt` is deliberately not part of the age calculation.
  });
});
