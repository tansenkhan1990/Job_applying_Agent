import { normalizeForMatch } from '../../utils/text.js';

export interface GroundingResult {
  passed: boolean;
  unsupportedTerms: string[];
  unsupportedNumbers: string[];
  notes: string[];
}

const TECH_TERMS = [
  'javascript',
  'typescript',
  'react',
  'next.js',
  'node.js',
  'express',
  'graphql',
  'rest',
  'postgresql',
  'postgres',
  'mongodb',
  'mysql',
  'redis',
  'docker',
  'kubernetes',
  'terraform',
  'ansible',
  'aws',
  'azure',
  'gcp',
  'google cloud',
  'linux',
  'ci/cd',
  'github actions',
  'gitlab',
  'jenkins',
  'prometheus',
  'grafana',
  'python',
  'fastapi',
  'django',
  'flask',
  'langchain',
  'langgraph',
  'llm',
  'rag',
  'openai',
  'mcp',
  'vector database',
  'embeddings',
  'machine learning',
  'nlp',
  'pytorch',
  'tensorflow',
  'pandas',
  'numpy',
  'java',
  'spring boot',
  'kotlin',
  'go',
  'rust',
  'c#',
  '.net',
  'php',
  'laravel',
  'vue',
  'angular',
  'svelte',
  'tailwind',
  'html',
  'css',
  'kafka',
  'rabbitmq',
  'elasticsearch',
  'microservices',
  'serverless',
  'lambda',
  's3',
  'ec2',
  'eks',
];

const PLACEHOLDER_PATTERN = /\[(?:company|role|position|your name|name|date|hiring manager|job title)\]|\{\{[^}]+\}\}/i;

function findTerms(letter: string): string[] {
  const normalized = normalizeForMatch(letter);
  return TECH_TERMS.filter((term) => {
    const pattern = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
    return pattern.test(normalized);
  });
}

function findNumbers(letter: string): string[] {
  const matches = letter.match(/\b\d{2,}(?:[.,]\d+)?%?\+?|\b\d+\+/g) ?? [];
  return [...new Set(matches.map((item) => item.trim()))].filter((item) => {
    const numeric = Number.parseInt(item.replace(/[^\d]/g, ''), 10);
    // Years are commonly part of dates and not claims about achievements.
    if (numeric >= 1990 && numeric <= 2035 && !item.includes('%')) return false;
    return true;
  });
}

/**
 * Deterministic grounding check. It is deliberately conservative and is a
 * review aid, not proof that every sentence is true.
 */
export function checkGrounding(input: {
  letterText: string;
  subjectLine?: string;
  sources: string[];
}): GroundingResult {
  const notes: string[] = [];
  const corpus = normalizeForMatch(input.sources.filter(Boolean).join('\n'));
  const letter = `${input.subjectLine ?? ''}\n${input.letterText}`;

  if (PLACEHOLDER_PATTERN.test(letter)) {
    notes.push('The letter contains an unresolved placeholder.');
  }
  if (input.letterText.trim().length < 120) {
    notes.push('The letter is unusually short.');
  }
  if (input.letterText.trim().length > 4000) {
    notes.push('The letter may be too long for a concise application.');
  }
  if (!/\b(dear|hello|hi)\b/i.test(input.letterText.slice(0, 200))) {
    notes.push('No greeting was detected.');
  }

  const unsupportedTerms = findTerms(letter).filter((term) => {
    const pattern = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
    return !pattern.test(corpus);
  });

  const supportedNumbers = new Set((corpus.match(/\b\d{2,}(?:[.,]\d+)?%?\+?|\b\d+\+/g) ?? []).map((n) => n.trim()));
  const unsupportedNumbers = findNumbers(letter).filter((number) => !supportedNumbers.has(number));

  if (unsupportedTerms.length > 0) {
    notes.push(
      `These technologies/terms are not present in the verified source material: ${unsupportedTerms.join(', ')}.`,
    );
  }
  if (unsupportedNumbers.length > 0) {
    notes.push(
      `These numeric claims are not supported by the source material: ${unsupportedNumbers.join(', ')}.`,
    );
  }

  return {
    passed:
      unsupportedTerms.length === 0 &&
      unsupportedNumbers.length === 0 &&
      !PLACEHOLDER_PATTERN.test(letter) &&
      input.letterText.trim().length >= 120,
    unsupportedTerms,
    unsupportedNumbers,
    notes,
  };
}
