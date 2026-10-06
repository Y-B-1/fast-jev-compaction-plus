// Dev-only: answering prompts, scoring and the pass bar (docs/prose-trim-design.md, Fact-recall eval).
import { tokenKind, type Category, type Question } from './questions.js';

export type Outcome = 'pass' | 'wrong' | 'unknown';
export interface Scored {
  question: Question;
  outcome: Outcome;
}

export const answerPrompt = (armOutput: string, q: Question): string =>
  `Answer the question using ONLY the text below. ${
    tokenKind(q.category)
      ? 'Reply with the single exact value only (no sentence, no extra words), or exactly UNKNOWN if the text does not say.'
      : 'Reply with the answer alone, or exactly UNKNOWN if the text does not say.'
  }

TEXT
${armOutput}

QUESTION
${q.question}`;

export const judgePrompt = (gold: string, answer: string): string =>
  `Does the ANSWER state the same fact as the GOLD answer? Reply with exactly CORRECT or INCORRECT.

GOLD
${gold}

ANSWER
${answer}`;

/** Lowercase, collapse whitespace, strip surrounding quotes/backticks and trailing punctuation. */
export const normalize = (s: string): string =>
  s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/^[`'"]+/, '').replace(/[`'",.;]+$/, '').trim();

/** UNKNOWN, or UNKNOWN followed by ( : , - or an em dash; never when the gold itself starts with "unknown". */
const isUnknown = (answer: string, gold: string): boolean => {
  if (normalize(gold).startsWith('unknown')) return false;
  const n = normalize(answer);
  return n === 'unknown' || /^unknown ?[(:,\-\u2014]/.test(n);
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A character that continues a path, number or identifier; a dot only when a word character follows. */
const CONT = '[\\p{L}\\p{N}_/\\\\-]';

const CANDIDATES: Partial<Record<Category, RegExp>> = {
  number: /\d+(?:\.\d+)?/gu,
  path: /[\p{L}\p{N}_./\\-]+/gu,
  id: /(?<![\p{L}\p{N}_-])(?:[0-9a-f]{7,}|[a-z]+-\d+)(?![\p{L}\p{N}_-])/gu,
};
const pathLike = (t: string): boolean => /[/\\]/.test(t) || /\w\.\p{L}[\p{L}\p{N}]+$/u.test(t);

/** Whole-token match, and no other distinct candidate of the gold's kind (number, path, id) in the answer. Error golds: whole-token only. */
function tokenMatch(answer: string, gold: string, category: Category): boolean {
  const g = normalize(gold);
  if (!g) return false;
  const a = normalize(answer);
  const whole = new RegExp(`(?<!${CONT}|[\\p{L}\\p{N}_][.])${escapeRe(g)}(?!${CONT}|[.][\\p{L}\\p{N}_])`, 'gu');
  if (!whole.test(a)) return false;
  const re = CANDIDATES[category];
  if (!re) return true;
  const rest = a.replace(whole, ' ');
  return !(rest.match(re) ?? []).map((t) => t.replace(/[.:]+$/, '')).some((t) => category !== 'path' || pathLike(t));
}

/** UNKNOWN scores unknown (unless the gold starts with "unknown"). Token questions: the gold must appear as a whole token and, with its occurrences removed, the answer must hold no other candidate. Others: the judge sees only gold and answer. */
export function scoreAnswer(q: Question, answer: string, judge?: (prompt: string) => string): { outcome: Outcome } {
  if (isUnknown(answer, q.gold)) return { outcome: 'unknown' };
  if (tokenKind(q.category)) return { outcome: tokenMatch(answer, q.gold, q.category) ? 'pass' : 'wrong' };
  if (!judge) throw new Error('judge required for a non-token question');
  return { outcome: /^\s*CORRECT\b/i.test(judge(judgePrompt(q.gold, answer))) ? 'pass' : 'wrong' };
}

export interface Metrics {
  total: number;
  recall: number;
  /** Path, number, ID and error questions, wherever the evidence sits. */
  tokenRecall: number;
  /** assistant-prose tag. */
  proseEvidenceRecall: number;
  /** prose-input and code-body tags. */
  inputEvidenceRecall: number;
  inputByField: Record<string, { pass: number; total: number }>;
  wrongRate: number;
}

const rate = (rows: Scored[]): number => (rows.length ? rows.filter((r) => r.outcome === 'pass').length / rows.length : NaN);
const isInput = (r: Scored) => r.question.tag === 'prose-input' || r.question.tag === 'code-body';

export function aggregate(rows: Scored[]): Metrics {
  const inputByField: Metrics['inputByField'] = {};
  for (const r of rows.filter(isInput)) {
    const k = r.question.field ?? '(unspecified)';
    const e = (inputByField[k] ??= { pass: 0, total: 0 });
    e.total++;
    if (r.outcome === 'pass') e.pass++;
  }
  return {
    total: rows.length,
    recall: rate(rows),
    tokenRecall: rate(rows.filter((r) => tokenKind(r.question.category))),
    proseEvidenceRecall: rate(rows.filter((r) => r.question.tag === 'assistant-prose')),
    inputEvidenceRecall: rate(rows.filter(isInput)),
    inputByField,
    wrongRate: rows.length ? rows.filter((r) => r.outcome === 'wrong').length / rows.length : NaN,
  };
}

/** Variant bar (recall vs S is T12's). An empty group is NaN and fails. */
export function passBar(m: Metrics): { pass: boolean; failed: string[] } {
  const failed: string[] = [];
  if (!(m.recall >= 0.95)) failed.push('recall');
  if (!(m.tokenRecall >= 0.98)) failed.push('tokenRecall');
  if (!(m.proseEvidenceRecall >= 0.9)) failed.push('proseEvidenceRecall');
  if (!(m.inputEvidenceRecall >= 0.9)) failed.push('inputEvidenceRecall');
  if (!(m.wrongRate <= 0.02)) failed.push('wrongRate');
  return { pass: failed.length === 0, failed };
}
