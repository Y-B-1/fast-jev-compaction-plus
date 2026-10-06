// Dev-only, offline: design acceptance criterion 2 over every frozen-manifest case under the cap. Runs trimProse with an asker that
// drops every scored unit and with every call eligible (so every code body is elided), then checks nothing protected changed:
// user-role text, pinned messages, tool results, protected spans, tool names and ids, input keys and non-body input fields.
// No API call, no key read; prints counts only.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DEFAULT_OPTIONS } from '../src/compact.js';
import { heredocBodies, splitProse, trimProse } from '../src/prose.js';
import { goalFromMessages, isPinned } from '../src/state.js';
import type { CallDecision, JevAsker, JevQuestions, Message, ToolUse } from '../src/types.js';
import { EVAL_CAP } from './claude.js';
import { cases, loadTranscript, type Manifest } from './load.js';

export type Trim = typeof trimProse;

/** Fields trimProse may rewrite: code bodies (cut by rule) and prose inputs (clauses dropped). Everything else is protected. */
const BODY_FIELDS: Record<string, string[]> = { Write: ['content'], Edit: ['old_string', 'new_string'], NotebookEdit: ['new_source'], Workflow: ['script'] };
const PROSE_FIELDS: Record<string, string> = { Agent: 'prompt', Task: 'prompt', SendMessage: 'message' };

const dropAll: JevAsker = {
  async ask(_state, questions: JevQuestions) {
    return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, noul: 0 }])) };
  },
};

const DANGLING_END = /(?:[,;]|\s(?:—|–|--?))$/;

