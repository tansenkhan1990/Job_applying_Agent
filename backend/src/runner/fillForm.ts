import type { Page } from 'playwright';
import {
  mapFields,
  type CandidateData,
  type FieldDescriptor,
  type FormAction,
  type MappingResult,
} from './formMapping.js';

export interface FillFiles {
  cv: string | null;
  coverLetter: string | null;
}

export interface FillSummary {
  mapping: MappingResult;
  remaining: MappingResult;
  filled: number;
  uploaded: number;
  fieldsDetected: number;
  validationErrors: string[];
  pageUrl: string;
  pageTitle: string;
}

/** Collect visible and hidden form controls with the labels a human would see. */
export async function collectFields(page: Page): Promise<FieldDescriptor[]> {
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
      const wrapperLabel = wrapper?.querySelector('label, legend')?.textContent?.trim() ?? '';
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

export async function scrollForm(page: Page): Promise<void> {
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

/**
 * Applies a single mapping action. There is no submit/click/Enter branch here: the runner
 * can only fill inputs, choose an existing select option or attach a file.
 */
export async function applyAction(
  page: Page,
  action: FormAction,
  files: FillFiles,
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

/**
 * Maps the visible form, fills only verified values and uploads the selected documents. It
 * never submits the form and leaves the page open for the user.
 *
 * `shouldPause` is polled between fields so an explicit pause/stop request stops filling.
 */
export async function fillVisibleForm(
  page: Page,
  candidate: CandidateData,
  files: FillFiles,
  shouldPause?: () => Promise<boolean>,
): Promise<FillSummary> {
  await scrollForm(page);
  const descriptors = await collectFields(page);
  const mapping = mapFields(descriptors, candidate);

  let filled = 0;
  let uploaded = 0;
  for (const action of mapping.actions) {
    if (action.kind === 'skip') continue;
    if (shouldPause && (await shouldPause())) break;
    const ok = await applyAction(page, action, files);
    if (ok && action.kind === 'file') uploaded += 1;
    else if (ok) filled += 1;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  const refreshed = await collectFields(page);
  const remaining = mapFields(refreshed, candidate);
  const validationErrors = await page
    .locator('[aria-invalid="true"], .error, .field-error, .invalid-feedback')
    .allInnerTexts()
    .catch(() => []);

  return {
    mapping,
    remaining,
    filled,
    uploaded,
    fieldsDetected: refreshed.filter((field) => field.visible).length,
    validationErrors: validationErrors.map((text) => text.trim()).filter(Boolean).slice(0, 10),
    pageUrl: page.url(),
    pageTitle: await page.title().catch(() => ''),
  };
}
