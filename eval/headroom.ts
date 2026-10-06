// Dev-only headroom table (S2b): upper bound of what prose trim and code-body elision could remove per case.
// Reads the frozen manifest, writes ~/.claude/fast-jev-eval/out/headroom.json (ids, counts, percentages; no text).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { elideBody, heredocBodies, splitProse } from '../src/prose.js';
import { isPinned } from '../src/state.js';
import type { Message } from '../src/types.js';
import { cases, loadTranscript, type Manifest } from './load.js';

const HEAD = 300;
const SALVAGE = 300;
/** Upper-bound threshold (pct). Reported per case as upperBoundOver25; it is not the design's gate count. */
const GATE = 25;
const REFERENCE = { prose: 2.6, code: 7.1, heredoc: 2.0 };
const TOLERANCE = 0.5;
const MIN_CHARS = 100_000;
/** The folder the design's reference numbers came from (user ruling). */
const DESIGN_FOLDER = '/-Users-yusri-Documents-Claude/';
const CODE_FIELDS: Record<string, string[]> = {
  Write: ['content'],
  Edit: ['old_string', 'new_string'],
  NotebookEdit: ['new_source'],
  Workflow: ['script'],
};

export interface Shares {
  chars: number;
  prose: number;
  code: number;
  heredoc: number;
  total: number;
  /** Upper bound alone (prose + code + heredoc >= 25 pct); excludes the T0 term of the design's gate. */
  upperBoundOver25: boolean;
}

/** Chars of scored prose units; protected spans, inline code and fenced code are unscored. */
function proseChars(text: string): number {
  return splitProse(text).reduce((n, u) => (u.scored ? n + u.end - u.start : n), 0);
}

/** Per-case upper bound as percent of all chars. Pinned = message 0 and the last `preserve` messages. */
export function shares(messages: readonly Message[], preserve: number): Shares {
  let chars = 0;
  let prose = 0;
  let code = 0;
  let heredoc = 0;
  messages.forEach((m, i) => {
    chars += m.text.length + (m.toolResults ?? []).reduce((n, r) => n + r.text.length, 0);
    const eligible = !isPinned(i, messages.length, preserve);
    if (eligible && m.role === 'assistant') prose += proseChars(m.text);
    for (const u of m.toolUses) {
      chars += JSON.stringify(u.input).length;
      if (!eligible) continue;
      const path = String(u.input.file_path ?? u.input.path ?? u.input.notebook_path ?? '');
      const targets: [string, Record<string, unknown>, string[]][] = [];
      if (u.tool === 'MultiEdit' && Array.isArray(u.input.edits)) {
        for (const e of u.input.edits) if (e && typeof e === 'object') targets.push([u.tool, e as Record<string, unknown>, ['old_string', 'new_string']]);
      } else targets.push([u.tool, u.input, CODE_FIELDS[u.tool] ?? []]);
      for (const [tool, obj, fields] of targets) {
        for (const field of fields) {
          const v = obj[field];
          if (typeof v === 'string') code += v.length - elideBody(v, `${tool}.${field} for ${path}`, HEAD, SALVAGE).length;
        }
      }
      const cmd = u.tool === 'Bash' ? u.input.command : undefined;
      if (typeof cmd === 'string') {
        for (const b of heredocBodies(cmd)) {
          const body = cmd.slice(b.start, b.end);
          heredoc += body.length - elideBody(body, 'Bash.command heredoc', HEAD, SALVAGE).length;
        }
      }
    }
  });
  const pct = (n: number) => (chars ? (n / chars) * 100 : 0);
  const total = pct(prose + code + heredoc);
  return { chars, prose: pct(prose), code: pct(code), heredoc: pct(heredoc), total, upperBoundOver25: total >= GATE };
}

export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length === 0 ? NaN : s.length % 2 ? (s[h] as number) : ((s[h - 1] as number) + (s[h] as number)) / 2;
};

type Metrics = { prose: number; code: number; heredoc: number };

/** Report-only comparison to the design's reference medians; never a pass/fail gate. */
export function tolerance(m: Metrics) {
  const keys = ['prose', 'code', 'heredoc'] as const;
  const delta = {} as Metrics;
  const withinTolerance = {} as Record<keyof Metrics, boolean>;
  for (const k of keys) {
    delta[k] = m[k] - REFERENCE[k];
    withinTolerance[k] = Math.abs(delta[k]) <= TOLERANCE;
  }
  return { reference: { ...REFERENCE }, delta, withinTolerance };
}

const OUT = join(homedir(), '.claude', 'fast-jev-eval', 'out');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest: Manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));
  const preserve = 6;
  const loaded = new Map<string, ReturnType<typeof loadTranscript>>();
  const files = new Map(manifest.files.map((f) => [f.path, f]));
  const rows = cases(manifest)
    .map((c) => {
      let t = loaded.get(c.transcript);
      if (!t) {
        loaded.clear();
        t = loadTranscript(files.get(c.transcript)!);
        loaded.set(c.transcript, t);
      }
      return { id: c.id, designFolder: c.transcript.includes(DESIGN_FOLDER), ...shares(t.messages.slice(c.start, c.end), preserve) };
    })
    .filter((r) => r.chars >= MIN_CHARS);
  const summarize = (rs: typeof rows) => ({
    cases: rs.length,
    median: { prose: median(rs.map((r) => r.prose)), code: median(rs.map((r) => r.code)), heredoc: median(rs.map((r) => r.heredoc)), total: median(rs.map((r) => r.total)) },
    upperBoundOver25: rs.filter((r) => r.upperBoundOver25).length,
  });
  const design = summarize(rows.filter((r) => r.designFolder));
  const summary = {
    designFolder: { ...design, ...tolerance(design.median) },
    fullCorpus: summarize(rows),
    caseCounts: { designFolder: design.cases, fullCorpus: rows.length },
    upperBoundThreshold: GATE,
    minChars: MIN_CHARS,
  };
  mkdirSync(dirname(join(OUT, 'headroom.json')), { recursive: true });
  writeFileSync(join(OUT, 'headroom.json'), JSON.stringify({ summary, cases: rows }, null, 2) + '\n');
  console.log(JSON.stringify(summary));
}
