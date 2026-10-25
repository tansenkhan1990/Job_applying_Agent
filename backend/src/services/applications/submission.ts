import type { AppSettings } from '../../config/defaults.js';
import type { ApplicationRecord } from '../../models/Application.js';
import type { JobRecord } from '../../models/Job.js';

export interface SubmissionContext {
  application: ApplicationRecord & { _id: unknown };
  job: JobRecord & { _id: unknown };
  settings: AppSettings;
}

export interface SubmissionOutcome {
  outcome: 'submitted' | 'manual_required' | 'failed';
  adapter: string;
  message: string;
  confirmationId?: string;
  evidence: string;
  simulated?: boolean;
  manualInstructions?: string;
}

export interface SubmissionAdapter {
  id: string;
  label: string;
  supports(job: JobRecord, settings: AppSettings): boolean;
  submit(context: SubmissionContext): Promise<SubmissionOutcome>;
}

/**
 * The default adapter. No site-specific automation is claimed: the user is given
 * the exact application URL and must complete the employer's form, then confirm.
 */
const manualAdapter: SubmissionAdapter = {
  id: 'manual',
  label: 'Manual application (user completes the employer form)',
  supports: () => true,
  async submit({ job }) {
    const url = job.applicationUrl || job.url;
    const instructions = [
      `Open the employer application page: ${url}`,
      `Upload the CV and cover letter selected in this application.`,
      `Answer every mandatory screening/legal question yourself.`,
      `After the employer confirms receipt, return here and confirm the manual submission.`,
    ].join('\n');
    return {
      outcome: 'manual_required',
      adapter: 'manual',
      message:
        'This application channel requires you to complete the employer form in your browser. No automated submission was attempted.',
      evidence: 'No submission attempted; manual action required.',
      manualInstructions: instructions,
    };
  },
};

/**
 * Simulated submission for clearly fictional mock-source jobs. It is impossible
 * to use this adapter for a real listing, and the UI labels it as simulated.
 */
const mockAdapter: SubmissionAdapter = {
  id: 'mock',
  label: 'Simulated submission (mock source only)',
  supports: (job, settings) =>
    job.source === 'mock' && settings.application.allowMockSubmission === true,
  async submit({ application, job }) {
    if (job.source !== 'mock') {
      return {
        outcome: 'failed',
        adapter: 'mock',
        message: 'The simulated adapter refuses non-mock jobs.',
        evidence: 'Blocked by adapter guard',
      };
    }
    const confirmationId = `mock-${String(application._id)}-v${application.version}`;
    return {
      outcome: 'submitted',
      adapter: 'mock',
      message:
        'Simulated submission recorded for the fictional mock vacancy. No real employer was contacted.',
      confirmationId,
      evidence: `Simulated confirmation ${confirmationId}`,
      simulated: true,
    };
  },
};

export const SUBMISSION_ADAPTERS: SubmissionAdapter[] = [mockAdapter, manualAdapter];

export function resolveSubmissionAdapter(
  job: JobRecord,
  settings: AppSettings,
): SubmissionAdapter {
  return SUBMISSION_ADAPTERS.find((adapter) => adapter.supports(job, settings)) ?? manualAdapter;
}
