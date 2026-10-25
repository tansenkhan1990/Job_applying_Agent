/**
 * Local, visible Playwright runner for the human-supervised application assistant.
 *
 * Run this on the host (not inside Docker) so the browser window is actually visible:
 *   cd backend && npm run runner
 *
 * It polls the Dockerized Express backend, opens the employer's application page in a
 * visible persistent Chromium context, fills only verified fields, uploads the selected
 * documents, and then stops. It never clicks Submit/Apply/Send, never presses Enter, never
 * runs form.submit(), and never calls a submission endpoint. The user reviews and submits.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { CandidateData } from './formMapping.js';
import { fillVisibleForm } from './fillForm.js';
import { assertNavigableApplicationUrl } from '../utils/urlSafety.js';

const API = (process.env.JOB_AGENT_API_URL ?? 'http://127.0.0.1:3000/api').replace(/\/+$/, '');
const TOKEN = (process.env.BROWSER_RUNNER_TOKEN ?? '').trim();
const RUNNER_ID = (process.env.JOB_AGENT_RUNNER_ID ?? `host-${process.pid}`).trim().slice(0, 120);
const PROFILE_DIR =
  process.env.JOB_AGENT_RUNNER_PROFILE ?? path.resolve(process.cwd(), '.runner-profile');
const POLL_MS = 3_000;
const CONTROL_MS = 2_000;

interface SessionCandidate extends CandidateData {}

interface RunnerSession {
  applicationId: string;
  applicationUrl: string;
  job: {
    id: string;
    title: string;
    employer: string;
    location: string;
    url: string;
    applicationUrl: string;
    source: string;
    description: string;
    languageDecision: string;
    languageReason: string;
  };
  profile: {
    id: string;
    name: string;
    location: string;
    languages: CandidateData['languages'];
    yearsExperience: number | null;
    skills: string[];
    education: CandidateData['education'];
    experience: CandidateData['experience'];
  };
  candidate: SessionCandidate;
  coverLetter: { subjectLine: string; letterText: string };
  screeningQuestions: Array<{ questionId: string; question: string; required: boolean; answer: string }>;
  files: { cv: string; coverLetter: string };
}

interface RunnerControl {
  pauseRequested: boolean;
  stopRequested: boolean;
  status: string;
}

let context: BrowserContext | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepUnlessStopped(ms: number): Promise<void> {
  return sleep(ms);
}

async function apiRequest<T>(route: string, init: RequestInit = {}): Promise<T | null> {
  const response = await fetch(`${API}${route}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'x-runner-token': TOKEN,
      'x-runner-id': RUNNER_ID,
      ...(init.headers ?? {}),
    },
  });
  if (response.status === 204) return null;
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Runner API ${route} failed: HTTP ${response.status} ${text}`.trim());
  }
  return (await response.json()) as T;
}

async function heartbeat(): Promise<void> {
  await apiRequest('/automation/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ runnerId: RUNNER_ID, version: '1.0.0' }),
  });
}

async function claimSession(): Promise<RunnerSession | null> {
  return apiRequest<RunnerSession>('/automation/next');
}

async function getControl(applicationId: string): Promise<RunnerControl> {
  const control = await apiRequest<RunnerControl>(
    `/automation/applications/${applicationId}/control`,
  );
  if (!control) throw new Error('Runner control response was empty.');
  return control;
}

async function reportProgress(
  applicationId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await apiRequest(`/automation/applications/${applicationId}/progress`, {
    method: 'POST',
    body: JSON.stringify({ runnerId: RUNNER_ID, ...payload }),
  });
}

async function downloadFile(route: string, baseName: string): Promise<string> {
  const response = await fetch(`${API}${route}`, {
    headers: { 'x-runner-token': TOKEN, 'x-runner-id': RUNNER_ID },
  });
  if (!response.ok) throw new Error(`Could not download ${baseName}: HTTP ${response.status}`);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'job-agent-runner-'));
  const extension = (response.headers.get('content-type') ?? '').includes('pdf') ? '.pdf' : '.docx';
  const filePath = path.join(directory, `${baseName}${extension}`);
  await fs.writeFile(filePath, Buffer.from(await response.arrayBuffer()));
  return filePath;
}

function ensureContext(): Promise<BrowserContext> {
  if (context) return Promise.resolve(context);
  return chromium
    .launchPersistentContext(PROFILE_DIR, {
      // Never headless: the user must see and edit the form.
      headless: false,
      viewport: null,
      acceptDownloads: false,
    })
    .then(async (launched) => {
      // Guard every request, including redirects: a public listing may redirect to a
      // loopback/private service. Non-http(s) subresources are blocked as well.
      await launched.route('**/*', async (route) => {
        const url = route.request().url();
        if (
          url.startsWith('data:') ||
          url.startsWith('blob:') ||
          url.startsWith('about:')
        ) {
          await route.continue();
          return;
        }
        try {
          assertNavigableApplicationUrl(url);
          await route.continue();
        } catch {
          await route.abort('blockedbyclient');
        }
      });
      context = launched;
      return launched;
    })
    .catch((error: unknown) => {
      throw new Error(
        `Could not launch the visible browser. Run "npx playwright install chromium" first. ${
          error instanceof Error ? error.message : ''
        }`.trim(),
      );
    });
}

