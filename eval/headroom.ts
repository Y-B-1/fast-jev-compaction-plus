// Dev-only headroom table (S2b): upper bound of what prose trim and code-body elision could remove per case.
// Reads the frozen manifest, writes ~/.claude/fast-jev-eval/out/headroom.json (ids, counts, percentages; no text).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { elideBody, heredocBodies } from '../src/prose.js';
import { isPinned } from '../src/state.js';
import type { Message } from '../src/types.js';
import { cases, loadTranscript, type Manifest } from './load.js';

const HEAD = 300;
const SALVAGE = 300;
const GATE = 25;
const MIN_CHARS = 100_000;
/** The folder the design's reference numbers came from (user ruling). */
const DESIGN_FOLDER = '/-Users-yusri-Documents-Claude/';
const CODE_FIELDS: Record<string, string[]> = {
  Write: ['content'],
  Edit: ['old_string', 'new_string'],
  MultiEdit: ['old_string', 'new_string'],
  NotebookEdit: ['new_source'],
  Workflow: ['script'],
};

export interface Shares {
  chars: number;
  prose: number;
  code: number;
  heredoc: number;
  total: number;
  over25: boolean;
}

/** Assistant text outside fenced code (``` or ~~~; an unclosed fence runs to the end). */
function proseChars(text: string): number {
  let fenced = false;
  let n = 0;
  for (const line of text.split('\n')) {
    if (/^[ \t]*(?:```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) n += line.length + 1;
  }
  return Math.min(n, text.length);
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
      for (const field of CODE_FIELDS[u.tool] ?? []) {
        const v = u.input[field];
        if (typeof v === 'string') code += v.length - elideBody(v, `${u.tool}.${field} for ${path}`, HEAD, SALVAGE).length;
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
  return { chars, prose: pct(prose), code: pct(code), heredoc: pct(heredoc), total, over25: total >= GATE };
}

export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length === 0 ? NaN : s.length % 2 ? (s[h] as number) : ((s[h - 1] as number) + (s[h] as number)) / 2;
};

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
    over25: rs.filter((r) => r.over25).length,
  });
  const summary = { designFolder: summarize(rows.filter((r) => r.designFolder)), fullCorpus: summarize(rows), gate: GATE, minChars: MIN_CHARS };
  mkdirSync(dirname(join(OUT, 'headroom.json')), { recursive: true });
  writeFileSync(join(OUT, 'headroom.json'), JSON.stringify({ summary, cases: rows }, null, 2) + '\n');
  console.log(JSON.stringify(summary));
}
