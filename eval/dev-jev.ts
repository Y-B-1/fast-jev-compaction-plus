// Dev-only live check (S4b): Jev on the first 5 dev cases. Not shipped in dist.
// Key from process.env.TYPESAFE_API_KEY only. Output holds counts, ids and scores, never transcript text.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jevAsker, type HookFetch } from '../hooks/fast-jev.js';
import { compact, DEFAULT_OPTIONS, messageChars, reductionRatio } from '../src/compact.js';
import { callActions, splitProse, trimProse, type ProseDecision } from '../src/prose.js';
import { DEFAULT_MODEL } from '../src/request.js';
import { goalFromMessages } from '../src/state.js';
import type { JevAsker, JevQuestions, Message } from '../src/types.js';
import { cases as loadCases, loadTranscript, split, DEFAULT_SEED, type Case, type Manifest } from './load.js';

const THRESHOLD = 0.15;
const MAX_CASES = 5;
const BINS: [string, number][] = [
  ['<0.05', 0.05],
  ['0.05-0.10', 0.1],
  ['0.10-0.15', 0.15],
  ['0.15-0.25', 0.25],
  ['0.25-0.35', 0.35],
  ['0.35-0.50', 0.5],
  ['0.50-0.75', 0.75],
  ['>=0.75', Infinity],
];

export interface CaseResult {
  id: string;
  estTokens: number;
  /** HTTP status code (0 for a network error) to request count, across T0 and both trim runs. */
  statuses: Record<string, number>;
  t0: { pct: number; charsBefore: number; charsAfter: number; calls: number; requests: number; failedRequests: number };
  trim: {
    scored: number;
    dropped: number;
    inputsElided: number;
    proseCharsSaved: number;
    inputCharsSaved: number;
    /** Requests of the first and the second trim run. */
    requests: [number, number];
    failedRequests: [number, number];
    failed?: string;
  };
  /** Reduction after T0 and the first trim run, in percent of the original chars. */
  combinedPct: number;
  noul: { bins: Record<string, number>; missing: number };
  flip: { compared: number; flips: number; rate: number };
  /** Set when a stage threw (every request of a stage failed); the numbers above are then zero. */
  error?: string;
}
export interface S4 {
  model: string;
  cap: number;
  seed: number;
  threshold: number;
  cases: CaseResult[];
  histogram: Record<string, number>;
  flip: { compared: number; flips: number; rate: number };
  allOk: boolean;
}

export interface RunOptions {
  /** Dev cases already selected, in order; at most 5 are run. */
  cases: Case[];
  manifest: Manifest;
  cap: number;
  outPath: string;
  apiKey?: string;
  fetch?: typeof fetch;
  model?: string;
  seed?: number;
}

const emptyBins = (): Record<string, number> => Object.fromEntries(BINS.map(([label]) => [label, 0]));
const binOf = (n: number): string => (BINS.find(([, upper]) => n < upper) as [string, number])[0];

/** The values under `c<n>` keys of a request state: the scored units Jev will see. */
function scoredTexts(node: unknown, out: string[] = []): string[] {
  if (node === null || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node)) {
    if (/^c\d+$/.test(key) && typeof value === 'string') out.push(value);
    else scoredTexts(value, out);
  }
  return out;
}

/** Acceptance 3, offline: a fake asker that keeps everything records each request; every scored unit must re-split as scored. */
async function assertNoProtected(messages: readonly Message[], id: string): Promise<void> {
  const states: unknown[] = [];
  const fake: JevAsker = {
    async ask(state, questions: JevQuestions) {
      states.push(state);
      return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, noul: 0.9 }])) };
    },
  };
  const t0 = await compact(messages, fake, {});
  const options = { ...DEFAULT_OPTIONS, goal: goalFromMessages(messages) };
  const actions = callActions(messages, t0.decisions, options.preserveRecentMessages);
  states.length = 0;
  await trimProse(t0.messages, actions, fake, options);
  for (const text of states.flatMap((s) => scoredTexts(s))) {
    if (!splitProse(text).every((u) => u.scored)) throw new Error(`Case ${id}: a Jev question holds a protected span`);
  }
}

function flipOf(a: ProseDecision[], b: ProseDecision[]): CaseResult['flip'] {
  const second = new Map(b.map((d) => [d.id, d]));
  let compared = 0;
  let flips = 0;
  for (const d of a) {
    const other = second.get(d.id);
    if (!other) continue;
    compared++;
    if (d.kept !== other.kept) flips++;
  }
  return { compared, flips, rate: compared === 0 ? 0 : flips / compared };
}

