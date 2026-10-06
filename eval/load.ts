// Dev-only eval loader for the prose-trim fact-recall eval. Not shipped in dist.
// Output goes to ~/.claude/fast-jev-eval/out/, never into the repo.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens } from '../src/state.js';
import type { Message, ToolResult, ToolUse } from '../src/types.js';

/** Transcripts modified after this are live sessions and are excluded (882efd6). */
export const CUTOFF_MS = Date.parse('2026-10-06T16:55:00+04:00');
export const DEFAULT_SEED = 20261006;
const WHOLE_TRANSCRIPT_MIN_TOKENS = 50_000;
const MIN_TEST_CASES = 24;
const MIN_DEV_CASES = 5;

export interface ManifestFile {
  path: string;
  mtimeMs: number;
  sha256: string;
}
export interface Manifest {
  cutoffMs: number;
  files: ManifestFile[];
}
export interface Case {
  id: string;
  transcript: string;
  /** Message range [start, end) in loadTranscript(...).messages. */
  start: number;
  end: number;
  chars: number;
  estTokens: number;
  builtinSummary?: string;
  /** Main-thread record uuids of the whole transcript; split() groups transcripts that share any. */
  uuids?: string[];
}
export interface LoadedTranscript {
  messages: Message[];
  /** `at` is the messages index where the boundary fell; `summary` is the built-in summary after it. */
  boundaries: { at: number; summary?: string }[];
  /** Unparseable lines (a cut-off last line). */
  skipped: number;
  /** uuid of every main-thread (non-sidechain) record, in file order. Kept out of Message. */
  uuids: string[];
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Every jsonl one folder below projectsDir, modified before the cutoff, with mtime and sha256. */
export function freeze(projectsDir: string, cutoffMs = CUTOFF_MS): Manifest {
  const files: ManifestFile[] = [];
  for (const folder of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue;
    const dir = join(projectsDir, folder.name);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      const st = statSync(path);
      if (!st.isFile() || st.mtimeMs >= cutoffMs) continue;
      files.push({ path, mtimeMs: st.mtimeMs, sha256: sha256(path) });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { cutoffMs, files };
}

type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };

const blockText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((b: Block) => b?.type === 'text').map((b: Block) => b.text ?? '').join('\n')
      : '';

/** Main thread only, thinking excluded, tool_use paired by id with tool_result. Refuses a changed file. */
export function loadTranscript(file: ManifestFile): LoadedTranscript {
  if (sha256(file.path) !== file.sha256) throw new Error(`Transcript hash mismatch: ${file.path}`);
  const messages: Message[] = [];
  const boundaries: LoadedTranscript['boundaries'] = [];
  const uuids: string[] = [];
  let skipped = 0;
  let lastAssistantId: string | undefined;
  let awaitingSummary = false;
  for (const raw of readFileSync(file.path, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(raw);
    } catch {
      skipped++;
      continue;
    }
    if (o.isSidechain) continue;
    if (typeof o.uuid === 'string') uuids.push(o.uuid);
    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      boundaries.push({ at: messages.length });
      awaitingSummary = true;
      lastAssistantId = undefined;
      continue;
    }
    if (o.type === 'user' && o.isCompactSummary) {
      if (awaitingSummary) boundaries[boundaries.length - 1].summary = blockText(o.message?.content);
      awaitingSummary = false;
      continue;
    }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const content = o.message?.content;
    if (o.type === 'user') {
      lastAssistantId = undefined;
      const blocks: Block[] = Array.isArray(content) ? content : [];
      const toolResults: ToolResult[] = blocks
        .filter((b) => b.type === 'tool_result')
        .map((b) => ({ tool_use_id: String(b.tool_use_id), text: blockText(b.content), isError: b.is_error === true }));
      const message: Message = { role: 'user', text: blockText(content), toolUses: [] };
      if (toolResults.length) message.toolResults = toolResults;
      messages.push(message);
      continue;
    }
    const blocks: Block[] = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }];
    const toolUses: ToolUse[] = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ tool_use_id: String(b.id), tool: String(b.name), input: (b.input ?? {}) as Record<string, unknown> }));
    const text = blockText(blocks);
    const id: string | undefined = o.message?.id;
    const prev = messages[messages.length - 1];
    if (id && id === lastAssistantId && prev?.role === 'assistant') {
      prev.text = [prev.text, text].filter(Boolean).join('\n');
      prev.toolUses.push(...toolUses);
    } else {
      messages.push({ role: 'assistant', text, toolUses });
    }
    lastAssistantId = id;
  }
  return { messages, boundaries, skipped, uuids };
}

function makeCase(file: ManifestFile, t: LoadedTranscript, start: number, end: number, summary?: string): Case {
  const slice = t.messages.slice(start, end);
  const chars = slice.reduce(
    (s, m) =>
      s + m.text.length + m.toolUses.reduce((n, u) => n + JSON.stringify(u.input).length, 0) +
      (m.toolResults ?? []).reduce((n, r) => n + r.text.length, 0),
    0,
  );
  const estTokens = slice.reduce((s, m) => s + estimateTokens(JSON.stringify(m)), 0);
  const c: Case = { id: `${basename(file.path, '.jsonl')}#${start}-${end}`, transcript: file.path, start, end, chars, estTokens, uuids: t.uuids };
  if (summary !== undefined) c.builtinSummary = summary;
  return c;
}

