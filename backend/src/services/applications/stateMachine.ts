import type { ApplicationStatus } from '../../config/defaults.js';
import { conflict } from '../../utils/errors.js';

export const ALLOWED_TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  DISCOVERED: ['MATCHED', 'WITHDRAWN'],
  MATCHED: ['READY_FOR_REVIEW', 'WITHDRAWN'],
  READY_FOR_REVIEW: ['APPROVED', 'NEEDS_MANUAL_ACTION', 'WITHDRAWN'],
  APPROVED: ['SUBMITTING', 'READY_FOR_REVIEW', 'NEEDS_MANUAL_ACTION', 'WITHDRAWN'],
  SUBMITTING: ['SUBMITTED', 'FAILED', 'NEEDS_MANUAL_ACTION'],
  SUBMITTED: ['WITHDRAWN'],
  FAILED: ['READY_FOR_REVIEW', 'SUBMITTING', 'WITHDRAWN'],
  NEEDS_MANUAL_ACTION: ['APPROVED', 'SUBMITTED', 'FAILED', 'READY_FOR_REVIEW', 'WITHDRAWN'],
  WITHDRAWN: [],
};

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: ApplicationStatus, to: ApplicationStatus): void {
  if (!canTransition(from, to)) {
    throw conflict(`Invalid application state transition: ${from} → ${to}`);
  }
}

export type TransitionSource = 'AI' | 'user' | 'system';

interface Transitionable {
  status: ApplicationStatus;
  statusHistory: Array<{
    from?: string;
    to: ApplicationStatus;
    at: Date;
    reason?: string;
    source?: TransitionSource;
  }>;
}

export function applyTransition<T extends Transitionable>(
  application: T,
  to: ApplicationStatus,
  reason = '',
  source: TransitionSource = 'system',
): T {
  assertTransition(application.status, to);
  application.statusHistory.push({
    from: application.status,
    to,
    at: new Date(),
    reason,
    source,
  });
  application.status = to;
  return application;
}
