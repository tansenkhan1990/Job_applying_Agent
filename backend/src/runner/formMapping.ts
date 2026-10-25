/**
 * Pure form-field mapping for the human-supervised browser assistant.
 *
 * There is deliberately no "submit" action type. The runner can fill fields and upload
 * files, but it has no way to click a final Submit/Apply/Send button, press Enter, or call
 * a form's submit() from this module.
 */

export type FieldKind = 'fill' | 'select' | 'file' | 'check' | 'skip';

export interface FieldDescriptor {
  index: number;
  tag: 'input' | 'textarea' | 'select';
  type: string;
  name: string;
  id: string;
  label: string;
  placeholder: string;
  ariaLabel: string;
  autocomplete: string;
  required: boolean;
  visible: boolean;
  disabled: boolean;
  value: string;
  options: string[];
}

export interface CandidateData {
  fullName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  linkedin: string;
  github: string;
  website: string;
  coverLetterText: string;
  yearsExperience: number | null;
  languages: Array<{ language: string; level: string }>;
  education: Array<{ degree: string; institution: string; year?: string }>;
  experience: Array<{ title: string; employer: string; startDate?: string; endDate?: string }>;
}

export interface FormAction {
  index: number;
  kind: FieldKind;
  value: string;
  label: string;
  reason: string;
  fieldType: string;
}

export interface ReviewField {
  label: string;
  reason: string;
  fieldType: string;
}

export interface MappingResult {
  actions: FormAction[];
  reviewFields: ReviewField[];
  unanswered: string[];
  fieldsDetected: number;
}

const SENSITIVE =
  /\b(salary|gehalt|compensation|visa|work permit|work authoriz|work authoris|right to work|sponsor|clearance|criminal|conviction|disabilit|gender|ethnic|race|religio|marital|date of birth|geburtstag|notice period|kündigungsfrist|availability|verfügbar|start date|eintrittsdatum|consent|declaration|erklärung|certify|attest|terms|privacy|datenschutz|accurate|wahrheitsgemäß)\b/i;

const COVER_LETTER =
  /\b(cover letter|coverletter|anschreiben|motivation letter|motivationsschreiben)\b/i;
const CV = /\b(cv|resume|résumé|curriculum vitae|lebenslauf)\b/i;

const FIRST_NAME = /\b(first name|firstname|given name|vorname)\b/i;
const LAST_NAME = /\b(last name|lastname|surname|family name|nachname)\b/i;
const FULL_NAME = /\b(full name|name|your name|complete name|vor- und nachname)\b/i;
const EMAIL = /\b(e-?mail|email address|e-mail-adresse)\b/i;
const PHONE = /\b(phone|telephone|mobile|tel\b|telefon|handy|mobilnummer)\b/i;
const LOCATION = /\b(location|city|town|address|residence|wohnort|stadt|adresse|anschrift)\b/i;
const LINKEDIN = /\blinkedin\b/i;
const GITHUB = /\bgithub\b/i;
const WEBSITE = /\b(website|portfolio|homepage|webseite|url)\b/i;
const YEARS = /\b(years of (professional )?experience|how many years|jahre berufserfahrung|berufserfahrung)\b/i;
const CURRENT_EMPLOYER = /\b(current employer|current company|arbeitgeber|derzeitiger arbeitgeber)\b/i;
const CURRENT_TITLE = /\b(current (job )?title|current position|aktuelle position|berufsbezeichnung)\b/i;
const EDUCATION = /\b(degree|university|college|education|abschluss|universität|hochschule|studium)\b/i;
const COVER_TEXT =
  /\b(cover letter|motivation|why do you|why are you|why this|tell us about yourself|anschreiben|motivationsschreiben|warum)\b/i;
const LANGUAGE_QUESTION = /\b(german|deutsch|english|englisch)\b.*\b(level|proficiency|kenntnisse|niveau|fluency)\b/i;

