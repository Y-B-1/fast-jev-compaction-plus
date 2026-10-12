import { messageChars } from './compact.js';
import { TYPED_WORK } from './exchanges.js';
import { type NotificationOptions, askNoul } from './notifications.js';
import { PROSE_KEEP_LADDER } from './prose.js';
import { sha256Hex } from './sha256.js';
import { MARKER, isHostOnly, isPinned, isPromptRow, resultPreview } from './state.js';
import type { CompactResult, JevAsker, JevQuestions, Message, NoulQuestion } from './types.js';

/**
 * Step trim: the finest unit of work the history can lose without breaking. A step is one closed
 * run of assistant rows with the result rows of their tool calls, a text-only reply, or a
 * user row made only of whole host blocks (a reminder, a report, command output). When earlier stages fall short, Jev scores each
 * step and the stage archives whole steps, each replaced by one assistant marker row naming its
 * file. Prompt rows, row 0, the pinned recent rows and rows holding typed text are never part of a
 * step, so every word the user typed stays verbatim.
 *
 * Two passes on one set of scores: `trim` walks the prose ladder over steps before the last prompt,
 * then `fill` adds the lowest-scored steps of any age, the current task's included, until the
 * target is met.
 */

/** A step smaller than this is not worth its marker. */
export const STEP_MIN_CHARS = 1_200;
const NOTE_CHARS = 200;

export type Step = {
  key: string;
  /** Rows `[from, to)`. */
  from: number;
  to: number;
  /** After the last prompt: part of the current task. */
  current: boolean;
  chars: number;
  tools: Map<string, number>;
};

export type StepStats = {
  eligible: number;
  scored: number;
  archived: number;
  charsSaved: number;
  requests: number;
  failedRequests: number;
  stateTokens: number;
  failed?: string;
};

export type StepScores = {
  messages: readonly Message[];
  steps: Step[];
  noul: ReadonlyMap<string, number | undefined>;
  stats: StepStats;
};

export type StepPlan = { step: Step; id: string; text: string; path: string; row: Message; saved: number };

export type StepApplied = {
  messages: Message[];
  archived: { id: string; text: string; path: string }[];
  stats: StepStats;
};

const typed = (m: Message): boolean => [m.text, ...(m.toolResults ?? []).map((r) => r.text)].some((t) => TYPED_WORK.test(t));

/** The steps of `messages` at least `minChars` long, outside row 0 and the pinned recent rows. */
export function findSteps(messages: readonly Message[], preserveRecentMessages: number, minChars: number = STEP_MIN_CHARS): Step[] {
  const total = messages.length;
  const pinned = (i: number) => isPinned(i, total, preserveRecentMessages);
  let lastPrompt = -1;
  messages.forEach((m, i) => {
    if (isPromptRow(m)) lastPrompt = i;
  });
  const out: Step[] = [];
  const push = (from: number, to: number) => {
    let chars = 0;
    const tools = new Map<string, number>();
    for (let i = from; i < to; i++) {
      const m = messages[i] as Message;
      chars += messageChars(m);
      for (const use of m.toolUses) tools.set(use.tool, (tools.get(use.tool) ?? 0) + 1);
    }
    if (chars >= minChars) out.push({ key: `s${out.length + 1}`, from, to, current: from > lastPrompt, chars, tools });
  };
  let i = 1;
  while (i < total && !pinned(i)) {
    const m = messages[i] as Message;
    if (m.role === 'user') {
      if ((m.toolResults ?? []).length === 0 && isHostOnly(m.text) && !typed(m)) push(i, i + 1);
      i++;
      continue;
    }
    const open = new Set<string>();
    let ok = true;
    let j = i;
    while (j < total && !pinned(j)) {
      const r = messages[j] as Message;
      if (r.role === 'assistant') {
        if (j > i && open.size === 0) break;
        for (const use of r.toolUses) open.add(use.tool_use_id);
      } else {
        if ((r.toolResults ?? []).length === 0) break;
        if (typed(r)) ok = false;
        for (const res of r.toolResults ?? []) if (!open.delete(res.tool_use_id)) ok = false;
      }
      j++;
    }
    if (ok && open.size === 0) push(i, j);
    i = Math.max(j, i + 1);
  }
  return out;
}

