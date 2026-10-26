import { PhdPositionModel } from '../../models/PhdPosition.js';
import { logger } from '../../utils/logger.js';

export const PHD_RESEARCH_AREAS = [
  'ai',
  'cybersecurity',
  'software_engineering',
  'other',
] as const;

export type PhdResearchArea = (typeof PHD_RESEARCH_AREAS)[number];

export const PHD_RESEARCH_AREA_LABELS: Record<PhdResearchArea, string> = {
  ai: 'Artificial Intelligence',
  cybersecurity: 'Cybersecurity',
  software_engineering: 'Software Engineering',
  other: 'Other relevant research',
};

export const PHD_DEADLINE_STATUSES = ['open', 'expired', 'unknown', 'closed'] as const;
export type PhdDeadlineStatus = (typeof PHD_DEADLINE_STATUSES)[number];

interface AreaPattern {
  area: Exclude<PhdResearchArea, 'other'>;
  patterns: RegExp[];
}

// Order matters only for ties: a specific engineering or security title wins over the
// generic "AI" mention that appears in many advertisements.
const AREA_PATTERNS: AreaPattern[] = [
  {
    area: 'software_engineering',
    patterns: [
      /\bsoftware engineering\b/i,
      /\bsoftware architecture\b/i,
      /\bsoftware quality\b/i,
      /\bsoftware testing\b/i,
      /\btest automation\b/i,
      /\bdeveloper tools?\b/i,
      /\bprogram analysis\b/i,
      /\bdistributed systems?\b/i,
      /\bprogramming languages?\b/i,
      /\bformal methods\b/i,
      /\bsoftware analytics\b/i,
      /\bdevops\b/i,
      /\bci\/cd\b/i,
      /\bcode generation\b/i,
      /\bai for software engineering\b/i,
      /\bresearch software\b/i,
      /\bsoftware systems?\b/i,
    ],
  },
  {
    area: 'cybersecurity',
    patterns: [
      /\bcybersecurity\b/i,
      /\bcyber security\b/i,
      /\binformation security\b/i,
      /\bit security\b/i,
      /\bapplication security\b/i,
      /\bsecure software\b/i,
      /\bsecurity\b/i,
      /\bcryptograph/i,
      /\bprivacy\b/i,
      /\bmalware\b/i,
      /\bintrusion detection\b/i,
      /\bnetwork security\b/i,
      /\bai security\b/i,
      /\btrustworthy ai\b/i,
    ],
  },
  {
    area: 'ai',
    patterns: [
      /\bartificial intelligence\b/i,
      /\bmachine learning\b/i,
      /\bdeep learning\b/i,
      /\blarge language models?\b/i,
      /\bllms?\b/i,
      /\bnatural language processing\b/i,
      /\bnlp\b/i,
      /\bknowledge graphs?\b/i,
      /\bgraph neural\b/i,
      /\bgraph machine learning\b/i,
      /\bgenerative ai\b/i,
      /\bretrieval[- ]augmented generation\b/i,
      /\brag\b/i,
      /\bcomputer vision\b/i,
      /\bdata mining\b/i,
      /\binformation retrieval\b/i,
      /\brecommender systems?\b/i,
      /\bai\b/i,
      /\bml\b/i,
    ],
  },
];

