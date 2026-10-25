import { normalizeWhitespace } from '../../utils/text.js';
import type { JobLanguage, LanguageDecision, LanguageRequirement } from './types.js';

export type { JobLanguage, LanguageDecision } from './types.js';

export interface LanguageClassification {
  jobLanguage: JobLanguage;
  englishRequired: boolean | null;
  germanRequired: boolean | null;
  germanOptional: boolean | null;
  languageEvidence: string;
  languageConfidence: number;
  languageDecision: LanguageDecision;
  languageReason: string;
  /** Backwards-compatible single-value classification used by matching and older UI code. */
  languageRequirement: LanguageRequirement;
}

const GERMAN = 'german|deutsch[a-zäöüß]*';
const LEVEL =
  'b1|b2|c1|c2|native|mother tongue|muttersprach[a-zäöüß]*|fluent|fluency|fließend|fliessend|verhandlungssicher|proficient|professional working|business';
const REQUIRED_WORD =
  'required|mandatory|must have|must be|must|essential|necessary|erforderlich|notwendig|zwingend|vorausgesetzt|benötigt|noetig|nötig';

const REQUIRED_AFTER_GERMAN = new RegExp(
  `\\b(?:${GERMAN})\\b[^,.;\\n]{0,90}(?:\\b(?:${REQUIRED_WORD})\\b|\\b(?:${LEVEL})\\b)`,
  'i',
);
const REQUIRED_BEFORE_GERMAN = new RegExp(
  `(?:\\b(?:${REQUIRED_WORD})\\b|\\b(?:${LEVEL})\\b)[^,.;\\n]{0,90}\\b(?:${GERMAN})\\b`,
  'i',
);
const GERMAN_NEGATED = new RegExp(
  `\\b(?:${GERMAN})\\b[^,.;\\n]{0,60}\\b(?:not required|not necessary|not mandatory|not needed|not essential|isn't required|is not required|nicht erforderlich|nicht notwendig|nicht zwingend|nicht vorausgesetzt|nicht nötig|nicht noetig)\\b`,
  'i',
);
const GERMAN_NEGATED_REVERSE =
  /\b(?:no german|without german|no deutsch|keine deutschkenntnisse|kein deutsch|ohne deutschkenntnisse|ohne deutsch)\b/i;
const GERMAN_OPTIONAL = new RegExp(
  `\\b(?:${GERMAN})\\b[^,.;\\n]{0,90}\\b(?:a plus|a bonus|plus|preferred|preferable|advantage|advantageous|beneficial|nice to have|wünschenswert|wuenschenswert|von vorteil|bonus|optional|helpful)\\b`,
  'i',
);
const GERMAN_OPTIONAL_BEFORE = new RegExp(
  `\\b(?:a plus|a bonus|plus|preferred|preferable|advantage|advantageous|beneficial|nice to have|wünschenswert|wuenschenswert|von vorteil|bonus|optional|helpful)\\b[^,.;\\n]{0,60}\\b(?:${GERMAN})\\b`,
  'i',
);
const ENGLISH_REQUIRED = new RegExp(
  `\\benglish\\b[^,.;\\n]{0,90}\\b(?:required|mandatory|fluent|fluency|proficient|professional|business|working language|c1|c2|native|mother tongue|essential)\\b`,
  'i',
);
const ENGLISH_REQUIRED_BEFORE = new RegExp(
  `\\b(?:required|mandatory|fluent|fluency|proficient|professional|business|working language|c1|c2|native|mother tongue|essential)\\b[^,.;\\n]{0,90}\\benglish\\b`,
  'i',
);
const ENGLISH_WORKING_LANGUAGE =
  /\benglish\s+(?:is\s+)?(?:our|the)\s+(?:working|business|company|team|office)\s+language\b/i;
const OTHER_LANGUAGE_REQUIRED =
  /\b(?:french|spanish|dutch|italian|polish|portuguese|danish|swedish|norwegian|finnish|czech|turkish|arabic|mandarin|chinese)\b[^,.;\n]{0,70}\b(?:required|mandatory|fluent|fluency|proficient|b1|b2|c1|c2|native)\b/i;

const GERMAN_MENTION = new RegExp(`\\b(?:${GERMAN})\\b`, 'i');
const ENGLISH_MENTION = /\benglish\b/i;
const GERMAN_WORDS =
  /\b(?:und|oder|wir|sie|mit|für|fuer|unsere|unser|deine|dein|bei|als|ist|sind|werden|kenntnisse|erfahrung|aufgaben|profil|bewerbung|team)\b/gi;

function evidenceFor(description: string, patterns: RegExp[]): string {
  const sentences = normalizeWhitespace(description)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const matches = sentences.filter((sentence) => patterns.some((pattern) => pattern.test(sentence)));
  if (matches.length > 0) return matches.slice(0, 2).join(' ').slice(0, 400);

  for (const pattern of patterns) {
    const match = pattern.exec(description);
    if (match?.index !== undefined) {
      const start = Math.max(0, match.index - 40);
      return description.slice(start, Math.min(description.length, match.index + match[0].length + 80)).trim().slice(0, 400);
    }
  }
  return '';
}

function germanWordRatio(text: string): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const hits = text.match(GERMAN_WORDS)?.length ?? 0;
  return hits / words.length;
}

/**
 * Deterministic language classification for one vacancy.
 *
 * This is intentionally evidence-first and conservative: a vacancy is only
 * automatically eligible when the text shows that English is acceptable or that German is
 * optional/not required. A posting that simply does not mention language at all is marked
 * Needs Review rather than assumed to be English-friendly.
 */
