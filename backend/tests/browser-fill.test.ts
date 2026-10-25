import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { fillVisibleForm } from '../src/runner/fillForm.js';
import type { CandidateData } from '../src/runner/formMapping.js';

const MOCK_FORM = `<!doctype html>
<html><head><meta charset="utf-8"><title>Mock application</title></head>
<body>
  <h1>Apply</h1>
  <p id="status">NOT SUBMITTED</p>
  <form id="application" action="/submitted" method="post">
    <label for="first">First name</label><input id="first" name="first" required />
    <label for="last">Last name</label><input id="last" name="last" required />
    <label for="email">Email address</label><input id="email" name="email" type="email" required />
    <label for="phone">Phone number</label><input id="phone" name="phone" />
    <label for="cv">Upload CV / Resume</label><input id="cv" name="cv" type="file" required />
    <label for="letter">Cover letter</label><input id="letter" name="letter" type="file" />
    <label for="salary">Expected salary</label><input id="salary" name="salary" required />
    <label><input id="consent" name="consent" type="checkbox" /> I consent to data processing</label>
    <button id="submit" type="submit">Submit application</button>
  </form>
  <script>
    document.getElementById('application').addEventListener('submit', function (event) {
      event.preventDefault();
      document.getElementById('status').textContent = 'SUBMITTED';
    });
  </script>
</body></html>`;

const candidate: CandidateData = {
  fullName: 'Jane Example',
  firstName: 'Jane',
  lastName: 'Example',
  email: 'jane@example.com',
  phone: '+49 30 1234567',
  location: 'Berlin, Germany',
  linkedin: '',
  github: '',
  website: '',
  coverLetterText: 'Dear Hiring Manager, I build TypeScript applications.',
  yearsExperience: 7,
  languages: [{ language: 'English', level: 'C2' }],
  education: [{ degree: 'BSc Computer Science', institution: 'Example University', year: '2018' }],
  experience: [{ title: 'Senior Full Stack Engineer', employer: 'Example Commerce GmbH' }],
};

let server: http.Server;
let baseUrl = '';
let browser: Browser | null = null;
let browserLaunchError = '';
let tempDir = '';

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'job-agent-browser-'));
  await fs.writeFile(path.join(tempDir, 'cv.pdf'), '%PDF-1.4 mock cv');
  await fs.writeFile(path.join(tempDir, 'cover.docx'), 'mock cover letter');

  server = http.createServer((req, res) => {
    if (req.url === '/submitted') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('submitted');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(MOCK_FORM);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Mock server did not bind');
  baseUrl = `http://127.0.0.1:${address.port}/apply`;

  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    browserLaunchError = error instanceof Error ? error.message : String(error);
  }
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('Playwright form filling', () => {
  it('fills verified fields and documents but never submits the form', async (context) => {
    if (!browser) {
      // Chromium is a host prerequisite (`npx playwright install chromium`).
      context.skip(browserLaunchError ? `Chromium unavailable: ${browserLaunchError}` : undefined);
      return;
    }
    const page: Page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    const summary = await fillVisibleForm(page, candidate, {
      cv: path.join(tempDir, 'cv.pdf'),
      coverLetter: path.join(tempDir, 'cover.docx'),
    });

    expect(await page.inputValue('#first')).toBe('Jane');
    expect(await page.inputValue('#last')).toBe('Example');
    expect(await page.inputValue('#email')).toBe('jane@example.com');
    expect(await page.inputValue('#phone')).toBe('+49 30 1234567');
    expect((await page.locator('#cv').evaluate((el) => (el as HTMLInputElement).files?.length ?? 0))).toBe(1);
    expect(
      (await page.locator('#letter').evaluate((el) => (el as HTMLInputElement).files?.length ?? 0)),
    ).toBe(1);

    // Sensitive and legal fields are left untouched for the user.
    expect(await page.inputValue('#salary')).toBe('');
    expect(await page.isChecked('#consent')).toBe(false);

    // The mock form records any submit event; the assistant must not trigger it.
    expect(await page.locator('#status').innerText()).toBe('NOT SUBMITTED');
    expect(page.url()).toBe(baseUrl);
    expect(summary.filled).toBeGreaterThanOrEqual(4);
    expect(summary.uploaded).toBe(2);
    expect(summary.remaining.unanswered).toContain('Expected salary');

    await page.close();
  }, 60_000);
});
