import { describe, expect, it } from 'vitest';
import { mapFields, type CandidateData, type FieldDescriptor } from '../src/runner/formMapping.js';

const candidate: CandidateData = {
  fullName: 'Jane Example',
  firstName: 'Jane',
  lastName: 'Example',
  email: 'jane@example.com',
  phone: '+49 30 1234567',
  location: 'Berlin, Germany',
  linkedin: 'https://linkedin.com/in/jane',
  github: 'https://github.com/jane',
  website: 'https://jane.dev',
  coverLetterText: 'Dear Hiring Manager, I build TypeScript and React applications.',
  yearsExperience: 7,
  languages: [
    { language: 'English', level: 'C2' },
    { language: 'German', level: 'B2' },
  ],
  education: [{ degree: 'BSc Computer Science', institution: 'Example University', year: '2018' }],
  experience: [
    { title: 'Senior Full Stack Engineer', employer: 'Example Commerce GmbH', startDate: '2021' },
  ],
};

function field(partial: Partial<FieldDescriptor> & { index: number }): FieldDescriptor {
  return {
    tag: 'input',
    type: 'text',
    name: '',
    id: '',
    label: '',
    placeholder: '',
    ariaLabel: '',
    autocomplete: '',
    required: false,
    visible: true,
    disabled: false,
    value: '',
    options: [],
    ...partial,
  };
}

describe('supervised form mapping', () => {
  it('fills verified contact and profile fields', () => {
    const result = mapFields(
      [
        field({ index: 0, label: 'First name' }),
        field({ index: 1, label: 'Last name' }),
        field({ index: 2, label: 'Email address', type: 'email' }),
        field({ index: 3, label: 'Phone number' }),
        field({ index: 4, label: 'City' }),
        field({ index: 5, label: 'Years of professional experience' }),
      ],
      candidate,
    );
    expect(result.actions.map((action) => action.value)).toEqual([
      'Jane',
      'Example',
      'jane@example.com',
      '+49 30 1234567',
      'Berlin, Germany',
      '7',
    ]);
    expect(result.fieldsDetected).toBe(6);
  });

  it('uploads the selected CV and tailored cover letter to the right fields', () => {
    const result = mapFields(
      [
        field({ index: 0, label: 'Upload CV / Resume', type: 'file' }),
        field({ index: 1, label: 'Cover letter', type: 'file' }),
      ],
      candidate,
    );
    expect(result.actions).toEqual([
      expect.objectContaining({ kind: 'file', value: 'cv' }),
      expect.objectContaining({ kind: 'file', value: 'cover-letter' }),
    ]);
  });

  it('never answers legal, salary, availability or declaration fields', () => {
    const result = mapFields(
      [
        field({ index: 0, label: 'Expected salary', required: true }),
        field({ index: 1, label: 'Do you require visa sponsorship?', required: true }),
        field({ index: 2, label: 'Notice period' }),
        field({ index: 3, label: 'I certify this information is accurate', type: 'checkbox' }),
        field({ index: 4, label: 'I consent to data processing', type: 'checkbox' }),
      ],
      candidate,
    );
    expect(result.actions.every((action) => action.kind === 'skip')).toBe(true);
    expect(result.unanswered).toEqual([
      'Expected salary',
      'Do you require visa sponsorship?',
    ]);
    expect(result.reviewFields).toHaveLength(5);
  });

  it('fills a cover-letter textarea but leaves unknown open questions for the user', () => {
    const result = mapFields(
      [
        field({ index: 0, tag: 'textarea', label: 'Cover letter / motivation' }),
        field({ index: 1, tag: 'textarea', label: 'Describe a difficult project' }),
      ],
      candidate,
    );
    expect(result.actions[0]).toEqual(
      expect.objectContaining({ kind: 'fill', value: candidate.coverLetterText }),
    );
    expect(result.actions[1]?.kind).toBe('skip');
  });

  it('selects a verified language level instead of guessing', () => {
    const result = mapFields(
      [
        field({
          index: 0,
          tag: 'select',
          label: 'German language proficiency',
          options: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'Native'],
        }),
        field({
          index: 1,
          tag: 'select',
          label: 'English level',
          options: ['Basic', 'Intermediate', 'Advanced', 'Native'],
        }),
      ],
      candidate,
    );
    expect(result.actions[0]).toEqual(expect.objectContaining({ kind: 'select', value: 'B2' }));
    expect(result.actions[1]?.kind).toBe('skip');
  });

  it('leaves already-filled fields unchanged', () => {
    const result = mapFields(
      [field({ index: 0, label: 'Email address', value: 'existing@example.com' })],
      candidate,
    );
    expect(result.actions[0]?.kind).toBe('skip');
    expect(result.actions[0]?.reason).toMatch(/already filled/i);
  });

  it('has no submit action kind and never emits a check action', () => {
    const result = mapFields(
      [
        field({ index: 0, label: 'Full name' }),
        field({ index: 1, label: 'I agree', type: 'checkbox' }),
        field({ index: 2, label: 'Submit application', type: 'submit' }),
      ],
      candidate,
    );
    expect(result.actions.some((action) => action.kind === 'check')).toBe(false);
    expect(result.actions.every((action) => ['fill', 'select', 'file', 'skip'].includes(action.kind))).toBe(
      true,
    );
  });
});
