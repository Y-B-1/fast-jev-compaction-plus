// Dev-only: fact-recall question files. Cached in ~/.claude/fast-jev-eval/cache/ by the caller; this module takes the dir.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CATEGORIES = ['decision', 'path', 'number', 'id', 'error', 'open-task', 'instruction'] as const;
export type Category = (typeof CATEGORIES)[number];
/** assistant prose, tool result, user text, prose input (unpinned tool-input prose), code body. */
export const TAGS = ['assistant-prose', 'tool-result', 'user-text', 'prose-input', 'code-body'] as const;
export type Tag = (typeof TAGS)[number];

export interface Question {
  id: string;
  caseId: string;
  question: string;
  gold: string;
  evidence: string;
  category: Category;
  tag: Tag;
  /** Input tags only: the tool field holding the sole evidence, e.g. "Write.content". */
  field?: string;
}
export interface QuestionFile {
  questions: Question[];
  /** Questions the original failed and that were dropped. */
  dropped: number;
  model: string;
}

/** Path, number, ID and error questions are scored on the normalized gold token. */
export const tokenKind = (c: Category): boolean => c === 'path' || c === 'number' || c === 'id' || c === 'error';

export function questionPrompt(history: string, pinnedTail: number): string {
  return `Below is a coding-session history. Write 15-25 recall questions about it, each answerable from the history alone.
Only facts first stated before the pinned tail (the last ${pinnedTail} messages) count.
Reply with ONLY a JSON array of objects: {"question","gold","evidence","category","tag","field"}.
- gold: a short answer; for path, number and id and error questions the exact token.
- evidence: a short verbatim quote proving the gold answer.
- category: one of ${CATEGORIES.join(', ')}.
- tag: where the sole evidence sits: ${TAGS.join(', ')}. prose-input and code-body apply only when the sole evidence is in a tool input (field names it, e.g. "Write.content").

HISTORY
${history}`;
}

/** Tolerates a code fence. Drops entries with a bad category or tag and counts them. */
export function parseQuestions(caseId: string, reply: string): { questions: Question[]; invalid: number; malformed?: true } {
  const body = reply.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  let arr: unknown;
  try {
    arr = JSON.parse(body);
  } catch {
    return { questions: [], invalid: 0, malformed: true };
  }
  if (!Array.isArray(arr)) return { questions: [], invalid: 0, malformed: true };
  const questions: Question[] = [];
  let invalid = 0;
  arr.forEach((o: any, i) => {
    const ok =
      o && typeof o.question === 'string' && typeof o.gold === 'string' && typeof o.evidence === 'string' &&
      (CATEGORIES as readonly string[]).includes(o.category) && (TAGS as readonly string[]).includes(o.tag);
    if (!ok) return void invalid++;
    const qn: Question = { id: `${caseId}:${i}`, caseId, question: o.question, gold: o.gold, evidence: o.evidence, category: o.category, tag: o.tag };
    if (typeof o.field === 'string') qn.field = o.field;
    questions.push(qn);
  });
  return { questions, invalid };
}

/** `originalPassed` maps question id to whether the answerer got it right from the ORIGINAL; failures are dropped and counted. */
export function dropFailed(qs: Question[], originalPassed: Map<string, boolean>): { kept: Question[]; dropped: number } {
  const kept = qs.filter((q) => originalPassed.get(q.id) === true);
  return { kept, dropped: qs.length - kept.length };
}

export const cacheFile = (dir: string, caseId: string): string => join(dir, `${caseId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);

export function loadQuestions(dir: string, caseId: string): QuestionFile | undefined {
  const f = cacheFile(dir, caseId);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as QuestionFile) : undefined;
}

export function saveQuestions(dir: string, caseId: string, questions: Question[], meta: { dropped: number; model: string }): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(cacheFile(dir, caseId), JSON.stringify({ questions, ...meta } satisfies QuestionFile, null, 2) + '\n');
}
