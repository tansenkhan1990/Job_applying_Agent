import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  applyTransition,
  assertTransition,
  canTransition,
} from '../src/services/applications/stateMachine.js';
import type { ApplicationStatus } from '../src/config/defaults.js';

describe('application state machine', () => {
  it('allows only the documented transitions', () => {
    expect(canTransition('READY_FOR_REVIEW', 'APPROVED')).toBe(true);
    expect(canTransition('APPROVED', 'SUBMITTING')).toBe(true);
    expect(canTransition('SUBMITTING', 'SUBMITTED')).toBe(true);
    expect(canTransition('READY_FOR_REVIEW', 'SUBMITTED')).toBe(false);
    expect(canTransition('SUBMITTED', 'SUBMITTING')).toBe(false);
    expect(canTransition('WITHDRAWN', 'APPROVED')).toBe(false);
  });

  it('rejects invalid transitions with a conflict error', () => {
    expect(() => assertTransition('READY_FOR_REVIEW', 'SUBMITTED')).toThrow(/Invalid application state/);
  });

  it('records history with a timestamp and source for every transition', () => {
    const application: {
      status: ApplicationStatus;
      statusHistory: Array<{
        from?: string;
        to: ApplicationStatus;
        at: Date;
        reason?: string;
        source?: 'AI' | 'user' | 'system';
      }>;
    } = { status: 'READY_FOR_REVIEW', statusHistory: [] };
    applyTransition(application, 'APPROVED', 'user approved', 'user');
    applyTransition(application, 'SUBMITTING', 'submission started');
    expect(application.status).toBe('SUBMITTING');
    expect(application.statusHistory.map((entry) => entry.to)).toEqual(['APPROVED', 'SUBMITTING']);
    expect(application.statusHistory[0]?.from).toBe('READY_FOR_REVIEW');
    expect(application.statusHistory[0]?.reason).toBe('user approved');
    expect(application.statusHistory[0]?.source).toBe('user');
    expect(application.statusHistory[0]?.at).toBeInstanceOf(Date);
    expect(application.statusHistory[1]?.source).toBe('system');
  });

  it('has no outgoing transitions from withdrawn applications', () => {
    expect(ALLOWED_TRANSITIONS.WITHDRAWN).toEqual([]);
  });
});