function lastText(messages: readonly Message[], step: Step): string {
  for (let i = step.to - 1; i >= step.from; i--) {
    const m = messages[i] as Message;
    if (m.role === 'assistant' && m.text.trim().length > 0) return m.text.trim();
  }
  return '';
}

function toolList(tools: ReadonlyMap<string, number>): string {
  return [...tools].map(([name, n]) => (n > 1 ? `${name} x${n}` : name)).join(', ');
}

function question(step: Step, messages: readonly Message[], previewChars: number): JevQuestions[string] {
  const first = messages[step.from] as Message;
  const text = first.role === 'user' ? first.text : lastText(messages, step);
  const preview = resultPreview(text, previewChars);
  const q: NoulQuestion = {
    type: 'noul',
    instructions: `The ${step.to - step.from > 1 ? `work in \`history\` entries ${step.from} to ${step.to - 1}` : `\`history\` entry ${step.from}`} (${step.chars} chars) should stay in \`history\` in full: the assistant still needs its exact details for the user's latest requests. Tools: ${toolList(step.tools) || 'none'}. Text: ${preview || '(none)'}`,
    criteria: {
      true: 'The current work still uses these exact details: file contents, values, errors or decisions it refers to, or an open step it continues',
      false: 'The step is done and its outcome is already stated elsewhere or no longer matters: a finished check, a replaced attempt, output already acted on, a restated reply',
    },
  };
  return q;
}

const emptyStats = (): StepStats => ({ eligible: 0, scored: 0, archived: 0, charsSaved: 0, requests: 0, failedRequests: 0, stateTokens: 0 });

/** Asks Jev once per step whether it must stay. Nothing is changed yet; a total failure sets `stats.failed`. */
export async function scoreSteps(
  messages: readonly Message[],
  asker: JevAsker,
  options: NotificationOptions,
  only?: (step: Step) => boolean,
): Promise<StepScores> {
  const stats = emptyStats();
  try {
    const steps = findSteps(messages, options.preserveRecentMessages).filter((s) => !only || only(s));
    stats.eligible = steps.length;
    if (steps.length === 0) return { messages, steps, noul: new Map(), stats };
    const questions = steps.map((s) => [s.key, question(s, messages, options.resultPreviewChars)] as const);
    const asked = await askNoul(messages, questions, asker, options);
    stats.requests = asked.requests;
    stats.failedRequests = asked.failedRequests;
    stats.stateTokens = asked.stateTokens;
    stats.scored = [...asked.noul.values()].filter((v) => v !== undefined).length;
    if (asked.failed !== undefined) return { messages, steps: [], noul: new Map(), stats: { ...stats, failed: asked.failed } };
    return { messages, steps, noul: asked.noul, stats };
  } catch (error) {
    return { messages, steps: [], noul: new Map(), stats: { ...stats, failed: error instanceof Error ? error.message : String(error) } };
  }
}

/** The rows of a step as one plain-text file: each row's role, text, tool calls with inputs, and results. */
export function renderStep(messages: readonly Message[], step: Step): string {
  const parts: string[] = [];
  for (let i = step.from; i < step.to; i++) {
    const m = messages[i] as Message;
    if (m.text.length > 0) parts.push(`${m.role} (entry ${i}):\n${m.text}`);
    for (const use of m.toolUses) parts.push(`tool call ${use.tool} (${use.tool_use_id}):\n${JSON.stringify(use.input, null, 2)}`);
    for (const result of m.toolResults ?? []) parts.push(`tool result (${result.tool_use_id})${result.isError ? ' error' : ''}:\n${result.text}`);
  }
  return parts.join('\n\n');
}

/** The archive file, marker row and net saving of each scored step; a step the marker would not shrink is left out. */
export function planSteps(scores: StepScores, pathOf: (id: string) => string): StepPlan[] {
  if (scores.stats.failed !== undefined) return [];
  const plans: StepPlan[] = [];
  for (const step of scores.steps) {
    if (scores.noul.get(step.key) === undefined) continue;
    const text = renderStep(scores.messages, step);
    const id = `step-${sha256Hex(text).slice(0, 12)}`;
    const path = pathOf(id);
    const calls = [...step.tools.values()].reduce((a, b) => a + b, 0);
    const note = lastText(scores.messages, step);
    const marker = `${MARKER}archived ${step.to - step.from} row${step.to - step.from > 1 ? 's' : ''} of earlier work${
      calls > 0 ? `, ${calls} tool call${calls > 1 ? 's' : ''} (${toolList(step.tools)})` : ''
    }, ${step.chars} chars; full text: ${path} (Read it if needed)]`;
    const row: Message = {
      role: 'assistant',
      text: note ? `${marker}\nNote: ${note.length > NOTE_CHARS ? `${note.slice(0, NOTE_CHARS)}…` : note}` : marker,
      toolUses: [],
    };
    const saved = step.chars - messageChars(row);
    if (saved > 0) plans.push({ step, id, text, path, row, saved });
  }
  return plans;
}