/** Classify the primary research area from the advertisement's own text. */
export function classifyPhdResearchArea(text: string): {
  area: PhdResearchArea;
  evidence: string;
} {
  let best: { area: PhdResearchArea; score: number; evidence: string[] } = {
    area: 'other',
    score: 0,
    evidence: [],
  };

  for (const group of AREA_PATTERNS) {
    const evidence: string[] = [];
    for (const pattern of group.patterns) {
      const match = text.match(pattern);
      if (match?.[0]) evidence.push(match[0]);
    }
    if (evidence.length > best.score) {
      best = { area: group.area, score: evidence.length, evidence };
    }
  }

  return {
    area: best.area,
    evidence: best.evidence.slice(0, 6).join(', '),
  };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// The source must state that applications are accepted without a fixed deadline. A generic
// "open" or "ongoing" is not enough.
const ROLLING_PATTERNS = [
  /\brolling (?:admissions?|review|basis|recruitment)\b/i,
  /\bapplications? (?:are )?(?:reviewed|considered|accepted) on a rolling basis\b/i,
  /\bopen until filled\b/i,
  /\bapplications? (?:are )?accepted (?:continuously|at any time|year[- ]round)\b/i,
];

/** True only when the advertisement itself states rolling/continuous admission. */
export function detectRollingAdmissions(text: string): boolean {
  return ROLLING_PATTERNS.some((pattern) => pattern.test(text));
}

export function isDateOnlyDeadline(value: unknown): boolean {
  return typeof value === 'string' && DATE_ONLY.test(value.trim());
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function localDateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Assess a PhD deadline. A date without a clock time stays open through that whole day in the
 * institution's timezone. An explicit timestamp is compared exactly. Unknown deadlines are never
 * silently treated as open, and an explicitly closed/filled position always stays closed.
 */
export function assessPhdDeadline(input: {
  deadline: Date | null | undefined;
  timezone?: string | null;
  /** True only when the source published a clock time, not just a calendar date. */
  hasTime?: boolean;
  closed?: boolean;
  /** True only when the advertisement states rolling/continuous admission. */
  rolling?: boolean;
  now?: Date;
}): { status: PhdDeadlineStatus; note: string } {
  if (input.closed) {
    return {
      status: 'closed',
      note: 'The official source states that the position is closed or has been filled.',
    };
  }
  if (!input.deadline) {
    if (input.rolling) {
      return {
        status: 'open',
        note: 'The official advertisement states that applications are accepted on a rolling basis, so there is no fixed deadline.',
      };
    }
    return {
      status: 'unknown',
      note: 'The advertisement does not state a verifiable application deadline. Check the official source before treating this position as open.',
    };
  }

  const now = input.now ?? new Date();
  const timezone = input.timezone?.trim() ?? '';
  const zone = timezone && isValidTimeZone(timezone) ? timezone : 'UTC';
  const zoneLabel = timezone && isValidTimeZone(timezone) ? timezone : 'UTC (no timezone stated)';

  if (input.hasTime) {
    if (input.deadline.getTime() < now.getTime()) {
      return {
        status: 'expired',
        note: `The application deadline (${input.deadline.toISOString()}) has passed.`,
      };
    }
    return {
      status: 'open',
      note: `Applications are still accepted until ${input.deadline.toISOString()} (${zoneLabel}).`,
    };
  }

  // A date-only deadline is a calendar date from the source, not an instant. Its UTC
  // components preserve the advertised YYYY-MM-DD; converting midnight UTC into a western
  // timezone would shift it to the previous day and expire it too early.
  const deadlineDay = input.deadline.toISOString().slice(0, 10);
  const today = localDateKey(now, zone);
  if (deadlineDay < today) {
    return {
      status: 'expired',
      note: `The application deadline was ${deadlineDay} (${zoneLabel}) and has passed.`,
    };
  }
  return {
    status: 'open',
    note:
      deadlineDay === today
        ? `The application deadline is today (${zoneLabel}); the date-only deadline is treated as open through the end of that local day.`
        : `Applications are open until ${deadlineDay} (${zoneLabel}).`,
  };
}

/**
 * Fills the new research-area and deadline fields for positions stored before those fields
 * existed. This is a local reclassification only; it does not contact the source and does not
 * claim a source verification (`lastVerifiedAt` stays untouched).
 */
export async function backfillPhdMetadata(): Promise<number> {
  const positions = await PhdPositionModel.find({
    $or: [
      { researchArea: { $exists: false } },
      { deadlineStatus: { $exists: false } },
      { rollingAdmissions: { $exists: false } },
      { deadlineHasTime: { $exists: false } },
      { lastVerifiedAt: null, lastSeenAt: { $ne: null } },
    ],
  });

  let updated = 0;
  for (const position of positions) {
    const area = classifyPhdResearchArea(
      [position.title, position.researchTopic, position.description].join('\n'),
    );
    const rollingAdmissions =
      position.rollingAdmissions ??
      detectRollingAdmissions([position.title, position.description].join('\n'));
    const deadline = assessPhdDeadline({
      deadline: position.applicationDeadline,
      timezone: position.deadlineTimezone,
      hasTime: position.deadlineHasTime,
      closed: position.status === 'closed',
      rolling: rollingAdmissions,
    });
    const update: Record<string, unknown> = {
      researchArea: area.area,
      rollingAdmissions,
      researchAreaEvidence: area.evidence,
      deadlineStatus: deadline.status,
      deadlineNote: deadline.note,
      deadlineHasTime: Boolean(position.deadlineHasTime),
      deadlineTimezone: position.deadlineTimezone ?? '',
    };
    // Older records predate `lastVerifiedAt`. `lastSeenAt` is the timestamp of the last
    // successful source fetch for that row, so it is the honest value to adopt.
    if (!position.lastVerifiedAt && position.lastSeenAt) {
      update.lastVerifiedAt = position.lastSeenAt;
    }
    if (deadline.status === 'expired' && position.status === 'active') {
      update.status = 'expired';
      update.statusNote = deadline.note;
    }

    await PhdPositionModel.updateOne({ _id: position._id }, { $set: update });
    updated += 1;
  }

  if (updated > 0) {
    logger.info({ updated }, 'Backfilled PhD research area and deadline metadata');
  }
  return updated;
}
