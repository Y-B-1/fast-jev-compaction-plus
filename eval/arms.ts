// Dev-only: the six arms of the fact-recall eval (docs/prose-trim-design.md, Arms). Offline: the caller injects the asker.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compact, DEFAULT_OPTIONS, messageChars, reductionRatio } from '../src/compact.js';
import { callActions, trimProse } from '../src/prose.js';
import { goalFromMessages } from '../src/state.js';
import type { JevAsker, Message } from '../src/types.js';
import type { BResult } from './b-runner.js';
import type { Case } from './load.js';

export const ARMS = ['O', 'T0', 'BI', 'S', 'A', 'B'] as const;
export type Arm = (typeof ARMS)[number];

/** The hook's default `minReductionRatio`: S ships T0 at or above it, else the built-in summary. */
export const MIN_REDUCTION = 0.25;

export interface ArmDeps {
  asker: JevAsker;
}
export interface Arms {
  /** Output text per arm; an arm that has none for this case (no built-in summary, no B file) is absent. */
  text: Partial<Record<Arm, string>>;
  /** Reduction of T0 and of A (T0 then trim), as a share of the original chars. */
  t0Ratio: number;
  aRatio: number;
}

/** What an answerer sees of a history: role, text, tool calls with their input, and tool results. */
export function renderMessages(messages: readonly Message[]): string {
  return messages
    .map((m) =>
      [
        `[${m.role}]${m.text ? ` ${m.text}` : ''}`,
        ...m.toolUses.map((t) => `[tool_use ${t.tool} ${t.tool_use_id}] ${JSON.stringify(t.input)}`),
        ...(m.toolResults ?? []).map((r) => `[tool_result ${r.tool_use_id}${r.isError ? ' error' : ''}] ${r.text}`),
      ].join('\n'),
    )
    .join('\n\n');
}

/** The recorded B result for a case, or undefined when the file is absent or unreadable (the case is not covered). */
export function readB(dir: string, caseId: string): BResult | undefined {
  const file = join(dir, `${caseId}.json`);
  if (!existsSync(file)) return undefined;
  try {
    const b = JSON.parse(readFileSync(file, 'utf8')) as BResult;
    return Array.isArray(b.summary) ? b : undefined;
  } catch {
    return undefined;
  }
}

/** Builds every arm for one case from its messages. `bDir` is out/b. Never throws for a missing B. */
export async function buildArms(c: Case, messages: readonly Message[], deps: ArmDeps, bDir: string): Promise<Arms> {
  const text: Arms['text'] = { O: renderMessages(messages) };
  const t0 = await compact(messages, deps.asker, {});
  text.T0 = renderMessages(t0.messages);
  const options = { ...DEFAULT_OPTIONS, goal: goalFromMessages(messages) };
  const trimmed = await trimProse(t0.messages, callActions(messages, t0.decisions, options.preserveRecentMessages), deps.asker, options);
  text.A = renderMessages(trimmed.messages);
  if (c.builtinSummary !== undefined) text.BI = c.builtinSummary;
  const t0Ratio = reductionRatio(t0);
  // Today's hook: T0 at or above the gate, else the built-in summary; with none to use, it skips and the history stays as is.
  text.S = t0Ratio >= MIN_REDUCTION ? text.T0 : (text.BI ?? text.O);
  const b = readB(bDir, c.id);
  if (b) text.B = b.summary.join('\n');
  const charsBefore = t0.stats.charsBefore;
  const aRatio = charsBefore === 0 ? 0 : (charsBefore - trimmed.messages.reduce((n, m) => n + messageChars(m), 0)) / charsBefore;
  return { text, t0Ratio, aRatio };
}