/**
 * One case per window ending at a compaction boundary, or the whole transcript when it has none and is over 50k tokens.
 * Resumed or forked transcripts copy history: a case whose messages equal an earlier emitted case is dropped (files in manifest order).
 */
export function cases(manifest: Manifest): Case[] {
  const out: Case[] = [];
  const seen = new Set<string>();
  for (const file of manifest.files) {
    const t = loadTranscript(file);
    const add = (c: Case) => {
      const key = createHash('sha256').update(JSON.stringify(t.messages.slice(c.start, c.end))).digest('hex');
      if (seen.has(key)) return;
      seen.add(key);
      out.push(c);
    };
    if (t.boundaries.length === 0) {
      const whole = makeCase(file, t, 0, t.messages.length);
      if (whole.estTokens > WHOLE_TRANSCRIPT_MIN_TOKENS) add(whole);
      continue;
    }
    let start = 0;
    for (const b of t.boundaries) {
      if (b.at > start) add(makeCase(file, t, start, b.at, b.summary));
      start = b.at;
    }
  }
  return out;
}

export interface Split {
  dev: Case[];
  test: Case[];
  devUnderCap: number;
  testUnderCap: number;
  /** test / dev, counting only cases under the cap. */
  ratio: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Transcripts that share any main-thread uuid form one unit (union-find); units sorted by smallest path. */
function units(all: Case[]): string[][] {
  const uuidsOf = new Map<string, Set<string>>();
  for (const c of all) {
    const set = uuidsOf.get(c.transcript) ?? new Set<string>();
    for (const u of c.uuids ?? []) set.add(u);
    uuidsOf.set(c.transcript, set);
  }
  const transcripts = [...uuidsOf.keys()].sort();
  const parent = new Map(transcripts.map((t) => [t, t]));
  const find = (t: string): string => {
    while (parent.get(t) !== t) {
      parent.set(t, parent.get(parent.get(t)!)!);
      t = parent.get(t)!;
    }
    return t;
  };
  const owner = new Map<string, string>();
  for (const t of transcripts) {
    for (const u of uuidsOf.get(t)!) {
      const o = owner.get(u);
      if (o === undefined) owner.set(u, t);
      else parent.set(find(t), find(o));
    }
  }
  const groups = new Map<string, string[]>();
  for (const t of transcripts) groups.set(find(t), [...(groups.get(find(t)) ?? []), t]);
  return [...groups.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** Splits by shared-history unit (one third dev, two thirds test, by unit count); only cases under `cap` tokens count toward the minimums. */
export function split(all: Case[], cap: number, seed = DEFAULT_SEED): Split {
  const groups = units(all);
  const rand = mulberry32(seed);
  for (let i = groups.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [groups[i], groups[j]] = [groups[j], groups[i]];
  }
  const dev = new Set(groups.slice(0, Math.round(groups.length / 3)).flat());
  const devCases = all.filter((c) => dev.has(c.transcript));
  const testCases = all.filter((c) => !dev.has(c.transcript));
  const under = (cs: Case[]) => cs.filter((c) => c.estTokens < cap).length;
  const devUnderCap = under(devCases);
  const testUnderCap = under(testCases);
  const ratio = devUnderCap ? testUnderCap / devUnderCap : Infinity;
  if (testUnderCap < MIN_TEST_CASES) throw new Error(`Too few test cases under the cap: ${testUnderCap} < ${MIN_TEST_CASES} (dev ${devUnderCap})`);
  if (devUnderCap < MIN_DEV_CASES) throw new Error(`Too few dev cases under the cap: ${devUnderCap} < ${MIN_DEV_CASES} (test ${testUnderCap})`);
  return { dev: devCases, test: testCases, devUnderCap, testUnderCap, ratio };
}

const EVAL_DIR = join(homedir(), '.claude', 'fast-jev-eval');
const MANIFEST = join(EVAL_DIR, 'out', 'manifest.json');

// CLI: `npx tsx eval/load.ts freeze` writes the manifest once; `report [cap]` prints counts only.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === 'freeze') {
    if (existsSync(MANIFEST)) throw new Error(`Already frozen: ${MANIFEST}`);
    const manifest = freeze(join(homedir(), '.claude', 'projects'));
    mkdirSync(dirname(MANIFEST), { recursive: true });
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`files ${manifest.files.length}`);
  } else if (cmd === 'report') {
    const manifest: Manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const cap = Number(process.argv[3] ?? JSON.parse(readFileSync(join(EVAL_DIR, 'spikes', 'cp', 'overhead.json'), 'utf8')).cap);
    const all = cases(manifest);
    console.log(`files ${manifest.files.length} cases ${all.length} underCap ${all.filter((c) => c.estTokens < cap).length} cap ${cap}`);
    try {
      const s = split(all, cap);
      console.log(`split dev ${s.devUnderCap} test ${s.testUnderCap} ratio ${s.ratio.toFixed(3)}`);
    } catch (e) {
      console.log(`split threw: ${(e as Error).message}`);
    }
  } else throw new Error('usage: load.ts freeze | report [cap]');
}