/** `out` is `src` with whole stretches deleted. */
function isSubsequence(out: string, src: string): boolean {
  let at = 0;
  for (const ch of out) {
    at = src.indexOf(ch, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

/** Every protected unit of `src` appears byte for byte in `out`, in order. Counts the units it looked at. */
function protectedHolds(src: string, out: string, count: { units: number }): boolean {
  let cursor = 0;
  let ok = true;
  for (const u of splitProse(src)) {
    count.units++;
    if (u.scored) continue;
    // Ruling 9: a unit left dangling by a dropped next clause takes the sentence's end mark in place of its trailing `,` `;` or dash.
    const content = src.slice(u.start, u.end).trim().replace(DANGLING_END, '');
    if (content === '') continue;
    const at = out.indexOf(content, cursor);
    if (at < 0) ok = false;
    else cursor = at + content.length;
  }
  return ok;
}

/** The text outside the heredoc bodies of `before` survives in `after`, in order, with the first piece leading and the last trailing. */
function commandLineHolds(before: string, after: string): boolean {
  const pieces: string[] = [];
  let at = 0;
  for (const s of heredocBodies(before)) {
    pieces.push(before.slice(at, s.start));
    at = s.end;
  }
  pieces.push(before.slice(at));
  if (pieces.length === 1) return before === after;
  let pos = 0;
  for (const [k, piece] of pieces.entries()) {
    if (k === 0) {
      if (!after.startsWith(piece)) return false;
      pos = piece.length;
    } else if (k === pieces.length - 1) {
      if (!after.endsWith(piece) || after.length - piece.length < pos) return false;
    } else {
      const i = after.indexOf(piece, pos);
      if (i < 0) return false;
      pos = i + piece.length;
    }
  }
  return true;
}

function toolViolations(i: number, b: ToolUse, a: ToolUse, count: { units: number }, out: string[]): void {
  if (a.tool_use_id !== b.tool_use_id || a.tool !== b.tool) return void out.push(`message ${i}: tool name or id changed (${b.tool})`);
  const bk = Object.keys(b.input).sort();
  const ak = Object.keys(a.input).sort();
  if (!isDeepStrictEqual(bk, ak)) return void out.push(`message ${i}: input key set of ${b.tool} changed`);
  const bodies = new Set(BODY_FIELDS[b.tool] ?? []);
  for (const key of bk) {
    const bv = b.input[key];
    const av = a.input[key];
    if (bodies.has(key)) {
      if (typeof bv === 'string' && typeof av !== 'string') out.push(`message ${i}: ${b.tool}.${key} is no longer a string`);
    } else if (PROSE_FIELDS[b.tool] === key && typeof bv === 'string' && typeof av === 'string') {
      if (!protectedHolds(bv, av, count)) out.push(`message ${i}: protected span of ${b.tool}.${key} changed`);
    } else if (b.tool === 'Bash' && key === 'command' && typeof bv === 'string' && typeof av === 'string') {
      if (!commandLineHolds(bv, av)) out.push(`message ${i}: Bash command line changed`);
    } else if (b.tool === 'MultiEdit' && key === 'edits' && Array.isArray(bv) && Array.isArray(av)) {
      const same =
        bv.length === av.length &&
        bv.every((e, n) => {
          const { old_string: _o, new_string: _n, ...rest } = (e ?? {}) as Record<string, unknown>;
          const { old_string: _o2, new_string: _n2, ...rest2 } = (av[n] ?? {}) as Record<string, unknown>;
          return isDeepStrictEqual(rest, rest2);
        });
      if (!same) out.push(`message ${i}: MultiEdit non-body field changed`);
    } else if (!isDeepStrictEqual(bv, av)) {
      out.push(`message ${i}: input field ${key} of ${b.tool} changed`);
    }
  }
}

/** Violations of criterion 2 between a history and its trimmed version. `count.units` gets the units examined. */
export function violations(before: readonly Message[], after: readonly Message[], preserve: number, count = { units: 0 }): string[] {
  const out: string[] = [];
  const total = before.length;
  let j = 0;
  before.forEach((b, i) => {
    const a = after[j];
    const pinned = isPinned(i, total, preserve);
    const removable = b.role === 'assistant' && b.toolUses.length === 0 && (b.toolResults?.length ?? 0) === 0;
    // A rebuilt assistant message is the counterpart of `b` by role and call count; a removable one must also still hold some of its text.
    const counterpart =
      a !== undefined &&
      (a === b ||
        (a.role === b.role &&
          a.toolUses.length === b.toolUses.length &&
          (a.toolResults?.length ?? 0) === (b.toolResults?.length ?? 0) &&
          (!removable || (pinned ? isDeepStrictEqual(a, b) : a.text.trim() !== '' && isSubsequence(a.text, b.text)))));
    if (!counterpart) {
      if (!removable) out.push(`message ${i}: ${b.role} message missing or unrecognisable`);
      else if (pinned) out.push(`message ${i}: pinned message removed`);
      else if (splitProse(b.text).some((u) => !u.scored && b.text.slice(u.start, u.end).trim() !== '')) out.push(`message ${i}: assistant message with protected text removed`);
      return;
    }
    j++;
    if (a === b) return;
    if (pinned && !isDeepStrictEqual(a, b)) out.push(`message ${i}: pinned message changed`);
    if (b.role === 'user' && !isDeepStrictEqual(a, b)) out.push(`message ${i}: user message changed`);
    if (!isDeepStrictEqual(a.toolResults ?? [], b.toolResults ?? [])) out.push(`message ${i}: tool result changed`);
    if (b.role !== 'assistant' || pinned) return;
    if (!protectedHolds(b.text, a.text, count)) out.push(`message ${i}: protected span of assistant text changed`);
    b.toolUses.forEach((t, k) => toolViolations(i, t, a.toolUses[k] as ToolUse, count, out));
  });
  if (j < after.length) out.push(`${after.length - j} extra message(s) after the trim`);
  return out;
}

/** trimProse over `messages` with every call eligible and every scored unit dropped, then `violations`. */
export async function checkMessages(
  messages: readonly Message[],
  trim: Trim = trimProse,
): Promise<{ violations: string[]; units: number; changed: boolean }> {
  const actions = new Map<string, CallDecision>();
  for (const m of messages) {
    for (const t of m.toolUses) {
      actions.set(t.tool_use_id, { id: t.tool_use_id, tool: t.tool, action: 'keep', reason: 'kept', keepCall: 1, keepResult: 1 });
    }
  }
  const options = { ...DEFAULT_OPTIONS, goal: goalFromMessages(messages) };
  const trimmed = await trim(messages, actions, dropAll, options);
  const count = { units: 0 };
  const found = violations(messages, trimmed.messages, options.preserveRecentMessages, count);
  return { violations: found, units: count.units, changed: trimmed.messages.some((m, i) => m !== messages[i]) || trimmed.messages.length !== messages.length };
}

// CLI: `npx tsx eval/invariants.ts` over the frozen manifest, read-only. Prints counts; exits 0 iff there are no violations.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest: Manifest = JSON.parse(readFileSync(join(homedir(), '.claude', 'fast-jev-eval', 'out', 'manifest.json'), 'utf8'));
  const files = new Map(manifest.files.map((f) => [f.path, f]));
  let nCases = 0;
  let units = 0;
  let bad = 0;
  const loaded = new Map<string, Message[]>();
  for (const c of cases(manifest).filter((x) => x.estTokens < EVAL_CAP)) {
    const file = files.get(c.transcript);
    if (!file) throw new Error(`Case ${c.id}: transcript not in the manifest`);
    if (!loaded.has(c.transcript)) {
      loaded.clear();
      loaded.set(c.transcript, loadTranscript(file).messages);
    }
    const r = await checkMessages((loaded.get(c.transcript) as Message[]).slice(c.start, c.end));
    nCases++;
    units += r.units;
    bad += r.violations.length;
    for (const v of r.violations.slice(0, 5)) console.error(`${c.id}: ${v}`);
  }
  console.log(`cases ${nCases} units ${units} violations ${bad}`);
  if (bad > 0) process.exit(1);
}