export function classifyLanguage(input: {
  title: string;
  location?: string | null;
  description?: string | null;
}): LanguageClassification {
  const description = normalizeWhitespace(input.description ?? '');
  const text = `${input.title}\n${input.location ?? ''}\n${description}`;
  const sample = text.slice(0, 20_000);

  const germanNegated = GERMAN_NEGATED.test(sample) || GERMAN_NEGATED_REVERSE.test(sample);
  const germanRequired =
    !germanNegated && (REQUIRED_AFTER_GERMAN.test(sample) || REQUIRED_BEFORE_GERMAN.test(sample));
  const germanOptional =
    !germanNegated &&
    !germanRequired &&
    (GERMAN_OPTIONAL.test(sample) || GERMAN_OPTIONAL_BEFORE.test(sample));
  const englishRequired =
    ENGLISH_REQUIRED.test(sample) ||
    ENGLISH_REQUIRED_BEFORE.test(sample) ||
    ENGLISH_WORKING_LANGUAGE.test(sample);
  const otherLanguageRequired = OTHER_LANGUAGE_REQUIRED.test(sample);

  const mentionsGerman = GERMAN_MENTION.test(sample);
  const mentionsEnglish = ENGLISH_MENTION.test(sample);

  const germanPatterns = germanRequired
    ? [REQUIRED_AFTER_GERMAN, REQUIRED_BEFORE_GERMAN, GERMAN_OPTIONAL]
    : germanNegated
      ? [GERMAN_NEGATED, GERMAN_NEGATED_REVERSE, GERMAN_OPTIONAL]
      : germanOptional
        ? [GERMAN_OPTIONAL, GERMAN_OPTIONAL_BEFORE]
        : [];
  const englishPatterns = [ENGLISH_REQUIRED, ENGLISH_REQUIRED_BEFORE, ENGLISH_WORKING_LANGUAGE];
  const evidence = evidenceFor(
    description,
    germanPatterns.length > 0 ? [...germanPatterns, ...englishPatterns] : englishPatterns,
  );

  let decision: LanguageDecision;
  let reason: string;

  if (germanRequired) {
    decision = 'Excluded';
    reason =
      'The posting explicitly requires German proficiency, so it is excluded from the English-first queue.';
  } else if (germanNegated || germanOptional) {
    decision = 'Eligible';
    reason = germanNegated
      ? 'The posting explicitly states that German is not required.'
      : 'German is described as optional or an advantage, not a requirement.';
  } else if (englishRequired) {
    decision = 'Eligible';
    reason = mentionsGerman
      ? 'English is required or used as the working language, and no mandatory German requirement was found.'
      : 'English is required or used as the working language. German is not mentioned.';
  } else if (!mentionsGerman && mentionsEnglish) {
    decision = 'Eligible';
    reason =
      'English is mentioned and German is not, so this is provisionally eligible; the language requirement was not explicitly verified.';
  } else if (otherLanguageRequired) {
    decision = 'Needs Review';
    reason =
      'The posting names another mandatory language. Verify that it is compatible with your documented languages before applying.';
  } else if (mentionsGerman) {
    decision = 'Needs Review';
    reason =
      'German is mentioned but the requirement is ambiguous. Read the listing before deciding whether to apply.';
  } else {
    decision = 'Needs Review';
    reason = 'The posting does not clearly state its working language. Verify it manually.';
  }

  let jobLanguage: JobLanguage;
  if (germanRequired && englishRequired) jobLanguage = 'Mixed';
  else if (germanRequired) jobLanguage = 'German';
  else if (mentionsEnglish && (mentionsGerman || germanOptional)) jobLanguage = 'Mixed';
  else if (mentionsEnglish) jobLanguage = 'English';
  else if (mentionsGerman && germanWordRatio(description) >= 0.08) jobLanguage = 'German';
  else if (mentionsGerman) jobLanguage = 'German';
  else jobLanguage = 'Unknown';

  let confidence: number;
  if (germanRequired) {
    confidence = REQUIRED_AFTER_GERMAN.test(sample) || REQUIRED_BEFORE_GERMAN.test(sample) ? 92 : 80;
    if (new RegExp(`\\b(?:${GERMAN})\\b[^,.;\\n]{0,40}\\b(?:${LEVEL})\\b`, 'i').test(sample)) {
      confidence = 97;
    }
  } else if (germanNegated) {
    confidence = 95;
  } else if (germanOptional) {
    confidence = 88;
  } else if (englishRequired) {
    confidence = mentionsGerman ? 82 : 78;
  } else if (!mentionsGerman && mentionsEnglish) {
    confidence = 60;
  } else if (otherLanguageRequired) {
    confidence = 45;
  } else {
    confidence = 30;
  }
  if (decision === 'Needs Review') confidence = Math.min(confidence, 55);
  confidence = Math.max(10, Math.min(98, Math.round(confidence)));

  const englishOnly = englishRequired && !mentionsGerman;
  const languageRequirement: LanguageRequirement = germanRequired
    ? 'german_required'
    : germanNegated
      ? 'german_not_required'
      : germanOptional
        ? 'german_preferred'
        : englishOnly || englishRequired
          ? 'english_ok'
          : 'unknown';

  return {
    jobLanguage,
    englishRequired: englishRequired ? true : null,
    germanRequired: germanRequired ? true : germanNegated ? false : null,
    germanOptional: germanOptional ? true : germanRequired ? false : null,
    languageEvidence: evidence,
    languageConfidence: confidence,
    languageDecision: decision,
    languageReason: reason,
    languageRequirement,
  };
}

/** Convenience wrapper kept for callers that only need the legacy enum. */
export function detectLanguageRequirement(text: string): LanguageRequirement {
  return classifyLanguage({ title: '', description: text }).languageRequirement;
}