/** T0 (tool-only compact, no prose trim), then two trim runs over the same T0 output. `statuses` is filled by the caller's fetch. */
async function runCase(c: Case, messages: Message[], asker: JevAsker, statuses: Record<string, number>): Promise<CaseResult> {
  const t0 = await compact(messages, asker, {});
  const options = { ...DEFAULT_OPTIONS, goal: goalFromMessages(messages) };
  const actions = callActions(messages, t0.decisions, options.preserveRecentMessages);
  const first = await trimProse(t0.messages, actions, asker, options);
  const second = await trimProse(t0.messages, actions, asker, options);
  const bins = emptyBins();
  let missing = 0;
  for (const d of first.decisions) {
    if (d.noul === undefined) missing++;
    else bins[binOf(d.noul)]!++;
  }
  const charsBefore = t0.stats.charsBefore;
  const charsAfter = first.messages.reduce((sum, m) => sum + messageChars(m), 0);
  const s = first.stats;
  return {
    id: c.id,
    estTokens: c.estTokens,
    statuses,
    t0: {
      pct: reductionRatio(t0) * 100,
      charsBefore,
      charsAfter: t0.stats.charsAfter,
      calls: t0.stats.calls,
      requests: t0.stats.requests,
      failedRequests: t0.stats.failedRequests,
    },
    trim: {
      scored: s.scored,
      dropped: s.dropped,
      inputsElided: s.inputsElided,
      proseCharsSaved: s.proseCharsSaved,
      inputCharsSaved: s.inputCharsSaved,
      requests: [s.requests, second.stats.requests],
      failedRequests: [s.failedRequests, second.stats.failedRequests],
      ...(s.failed !== undefined ? { failed: s.failed } : {}),
    },
    combinedPct: charsBefore === 0 ? 0 : ((charsBefore - charsAfter) / charsBefore) * 100,
    noul: { bins, missing },
    flip: flipOf(first.decisions, second.decisions),
  };
}

export async function run(o: RunOptions): Promise<S4> {
  if (!o.apiKey) throw new Error('TYPESAFE_API_KEY is not set');
  const apiKey = o.apiKey;
  const model = o.model ?? DEFAULT_MODEL;
  const realFetch = o.fetch ?? globalThis.fetch;
  const files = new Map(o.manifest.files.map((f) => [f.path, f]));
  const selected = o.cases.slice(0, MAX_CASES);
  const loaded = selected.map((c) => {
    const file = files.get(c.transcript);
    if (!file) throw new Error(`Case ${c.id}: transcript not in the manifest`);
    return loadTranscript(file).messages.slice(c.start, c.end);
  });
  for (const [i, c] of selected.entries()) await assertNoProtected(loaded[i] as Message[], c.id);

  let statuses: Record<string, number> = {};
  const recordingFetch: HookFetch = async (url, init) => {
    try {
      const r = await realFetch(url, init as RequestInit);
      const text = await r.text();
      statuses[String(r.status)] = (statuses[String(r.status)] ?? 0) + 1;
      return { status: r.status, ok: r.ok, text, headers: Object.fromEntries(r.headers.entries()) };
    } catch (error) {
      statuses['0'] = (statuses['0'] ?? 0) + 1;
      throw error;
    }
  };
  const asker = jevAsker(recordingFetch, apiKey, model);

  const results: CaseResult[] = [];
  for (const [i, c] of selected.entries()) {
    statuses = {};
    try {
      results.push(await runCase(c, loaded[i] as Message[], asker, statuses));
    } catch (error) {
      results.push({
        id: c.id,
        estTokens: c.estTokens,
        statuses,
        t0: { pct: 0, charsBefore: 0, charsAfter: 0, calls: 0, requests: 0, failedRequests: 0 },
        trim: { scored: 0, dropped: 0, inputsElided: 0, proseCharsSaved: 0, inputCharsSaved: 0, requests: [0, 0], failedRequests: [0, 0] },
        combinedPct: 0,
        noul: { bins: emptyBins(), missing: 0 },
        flip: { compared: 0, flips: 0, rate: 0 },
        error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      });
    }
    if (Object.keys(statuses).some((code) => code !== '200')) break;
  }

  const histogram = emptyBins();
  for (const r of results) for (const [label, n] of Object.entries(r.noul.bins)) histogram[label]! += n;
  const compared = results.reduce((a, r) => a + r.flip.compared, 0);
  const flips = results.reduce((a, r) => a + r.flip.flips, 0);
  const s4: S4 = {
    model,
    cap: o.cap,
    seed: o.seed ?? DEFAULT_SEED,
    threshold: THRESHOLD,
    cases: results,
    histogram,
    flip: { compared, flips, rate: compared === 0 ? 0 : flips / compared },
    allOk: results.length > 0 && results.every((r) => Object.keys(r.statuses).every((code) => code === '200')),
  };
  mkdirSync(dirname(o.outPath), { recursive: true });
  writeFileSync(o.outPath, JSON.stringify(s4, null, 2) + '\n');
  return s4;
}

// CLI: `npx tsx eval/dev-jev.ts` runs live. Needs TYPESAFE_API_KEY in the environment.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = join(homedir(), '.claude', 'fast-jev-eval');
  const manifest: Manifest = JSON.parse(readFileSync(join(dir, 'out', 'manifest.json'), 'utf8'));
  const cap: number = JSON.parse(readFileSync(join(dir, 'spikes', 'cp', 'overhead.json'), 'utf8')).cap;
  const dev = split(loadCases(manifest), cap).dev.filter((c) => c.estTokens < cap);
  const s4 = await run({ cases: dev, manifest, cap, outPath: join(dir, 'out', 's4.json'), apiKey: process.env.TYPESAFE_API_KEY });
  for (const c of s4.cases) {
    console.log(`${c.id} t0 ${c.t0.pct.toFixed(1)}% scored ${c.trim.scored} flip ${c.flip.flips}/${c.flip.compared} requests ${c.t0.requests}+${c.trim.requests[0]}+${c.trim.requests[1]} statuses ${JSON.stringify(c.statuses)}`);
  }
  console.log(`allOk ${s4.allOk}`);
  if (!s4.allOk) process.exit(1);
}