/** Replaces each chosen step's rows with its marker row. Untouched rows come back as the same objects. */
export function applySteps(scores: StepScores, chosen: readonly StepPlan[]): StepApplied {
  const at = new Map(chosen.map((p) => [p.step.from, p]));
  const out: Message[] = [];
  for (let i = 0; i < scores.messages.length; i++) {
    const hit = at.get(i);
    if (hit) {
      out.push(hit.row);
      i = hit.step.to - 1;
    } else out.push(scores.messages[i] as Message);
  }
  return {
    messages: out,
    archived: chosen.map((p) => ({ id: p.id, text: p.text, path: p.path })),
    stats: { ...scores.stats, archived: chosen.length, charsSaved: chosen.reduce((a, p) => a + p.saved, 0) },
  };
}

export type StepOutcome = { pass: 'trim' | 'fill'; cutoff?: number; result: CompactResult; applied: StepApplied };

/**
 * Picks the steps to archive so that `result` reaches `minRatio` against its `charsBefore`:
 * first the `trim` pass, the prose ladder over steps before the last prompt; then the `fill` pass,
 * every scored step from the lowest noul up (older first on a tie) until the target is met.
 * Undefined when even every planned step falls short.
 */
export function stepLadder(
  scores: StepScores,
  result: CompactResult,
  minRatio: number,
  pathOf: (id: string) => string,
): StepOutcome | undefined {
  const plans = planSteps(scores, pathOf);
  if (plans.length === 0) return undefined;
  const { charsBefore, charsAfter } = result.stats;
  const reaches = (saved: number) => charsBefore > 0 && (charsBefore - (charsAfter - saved)) / charsBefore >= minRatio;
  const finish = (pass: StepOutcome['pass'], chosen: StepPlan[], cutoff?: number): StepOutcome => {
    const applied = applySteps(scores, chosen);
    const after = applied.messages.reduce((sum, m) => sum + messageChars(m), 0);
    const out = { ...result, messages: applied.messages, stats: { ...result.stats, charsAfter: after } };
    return { pass, ...(cutoff !== undefined ? { cutoff } : {}), result: out, applied };
  };
  const noul = (p: StepPlan) => scores.noul.get(p.step.key) as number;
  for (const cutoff of PROSE_KEEP_LADDER) {
    const chosen = plans.filter((p) => !p.step.current && noul(p) < cutoff);
    if (chosen.length > 0 && reaches(chosen.reduce((a, p) => a + p.saved, 0))) return finish('trim', chosen, cutoff);
  }
  const ranked = [...plans].sort((a, b) => noul(a) - noul(b) || a.step.from - b.step.from);
  let saved = 0;
  for (let n = 0; n < ranked.length; n++) {
    saved += (ranked[n] as StepPlan).saved;
    if (reaches(saved)) return finish('fill', ranked.slice(0, n + 1));
  }
  return undefined;
}

/** For a compaction that already met its target: archives only steps before the last prompt that Jev scores below the mildest cut-off. */
export function mildSteps(scores: StepScores, result: CompactResult, pathOf: (id: string) => string): StepOutcome | undefined {
  const cutoff = PROSE_KEEP_LADDER[0] as number;
  const chosen = planSteps(scores, pathOf).filter((p) => !p.step.current && (scores.noul.get(p.step.key) as number) < cutoff);
  if (chosen.length === 0) return undefined;
  const applied = applySteps(scores, chosen);
  const after = applied.messages.reduce((sum, m) => sum + messageChars(m), 0);
  return { pass: 'trim', cutoff, result: { ...result, messages: applied.messages, stats: { ...result.stats, charsAfter: after } }, applied };
}

