import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const RUNNER_FILES = ['src/runner/index.ts', 'src/runner/fillForm.ts', 'src/runner/formMapping.ts'];

describe('browser runner submission safety', () => {
  it('contains no click, Enter, submit or hidden form-submission calls', async () => {
    for (const relative of RUNNER_FILES) {
      const source = await fs.readFile(path.resolve(process.cwd(), relative), 'utf8');
      const withoutComments = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

      expect(withoutComments, relative).not.toMatch(/\.click\s*\(/);
      expect(withoutComments, relative).not.toMatch(/\.press\s*\(/);
      expect(withoutComments, relative).not.toMatch(/\.requestSubmit\s*\(/);
      expect(withoutComments, relative).not.toMatch(/\.submit\s*\(/);
      expect(withoutComments, relative).not.toMatch(/\bdispatchEvent\s*\(/);
      expect(withoutComments, relative).not.toMatch(/keyboard\.(press|type)/);
    }
  });

  it('has no submit action kind in the form mapping model', async () => {
    const source = await fs.readFile(
      path.resolve(process.cwd(), 'src/runner/formMapping.ts'),
      'utf8',
    );
    expect(source).toMatch(/type FieldKind = 'fill' \| 'select' \| 'file' \| 'check' \| 'skip'/);
    expect(source).not.toMatch(/'submit'\s*\|/);
  });
});