async function runSession(session: RunnerSession): Promise<void> {
  const browser = await ensureContext();
  const page = await browser.newPage();
  let pageClosed = false;
  page.on('close', () => {
    pageClosed = true;
  });

  await reportProgress(session.applicationId, {
    message: `Opening ${session.job.employer} application page.`,
    pageUrl: session.applicationUrl,
  });

  try {
    // The listing URL is untrusted input: only public http(s) pages may be opened.
    const targetUrl = assertNavigableApplicationUrl(session.applicationUrl);
    await page.goto(targetUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(1_500);

    const control = await getControl(session.applicationId);
    if (control.stopRequested) {
      await page.close();
      await reportProgress(session.applicationId, {
        status: 'NEEDS_INPUT',
        message: 'Assistant stopped before filling the form.',
      });
      return;
    }

    const files = {
      cv: session.files.cv ? await downloadFile(session.files.cv, 'cv') : null,
      coverLetter: session.files.coverLetter
        ? await downloadFile(session.files.coverLetter, 'cover-letter')
        : null,
    };

    const summary = await fillVisibleForm(
      page,
      {
        ...session.candidate,
        languages: session.profile.languages,
        education: session.profile.education,
        experience: session.profile.experience,
      },
      files,
      async () => {
        const current = await getControl(session.applicationId).catch(() => null);
        return Boolean(current?.stopRequested || current?.pauseRequested);
      },
    );

    const unanswered = summary.remaining.unanswered;
    await reportProgress(session.applicationId, {
      status: unanswered.length > 0 ? 'NEEDS_INPUT' : 'AWAITING_REVIEW',
      fieldsDetected: summary.fieldsDetected,
      fieldsFilled: summary.filled,
      filesUploaded: summary.uploaded,
      unanswered,
      reviewFields: summary.remaining.reviewFields.slice(0, 30),
      validationErrors: summary.validationErrors,
      pageUrl: summary.pageUrl,
      pageTitle: summary.pageTitle,
      message:
        unanswered.length > 0
          ? 'Form filled. Some required questions need your input in the visible browser.'
          : 'Application form filled — please review before submitting.',
    });

    // Keep the browser open and wait for the user. The runner never submits.
    while (true) {
      if (pageClosed) {
        await reportProgress(session.applicationId, {
          status: 'NEEDS_INPUT',
          message:
            'The browser page was closed. No submission was performed by the assistant; record the outcome yourself if you submitted.',
        });
        return;
      }
      await sleep(CONTROL_MS);
      const current = await getControl(session.applicationId).catch(() => null);
      if (!current) return;
      if (current.stopRequested) {
        await reportProgress(session.applicationId, {
          status: 'NEEDS_INPUT',
          message: 'Assistant stopped at your request. The browser was left open for manual handling.',
        });
        return;
      }
      if (['SUBMITTED', 'APPLIED_MANUALLY', 'SUBMISSION_FAILED', 'SKIPPED'].includes(current.status)) {
        return;
      }
    }
  } catch (error) {
    await reportProgress(session.applicationId, {
      status: 'NEEDS_INPUT',
      message: `Assistant could not complete the form: ${
        error instanceof Error ? error.message : 'unknown error'
      }. No submission was performed.`,
    }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error(
      'BROWSER_RUNNER_TOKEN is empty. Add a shared secret to .env, restart the backend, then run this again.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Job Agent runner ${RUNNER_ID} polling ${API}`);
  console.log(`Persistent browser profile: ${PROFILE_DIR}`);
  console.log('The browser is visible. The runner never submits an application.');

  const heartbeatTimer = setInterval(() => {
    void heartbeat().catch(() => undefined);
  }, 5_000);
  heartbeatTimer.unref?.();

  while (true) {
    try {
      await heartbeat();
      const session = await claimSession();
      if (!session) {
        await sleepUnlessStopped(POLL_MS);
        continue;
      }
      console.log(`Opening application for ${session.job.employer} — ${session.job.title}`);
      await runSession(session);
      console.log('Session paused for your review. The browser remains open.');
    } catch (error) {
      console.error(
        `Runner loop error: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      await sleep(5_000);
    }
  }
}

process.on('SIGINT', () => {
  void context?.close().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void context?.close().finally(() => process.exit(0));
});

void main();