function normalized(descriptor: FieldDescriptor): string {
  return [
    descriptor.label,
    descriptor.ariaLabel,
    descriptor.placeholder,
    descriptor.name,
    descriptor.id,
    descriptor.autocomplete,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasValue(descriptor: FieldDescriptor): boolean {
  return descriptor.value.trim().length > 0;
}

function review(descriptor: FieldDescriptor, reason: string): FormAction {
  return {
    index: descriptor.index,
    kind: 'skip',
    value: '',
    label: descriptor.label || descriptor.name || `Field ${descriptor.index + 1}`,
    reason,
    fieldType: descriptor.type || descriptor.tag,
  };
}

function textAction(
  descriptor: FieldDescriptor,
  value: string,
  reason = 'Filled from the verified candidate profile or CV.',
): FormAction {
  if (!value.trim()) return review(descriptor, 'No verified value is available for this field.');
  return {
    index: descriptor.index,
    kind: 'fill',
    value,
    label: descriptor.label || descriptor.name || `Field ${descriptor.index + 1}`,
    reason,
    fieldType: descriptor.type || descriptor.tag,
  };
}

function languageAnswer(descriptor: FieldDescriptor, languages: CandidateData['languages']): string {
  const text = normalized(descriptor).toLowerCase();
  const wantsGerman = /german|deutsch/.test(text);
  const wantsEnglish = /english|englisch/.test(text);
  const language = languages.find((entry) =>
    wantsGerman ? /german|deutsch/i.test(entry.language) : wantsEnglish ? /english|englisch/i.test(entry.language) : false,
  );
  if (!language) return '';
  const level = language.level.trim();
  if (!level || /unknown/i.test(level)) return '';
  const option = descriptor.options.find((item) => item.toLowerCase().includes(level.toLowerCase()));
  return option ?? '';
}

function optionAnswer(descriptor: FieldDescriptor, wanted: string): string {
  if (!wanted) return '';
  const match = descriptor.options.find(
    (option) => option.trim().toLowerCase() === wanted.trim().toLowerCase(),
  );
  return match ?? '';
}

/**
 * Maps detected fields to safe actions. Unknown, legal, eligibility, salary, consent and
 * declaration fields are always left for the user. Required unanswered fields are reported
 * in `unanswered`.
 */
export function mapFields(descriptors: FieldDescriptor[], candidate: CandidateData): MappingResult {
  const actions: FormAction[] = [];
  const reviewFields: ReviewField[] = [];
  const unanswered: string[] = [];
  const visible = descriptors.filter((descriptor) => descriptor.visible && !descriptor.disabled);

  for (const descriptor of visible) {
    const text = normalized(descriptor);
    const fieldType = descriptor.type || descriptor.tag;

    if (descriptor.tag === 'select') {
      if (SENSITIVE.test(text)) {
        actions.push(review(descriptor, 'Sensitive or legal question. Answer and review this yourself.'));
      } else if (
        LANGUAGE_QUESTION.test(text) ||
        (/(german|deutsch|english|englisch)/i.test(text) &&
          descriptor.options.some((item) =>
            /\b(a1|a2|b1|b2|c1|c2|native|fluent|basic|intermediate|advanced|muttersprache)\b/i.test(item),
          ))
      ) {
        const answer = languageAnswer(descriptor, candidate.languages);
        actions.push(
          answer
            ? {
                index: descriptor.index,
                kind: 'select',
                value: answer,
                label: descriptor.label || descriptor.name || 'Language level',
                reason: 'Selected the level recorded in the verified candidate profile.',
                fieldType,
              }
            : review(descriptor, 'Language proficiency could not be matched to a verified profile value.'),
        );
      } else if (hasValue(descriptor)) {
        actions.push(review(descriptor, 'Already selected; left unchanged.'));
      } else {
        actions.push(review(descriptor, 'Unrecognised option field. Choose the correct answer yourself.'));
      }
      continue;
    }

    if (descriptor.tag === 'input' && descriptor.type === 'file') {
      if (CV.test(text)) {
        actions.push({
          index: descriptor.index,
          kind: 'file',
          value: 'cv',
          label: descriptor.label || 'CV upload',
          reason: 'Uploads the CV selected for this application.',
          fieldType: 'file',
        });
      } else if (COVER_LETTER.test(text)) {
        actions.push({
          index: descriptor.index,
          kind: 'file',
          value: 'cover-letter',
          label: descriptor.label || 'Cover letter upload',
          reason: 'Uploads the tailored cover letter.',
          fieldType: 'file',
        });
      } else {
        actions.push(review(descriptor, 'Unknown upload field. Attach the correct file yourself.'));
      }
      continue;
    }

    if (descriptor.type === 'checkbox' || descriptor.type === 'radio') {
      // Declarations and consent are never accepted on the user's behalf, and even harmless
      // checkboxes are left untouched so the user sees every decision.
      actions.push(review(descriptor, 'Checkbox or declaration. Review and tick this yourself.'));
      continue;
    }

    if (['hidden', 'submit', 'button', 'reset', 'password', 'search', 'image'].includes(descriptor.type)) {
      actions.push(review(descriptor, 'Not an autofill field.'));
      continue;
    }

    if (SENSITIVE.test(text)) {
      actions.push(review(descriptor, 'Sensitive, legal or eligibility question. Complete it yourself.'));
      continue;
    }

    if (hasValue(descriptor)) {
      actions.push(review(descriptor, 'Already filled; left unchanged.'));
      continue;
    }

    if (EMAIL.test(text)) {
      actions.push(textAction(descriptor, candidate.email));
    } else if (PHONE.test(text)) {
      actions.push(textAction(descriptor, candidate.phone));
    } else if (FIRST_NAME.test(text)) {
      actions.push(textAction(descriptor, candidate.firstName));
    } else if (LAST_NAME.test(text)) {
      actions.push(textAction(descriptor, candidate.lastName));
    } else if (FULL_NAME.test(text) && !/username|user name|company name|employer name/i.test(text)) {
      actions.push(textAction(descriptor, candidate.fullName));
    } else if (LINKEDIN.test(text)) {
      actions.push(textAction(descriptor, candidate.linkedin));
    } else if (GITHUB.test(text)) {
      actions.push(textAction(descriptor, candidate.github));
    } else if (WEBSITE.test(text)) {
      actions.push(textAction(descriptor, candidate.website));
    } else if (LOCATION.test(text)) {
      actions.push(textAction(descriptor, candidate.location));
    } else if (YEARS.test(text)) {
      actions.push(
        textAction(
          descriptor,
          candidate.yearsExperience === null ? '' : String(candidate.yearsExperience),
          'Filled from the years of experience stated in the verified profile.',
        ),
      );
    } else if (CURRENT_EMPLOYER.test(text)) {
      actions.push(textAction(descriptor, candidate.experience[0]?.employer ?? ''));
    } else if (CURRENT_TITLE.test(text)) {
      actions.push(textAction(descriptor, candidate.experience[0]?.title ?? ''));
    } else if (EDUCATION.test(text) && descriptor.tag === 'textarea') {
      const education = candidate.education[0];
      actions.push(
        textAction(
          descriptor,
          education ? `${education.degree}, ${education.institution}` : '',
          'Filled from the verified education entry.',
        ),
      );
    } else if (COVER_TEXT.test(text)) {
      actions.push(
        descriptor.tag === 'textarea'
          ? textAction(
              descriptor,
              candidate.coverLetterText,
              'Uses the tailored cover letter that was reviewed before starting the assistant.',
            )
          : review(descriptor, 'Short motivation field needs a job-specific answer. Write it yourself.'),
      );
    } else if (descriptor.tag === 'textarea') {
      actions.push(review(descriptor, 'Open-ended question. The assistant will not invent an answer.'));
    } else {
      actions.push(review(descriptor, 'Field purpose not recognised. Complete it yourself.'));
    }
  }

  for (const action of actions) {
    if (action.kind !== 'skip') continue;
    if (
      visible.find((descriptor) => descriptor.index === action.index)?.required &&
      !unanswered.includes(action.label)
    ) {
      unanswered.push(action.label);
    }
  }

  for (const action of actions) {
    if (action.kind === 'skip') {
      reviewFields.push({
        label: action.label,
        reason: action.reason,
        fieldType: action.fieldType,
      });
    }
  }

  return {
    actions,
    reviewFields,
    unanswered,
    fieldsDetected: visible.length,
  };
}

export function optionValue(descriptor: FieldDescriptor, action: FormAction): string {
  if (action.kind !== 'select') return action.value;
  return optionAnswer(descriptor, action.value) || action.value;
}
