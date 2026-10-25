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
import { mapFields, type CandidateData, type FieldDescriptor, type FormAction } from './formMapping.js';

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

async function collectFields(page: Page): Promise<FieldDescriptor[]> {
  const fields = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        'input, textarea, select',
      ),
    );
    const output: Array<Record<string, unknown>> = [];
    let index = 0;
    for (const element of nodes) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const hiddenByAttribute = element.hidden;
      const visible =
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 0 &&
        rect.height > 0 &&
        !hiddenByAttribute;
      const labels = element.labels ? Array.from(element.labels).map((label) => label.innerText) : [];
      const wrapper = element.closest(
        '.form-group, .field, .form-field, .application-question, fieldset, .question, [role="group"]',
      );
      const wrapperLabel =
        wrapper?.querySelector('label, legend')?.textContent?.trim() ?? '';
      element.setAttribute('data-ja-field', String(index));
      const tag = element.tagName.toLowerCase() as 'input' | 'textarea' | 'select';
      const type = tag === 'input' ? element.type || 'text' : tag;
      output.push({
        index,
        tag,
        type,
        name: element.getAttribute('name') ?? '',
        id: element.id ?? '',
        label: (labels.join(' ') || wrapperLabel).replace(/\s+/g, ' ').trim(),
        placeholder: element.getAttribute('placeholder') ?? '',
        ariaLabel: element.getAttribute('aria-label') ?? '',
        autocomplete: element.getAttribute('autocomplete') ?? '',
        required: element.required || element.getAttribute('aria-required') === 'true',
        visible,
        disabled: element.disabled,
        value: tag === 'select' ? element.value : element.value ?? '',
        options:
          tag === 'select'
            ? Array.from((element as HTMLSelectElement).options).map((option) => option.text.trim())
            : [],
      });
      index += 1;
    }
    return output;
  });
  return fields as unknown as FieldDescriptor[];
}

async function scrollForm(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = Math.max(300, Math.floor(window.innerHeight * 0.8));
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((resolve) => setTimeout(resolve, 400));
    window.scrollTo(0, 0);
  });
}

async function applyAction(
  page: Page,
  action: FormAction,
  files: { cv: string | null; coverLetter: string | null },
): Promise<boolean> {
  if (action.kind === 'skip') return false;
  const locator = page.locator(`[data-ja-field="${action.index}"]`).first();
  if ((await locator.count()) === 0) return false;

  try {
    if (action.kind === 'file') {
      const filePath = action.value === 'cv' ? files.cv : files.coverLetter;
      if (!filePath) return false;
      await locator.setInputFiles(filePath);
      return true;
    }
    if (action.kind === 'select') {
      try {
        await locator.selectOption({ label: action.value });
      } catch {
        await locator.selectOption(action.value);
      }
      return true;
    }
    await locator.fill(action.value);
    return true;
  } catch {
    return false;
  }
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
    await page.goto(session.applicationUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(1_500);
    await scrollForm(page);

    const control = await getControl(session.applicationId);
    if (control.stopRequested) {
      await page.close();
      await reportProgress(session.applicationId, {
        status: 'NEEDS_INPUT',
        message: 'Assistant stopped before filling the form.',
      });
      return;
    }

    const descriptors = await collectFields(page);
    const mapping = mapFields(descriptors, {
      ...session.candidate,
      languages: session.profile.languages,
      education: session.profile.education,
      experience: session.profile.experience,
    });

    const files = {
      cv: session.files.cv ? await downloadFile(session.files.cv, 'cv') : null,
      coverLetter: session.files.coverLetter
        ? await downloadFile(session.files.coverLetter, 'cover-letter')
        : null,
    };

    let filled = 0;
    let uploaded = 0;
    for (const action of mapping.actions) {
      if (action.kind === 'skip') continue;
      const current = await getControl(session.applicationId).catch(() => null);
      if (current?.stopRequested || current?.pauseRequested) break;
      const ok = await applyAction(page, action, files);
      if (ok && action.kind === 'file') uploaded += 1;
      else if (ok) filled += 1;
      await sleep(120);
    }

    const refreshed = await collectFields(page);
    const remaining = mapFields(refreshed, {
      ...session.candidate,
      languages: session.profile.languages,
      education: session.profile.education,
      experience: session.profile.experience,
    });
    const validationErrors = await page
      .locator('[aria-invalid="true"], .error, .field-error, .invalid-feedback')
      .allInnerTexts()
      .catch(() => []);

    await reportProgress(session.applicationId, {
      status: mapping.unanswered.length > 0 ? 'NEEDS_INPUT' : 'AWAITING_REVIEW',
      fieldsDetected: refreshed.filter((field) => field.visible).length,
      fieldsFilled: filled,
      filesUploaded: uploaded,
      unanswered: mapping.unanswered,
      reviewFields: remaining.reviewFields.slice(0, 30),
      validationErrors: validationErrors.map((text) => text.trim()).filter(Boolean).slice(0, 10),
      pageUrl: page.url(),
      pageTitle: await page.title().catch(() => ''),
      message:
        mapping.unanswered.length > 0
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
