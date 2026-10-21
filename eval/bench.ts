// Dev-only benchmark (never merged): on the cases where tool compaction (T0) falls short of 0.25, does the notification
// ladder (arm N: T0, then notification trim composed with prose trim as the hook does, built-in summary as fallback) reach
// 0.25 and keep at least as many facts as the built-in summary? Arm L (prose trim only) is reported for comparison.
// `npx tsx eval/bench.ts [--cases N=8] [--concurrency K=4] [--per-transcript K=5] [--arms BI,N] [--dry-run] [--t0-dir DIR]`. Keys come from process.env.TYPESAFE_API_KEY only and are never
// printed. Output files hold ids, numbers and model ids, never transcript, question or answer text.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { archiveWriter, jevAsker, type HookFetch } from '../hooks/fast-jev.js';
import { compact, DEFAULT_OPTIONS, reductionRatio, resolveOptions } from '../src/compact.js';
import { applyNotifications, type NotificationScores, type Rung } from '../src/notifications.js';
import { callActions, ladderRescue, scoreProse } from '../src/prose.js';
import { DEFAULT_MODEL } from '../src/request.js';
import { trimRescue, type TrimRescue } from '../src/trim.js';
import type { CompactResult, JevAsker, JevQuestions, Message } from '../src/types.js';
import { ask, EVAL_CAP, makeStats, type SpawnFn } from './claude.js';
import { cases as loadCases, intact, loadTranscript, type Case, type Manifest } from './load.js';
import { dropFailed, loadQuestions, parseQuestions, questionPrompt, saveQuestions, tokenKind, type Question } from './questions.js';
import { answerPrompt, scoreAnswerAsync } from './score.js';

/** The hook's `minReductionRatio` default. */
export const MIN_REDUCTION = 0.25;
const DEFAULT_CASES = 8;
const DEFAULT_CONCURRENCY = 4;
/** Cases run K at a time; each may have this many claude -p calls in flight, so K x 4 is the process limit. */
const CALLS_PER_CASE = 4;
const PINNED_TAIL = DEFAULT_OPTIONS.preserveRecentMessages;
const DEFAULT_PER_TRANSCRIPT = 5;
const ARMS = ['O', 'BI', 'L', 'N'] as const;
type Arm = (typeof ARMS)[number];
/** The arms run when `--arms` is absent. O and L are opt-in: O was already applied when the questions were filtered. */
const DEFAULT_ARMS: readonly Arm[] = ['BI', 'N'];

/** `--arms` value to the arms to run, BI and N always included, in ARMS order; undefined for an unknown arm. */
export function parseArms(v: string | undefined): Arm[] | undefined {
  const asked = v === undefined ? [] : v.split(',').map((a) => a.trim());
  if (asked.some((a) => !(ARMS as readonly string[]).includes(a))) return undefined;
  return ARMS.filter((a) => (DEFAULT_ARMS as readonly string[]).includes(a) || asked.includes(a));
}

export interface Deps {
  outDir: string;
  /** The question cache (saveQuestions / loadQuestions). */
  cacheDir: string;
  /** Manifest cases with a built-in summary and under the cap, and the count of changed transcripts left out. */
  cases(): { cases: Case[]; skipped: number };
  messages(c: Case): Message[];
  spawn?: SpawnFn;
  makeAsker(): JevAsker;
  /** Jev's saved T0 answers for a case (the `t0-*.json` files), for `--dry-run`; undefined when none were saved. */
  savedT0?(c: Case): SavedT0 | undefined;
  confirm(question: string): Promise<boolean>;
  print(message: string): void;
}

export interface SavedT0 {
  decisions: { id: string; keepCall: number; keepResult: number }[];
}

// ---- Small helpers ----

/** y or yes (any case) is true; anything else, or a closed stream, is false. */
export function confirmFromStream(question: string, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<boolean> {
  const rl = createInterface({ input, output });
  return new Promise((done) => {
    rl.once('close', () => done(false));
    rl.question(`${question} [y/N] `, (a) => {
      done(/^y(es)?$/i.test(a.trim()));
      rl.close();
    });
  });
}

/** At most `n` tasks run at once; the rest wait their turn. */
export const limiter = (n: number) => {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    while (active >= n) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
};
export type Gate = ReturnType<typeof limiter>;

/** Maps with up to `k` in flight; results keep the input order. */
export const mapLimit = async <T, R>(items: T[], k: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(k, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
};

const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 100);

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

// ---- Case selection ----

/** Transcripts the run is built on, in turn order, then the spare that only fills what they cannot (id prefixes). */
export const PREFERRED_TRANSCRIPTS: readonly string[] = ['551e8c37', '80c24e5f', '0602b6ea'];
export const SPARE_TRANSCRIPTS: readonly string[] = ['6d4b468e'];
const MIN_TRANSCRIPTS = 3;

/** The transcript a case belongs to: its id up to the `#`. */
export const transcriptOf = (c: Pick<Case, 'id'>): string => c.id.split('#')[0]!;
const shortId = (t: string): string => t.slice(0, 8);

/** Cases with cached questions first, then the rest; each group keeps its order. */
export function orderCandidates<T>(cands: readonly T[], isCached: (c: T) => boolean): T[] {
  return [...cands.filter(isCached), ...cands.filter((c) => !isCached(c))];
}

/** Takes one item from each list in turn until all are empty. */
const roundRobin = <T>(lists: T[][]): T[] => {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]!);
  return out;
};

/**
 * The order in which cases are tried. When any preferred transcript has cases, the preferred transcripts take turns, then
 * the spare ones, then the rest; inside a transcript cached-first. With none of them present it is plain cached-first.
 */
export function orderForSelection<T>(
  cands: readonly T[],
  groupOf: (c: T) => string,
  isCached: (c: T) => boolean,
  preferred: readonly string[] = PREFERRED_TRANSCRIPTS,
  spare: readonly string[] = SPARE_TRANSCRIPTS,
): T[] {
  const groups = new Map<string, T[]>();
  for (const c of cands) groups.set(groupOf(c), [...(groups.get(groupOf(c)) ?? []), c]);
  const within = (names: readonly string[]) =>
    names.flatMap((p) => [...groups].filter(([g]) => g.startsWith(p)).map(([, cs]) => orderCandidates(cs, isCached)));
  const first = within(preferred);
  if (first.length === 0) return orderCandidates(cands, isCached);
  const used = new Set([...first, ...within(spare)].flat());
  const rest = [...groups.values()].map((cs) => orderCandidates(cs, isCached).filter((c) => !used.has(c))).filter((l) => l.length > 0);
  return [...roundRobin(first), ...roundRobin(within(spare)), ...roundRobin(rest)];
}

/**
 * Walks `ordered` K at a time, asking `ratioOf` for the T0 reduction of each, and keeps those under `MIN_REDUCTION`,
 * stopping once `n` are found. `ratioOf` may throw; that case is counted as failed and left out. With `cap`, no group
 * (transcript) keeps more than `cap.perGroup`; a candidate of a full group is skipped without being asked.
 */
export async function selectShortfalls<T>(
  ordered: readonly T[],
  n: number,
  k: number,
  ratioOf: (c: T) => Promise<number>,
  cap?: { perGroup: number; groupOf: (c: T) => string },
): Promise<{ picked: { c: T; t0Ratio: number }[]; examined: number; failed: number; capped: number }> {
  const picked: { c: T; t0Ratio: number }[] = [];
  const taken = new Map<string, number>();
  const full = (c: T): boolean => cap !== undefined && (taken.get(cap.groupOf(c)) ?? 0) >= cap.perGroup;
  let examined = 0;
  let failed = 0;
  let capped = 0;
  let i = 0;
  while (i < ordered.length && picked.length < n) {
    const chunk: T[] = [];
    while (i < ordered.length && chunk.length < k) {
      const c = ordered[i++]!;
      if (full(c)) capped++;
      else chunk.push(c);
    }
    const ratios = await Promise.all(chunk.map((c) => ratioOf(c).then((r) => r, () => undefined)));
    chunk.forEach((c, j) => {
      examined++;
      const r = ratios[j];
      if (r === undefined) failed++;
      else if (r < MIN_REDUCTION && picked.length < n) {
        if (full(c)) capped++;
        else {
          picked.push({ c, t0Ratio: r });
          if (cap) taken.set(cap.groupOf(c), (taken.get(cap.groupOf(c)) ?? 0) + 1);
        }
      }
    });
  }
  return { picked, examined, failed, capped };
}

/** `a (5), b (4)`: the transcripts of the picked cases with their counts, in first-pick order. */
export function transcriptsUsed(cases: readonly Pick<Case, 'id'>[]): string {
  const counts = new Map<string, number>();
  for (const c of cases) counts.set(transcriptOf(c), (counts.get(transcriptOf(c)) ?? 0) + 1);
  return [...counts].map(([t, m]) => `${shortId(t)} (${m})`).join(', ') || 'none';
}

// ---- Verdict ----

type Category = Question['category'];
/** Pass counts per arm; O and L are absent when they did not run. */
type ArmCounts = Record<'BI' | 'N', number> & Partial<Record<'O' | 'L', number>>;

export interface BenchRow {
  id: string;
  t0Ratio: number;
  /** Arm L's result against the original; the T0 ratio when no cut-off reached the minimum. */
  lRatio: number;
  /** Arm N's result against the original; the T0 ratio when no rung reached the minimum. */
  nRatio: number;
  /** The built-in summary's reduction against the original. */
  biRatio: number;
  /** L's keep cut-off chosen, or 'none'. */
  cutoff: number | 'none';
  /** N's rung chosen, or 'none'. */
  rung: Rung | 'none';
  questions: number;
  pass: ArmCounts;
  /** Characters of eligible notifications, and of those folded (originals), at the chosen rung. */
  notifChars?: number;
  foldedChars?: number;
  /** Characters the chosen rung removed, split into strip and fold. */
  stripChars?: number;
  foldChars?: number;
  /** Jev requests spent on the case: T0, notification scoring, prose scoring for N, prose scoring for L. */
  requests?: { t0: number; notif: number; proseN: number; proseL: number };
  byCategory?: Partial<Record<Category, { n: number; pass: ArmCounts }>>;
}

export interface BenchVerdict {
  verdict: 'PASS' | 'FAIL';
  cases: number;
  /** Cases where arm N reached the minimum. */
  reached: number;
  reachRate: number;
  /** Cases where arm L reached the minimum (comparison only). */
  reachedL: number;
  questions: number;
  /** Pooled recall per arm; NaN for an arm that did not run. */
  recall: Record<Arm, number>;
  /** Pooled N recall over pooled O recall (not gating). */
  retention: number;
  meanBiRatio: number;
  meanLRatio: number;
  meanNRatio: number;
  reasons: string[];
}

const mean = (xs: number[]): number => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);

/** PASS when pooled N recall >= pooled BI recall and at least half the cases reached the minimum with N. L is only reported. */
export function benchVerdict(rows: readonly BenchRow[]): BenchVerdict {
  const questions = rows.reduce((n, r) => n + r.questions, 0);
  const recallOf = (arm: Arm): number => (questions === 0 || rows.some((r) => r.pass[arm] === undefined) ? NaN : rows.reduce((n, r) => n + (r.pass[arm] ?? 0), 0) / questions);
  const recall = { O: recallOf('O'), BI: recallOf('BI'), L: recallOf('L'), N: recallOf('N') };
  const reached = rows.filter((r) => r.rung !== 'none').length;
  const reachRate = rows.length === 0 ? NaN : reached / rows.length;
  const reasons: string[] = [];
  if (!(recall.N >= recall.BI)) reasons.push('pooled N recall is below pooled BI recall');
  if (!(reachRate >= 0.5)) reasons.push('fewer than half the cases reached 0.25');
  return {
    verdict: reasons.length === 0 ? 'PASS' : 'FAIL',
    cases: rows.length,
    reached,
    reachRate,
    reachedL: rows.filter((r) => r.cutoff !== 'none').length,
    questions,
    recall,
    retention: recall.O > 0 ? recall.N / recall.O : NaN,
    meanBiRatio: mean(rows.map((r) => r.biRatio)),
    meanLRatio: mean(rows.map((r) => r.lRatio)),
    meanNRatio: mean(rows.map((r) => r.nRatio)),
    reasons,
  };
}

const pct = (x: number): string => (Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(1)}%`);
/** A pooled recall, or why there is none: O was filtered at question generation, L was switched off. */
const recallText = (arm: Arm, x: number): string => (Number.isNaN(x) && arm === 'O' ? 'filtered' : Number.isNaN(x) && arm === 'L' ? 'off' : pct(x));
const cell = (n: number | undefined, arm: Arm): string => (n === undefined ? (arm === 'O' ? 'filtered' : 'off') : String(n));
const sum = (xs: (number | undefined)[]): number => xs.reduce((a: number, b) => a + (b ?? 0), 0);
const foldedFraction = (r: Pick<BenchRow, 'notifChars' | 'foldedChars'>): number => (r.notifChars ? (r.foldedChars ?? 0) / r.notifChars : NaN);

export function renderBench(rows: readonly BenchRow[], v: BenchVerdict, models: readonly string[]): string {
  const cats = new Map<Category, { n: number; pass: ArmCounts }>();
  for (const r of rows) {
    for (const [c, e] of Object.entries(r.byCategory ?? {}) as [Category, { n: number; pass: ArmCounts }][]) {
      const t = cats.get(c) ?? { n: 0, pass: { BI: 0, N: 0 } };
      t.n += e.n;
      for (const a of ARMS) if (e.pass[a] !== undefined) t.pass[a] = (t.pass[a] ?? 0) + e.pass[a]!;
      cats.set(c, t);
    }
  }
  const lines = [
    '# Notification trim (arm N) against the built-in summary',
    '',
    `Verdict: **${v.verdict}**${v.reasons.length ? ` (${v.reasons.join('; ')})` : ''}`,
    '',
    `- cases: ${v.cases}, questions: ${v.questions}`,
    `- reach rate (N at or above ${MIN_REDUCTION}): ${v.reached}/${v.cases} = ${pct(v.reachRate)}${Number.isNaN(v.recall.L) ? '' : `; L reached ${v.reachedL}/${v.cases}`}`,
    `- mean reduction: BI ${pct(v.meanBiRatio)}, L ${pct(v.meanLRatio)}, N ${pct(v.meanNRatio)}`,
    `- pooled recall: O ${recallText('O', v.recall.O)}, BI ${pct(v.recall.BI)}, L ${recallText('L', v.recall.L)}, N ${pct(v.recall.N)}; retention N/O ${pct(v.retention)} (not gating)`,
    `- folded fraction of notification characters, pooled: ${pct(sum(rows.map((r) => r.foldedChars)) / (sum(rows.map((r) => r.notifChars)) || NaN))}; removed: strip ${sum(rows.map((r) => r.stripChars))}, fold ${sum(rows.map((r) => r.foldChars))} chars`,
    `- Jev requests: ${sum(rows.map((r) => r.requests && r.requests.t0 + r.requests.notif + r.requests.proseN + r.requests.proseL))} over ${v.cases} cases`,
    `- model: ${models.length ? models.join(', ') : 'none'}`,
    '',
    'N and L are the built-in summary on a case where no rung or cut-off reached the minimum, as in the hook; the ratio there is the T0 ratio.',
    '',
    '| case | T0 | N | L | BI | rung | cut-off | folded | strip | fold | Jev req | questions | O | BI | L | N | N/O |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${r.id} | ${pct(r.t0Ratio)} | ${pct(r.nRatio)} | ${pct(r.lRatio)} | ${pct(r.biRatio)} | ${r.rung} | ${r.cutoff} | ${pct(foldedFraction(r))} | ${r.stripChars ?? '-'} | ${r.foldChars ?? '-'} | ${r.requests ? r.requests.t0 + r.requests.notif + r.requests.proseN + r.requests.proseL : '-'} | ${r.questions} | ${cell(r.pass.O, 'O')} | ${r.pass.BI} | ${cell(r.pass.L, 'L')} | ${r.pass.N} | ${pct(r.pass.O ? r.pass.N / r.pass.O : NaN)} |`,
    ),
    '',
  ];
  if (cats.size > 0) {
    lines.push('Recall by question category (pooled):', '', '| category | questions | O | BI | L | N |', '| --- | --- | --- | --- | --- | --- |');
    for (const [c, t] of [...cats].sort(([a], [b]) => a.localeCompare(b))) lines.push(`| ${c} | ${t.n} | ${cell(t.pass.O, 'O')} | ${t.pass.BI} | ${cell(t.pass.L, 'L')} | ${t.pass.N} |`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---- The run ----

type T0 = Awaited<ReturnType<typeof compact>>;

async function t0Of(messages: Message[], asker: JevAsker): Promise<T0> {
  const t0 = await compact(messages, asker, {});
  if (t0.stats.requests > 0 && t0.stats.failedRequests === t0.stats.requests) throw new Error('every Jev request failed in T0');
  return t0;
}

/** Answers T0's questions from saved decisions: no network. A call with no saved decision is kept. */
function replayAsker(saved: SavedT0): JevAsker {
  const byId = new Map(saved.decisions.map((d) => [d.id, d]));
  return {
    async ask(_state, questions: JevQuestions) {
      const answers: Record<string, { type: 'noul'; noul: number }> = {};
      for (const key of Object.keys(questions)) {
        const d = byId.get(key.replace(/^(call|result)_/, ''));
        answers[key] = { type: 'noul', noul: !d ? 1 : key.startsWith('call_') ? d.keepCall : d.keepResult };
      }
      return { answers };
    },
  };
}

/** The dry run's stand-in for Jev: the same low answer for every notification and prose unit. */
export function fakeAsker(noul = 0.1): JevAsker {
  return {
    async ask(_state, questions: JevQuestions) {
      return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, noul }])) };
    },
  };
}

/** Arm N: the plugin's own composition over T0's result (prose trim on, notification trim on, an archive that is never written). */
async function armN(messages: Message[], t0: CompactResult, asker: JevAsker): Promise<TrimRescue | undefined> {
  const archive = noWriteArchive();
  try {
    return await trimRescue({
      messages,
      result: t0,
      asker,
      options: resolveOptions({}),
      proseTrim: true,
      minRatio: MIN_REDUCTION,
      archive,
      pathOf: archive.pathOf,
    });
  } catch {
    return undefined;
  }
}

/** An archive writer that names paths like the hook's but writes nothing. */
const noWriteArchive = () => archiveWriter({ fs: { exists: async () => true, write: async () => {}, read: async () => '' } });

type NMetrics = { notifChars: number; foldedChars: number; stripChars: number; foldChars: number };

/** Splits what the chosen rung removed into strip and fold, by reapplying the same scores at a rung that only strips. */
export function nMetrics(trim: TrimRescue | undefined): NMetrics | undefined {
  const scores: NotificationScores | undefined = trim?.scores;
  const notified = trim?.rescue?.applied.notified;
  if (!scores || !notified) return undefined;
  const stripped = applyNotifications(scores, 0, noWriteArchive().pathOf).replaced;
  const m: NMetrics = { notifChars: sum(scores.entries.map((e) => (scores.messages[e.index] as Message).text.length)), foldedChars: 0, stripChars: 0, foldChars: 0 };
  for (const [original, rewritten] of notified.replaced) {
    const afterStrip = stripped.get(original)?.text.length ?? original.text.length;
    m.stripChars += original.text.length - afterStrip;
    if (rewritten.text.length < afterStrip) {
      m.foldChars += afterStrip - rewritten.text.length;
      m.foldedChars += original.text.length;
    }
  }
  return m;
}

export function scoreArm(text: string, qs: Question[], deps: Deps, stats: ReturnType<typeof makeStats>, gate: Gate): Promise<boolean[]> {
  return Promise.all(qs.map(async (q) => {
    let judgeRefused = false;
    const judge = async (prompt: string): Promise<string> => {
      const j = await gate(() => ask(prompt, stats, deps.spawn));
      if (!j) judgeRefused = true;
      return j?.text ?? '';
    };
    const a = await gate(() => ask(answerPrompt(text, q), stats, deps.spawn));
    if (!a) return false;
    const outcome = (await scoreAnswerAsync(q, a.text, judge)).outcome;
    return !judgeRefused && outcome === 'pass';
  }));
}
const count = (xs: boolean[]): number => xs.filter(Boolean).length;

/** The case's cached questions, or generated, filtered by the original and cached (the existing questions flow). */
export async function questionsFor(c: Case, deps: Deps, stats: ReturnType<typeof makeStats>, gate: Gate): Promise<Question[]> {
  const cached = loadQuestions(deps.cacheDir, c.id);
  if (cached) return cached.questions;
  const history = renderMessages(deps.messages(c));
  const gen = await gate(() => ask(questionPrompt(history, PINNED_TAIL), stats, deps.spawn));
  if (!gen) throw new Error('question prompt over the cap');
  const parsed = parseQuestions(c.id, gen.text);
  if (parsed.malformed) throw new Error('malformed question reply');
  const judge = async (prompt: string): Promise<string> => (await gate(() => ask(prompt, stats, deps.spawn)))?.text ?? '';
  const results = await Promise.all(parsed.questions.map(async (q) => {
    const a = await gate(() => ask(answerPrompt(history, q), stats, deps.spawn));
    return !!a && (await scoreAnswerAsync(q, a.text, judge)).outcome === 'pass';
  }));
  const passed = new Map(parsed.questions.map((q, i) => [q.id, results[i]!]));
  const { kept, dropped } = dropFailed(parsed.questions, passed);
  saveQuestions(deps.cacheDir, c.id, kept, { dropped, model: gen.model });
  return kept;
}

const USAGE = 'usage: bench.ts [--cases <N>] [--concurrency <K>] [--per-transcript <K>] [--arms <list of O,BI,L,N; BI and N always run>] [--dry-run] [--t0-dir <dir>]';

/** Replays T0 from saved decisions, runs arm N against a fake asker, prints per case the rung and the folded fraction. No live call. */
async function dryRun(n: number, k: number, perTranscript: number, deps: Deps): Promise<number> {
  const { cases: eligible, skipped } = deps.cases();
  deps.print(`dry run: no live call is made. transcripts skipped (changed since the freeze): ${skipped}`);
  const saved = new Map<string, SavedT0>();
  for (const c of eligible) {
    const s = deps.savedT0?.(c);
    if (s) saved.set(c.id, s);
  }
  const unsaved = eligible.filter((c) => !saved.has(c.id));
  if (unsaved.length > 0) {
    const per = new Map<string, number>();
    for (const c of unsaved) per.set(shortId(transcriptOf(c)), (per.get(shortId(transcriptOf(c))) ?? 0) + 1);
    deps.print(`cases with no saved T0 (selection needs live T0): ${unsaved.length} [${[...per].map(([t, m]) => `${t} ${m}`).join(', ')}]`);
  }
  const cached = (c: Case) => (loadQuestions(deps.cacheDir, c.id)?.questions.length ?? 0) > 0;
  const t0s = new Map<string, T0>();
  const sel = await selectShortfalls(
    orderForSelection(eligible.filter((c) => saved.has(c.id)), transcriptOf, cached),
    n,
    k,
    async (c) => {
      const t0 = await compact(deps.messages(c), replayAsker(saved.get(c.id)!), {});
      t0s.set(c.id, t0);
      return reductionRatio(t0);
    },
    { perGroup: perTranscript, groupOf: transcriptOf },
  );
  deps.print(`from saved T0: examined ${sel.examined}, under ${MIN_REDUCTION}: ${sel.picked.length} of ${n} wanted, skipped by the per-transcript cap ${sel.capped}`);
  deps.print(`transcripts used: ${transcriptsUsed(sel.picked.map((p) => p.c))}`);
  const fake = fakeAsker(0.1);
  let reached = 0;
  for (const { c, t0Ratio } of sel.picked) {
    const t0 = t0s.get(c.id)!;
    const trim = await armN(deps.messages(c), t0, fake);
    const rescue = trim?.rescue;
    const m = nMetrics(trim);
    if (rescue) reached++;
    deps.print(
      `${c.id}: T0 ${pct(t0Ratio)}; rung ${rescue ? rescue.rung : 'none'}${rescue ? `, N ${pct(reductionRatio(rescue.result))}` : ''}; folded ${m ? pct(m.notifChars ? m.foldedChars / m.notifChars : NaN) : 'n/a'} of ${m?.notifChars ?? 0} notification chars`,
    );
  }
  deps.print(`dry run done: N would reach ${MIN_REDUCTION} on ${reached}/${sel.picked.length} selected cases${sel.picked.length < n ? `; ${n - sel.picked.length} short of the ${n} wanted` : ''}`);
  return 0;
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const posInt = (name: string, fallback: number): number => {
    const v = flag(name);
    return v === undefined ? fallback : /^[1-9]\d*$/.test(v) ? Number(v) : NaN;
  };
  const n = posInt('--cases', DEFAULT_CASES);
  const k = posInt('--concurrency', DEFAULT_CONCURRENCY);
  const perTranscript = posInt('--per-transcript', DEFAULT_PER_TRANSCRIPT);
  const arms = parseArms(flag('--arms'));
  if (Number.isNaN(n) || Number.isNaN(k) || Number.isNaN(perTranscript) || !arms) {
    deps.print(USAGE);
    return 2;
  }
  if (argv.includes('--dry-run')) return dryRun(n, k, perTranscript, deps);
  let asker: JevAsker;
  try {
    asker = deps.makeAsker();
  } catch (e) {
    deps.print(errText(e));
    return 2;
  }
  const { cases: eligible, skipped } = deps.cases();
  deps.print(`transcripts skipped (changed since the freeze): ${skipped}`);
  const cached = (c: Case) => (loadQuestions(deps.cacheDir, c.id)?.questions.length ?? 0) > 0;
  const t0s = new Map<string, T0>();
  const sel = await selectShortfalls(
    orderForSelection(eligible, transcriptOf, cached),
    n,
    k,
    async (c) => {
      const t0 = await t0Of(deps.messages(c), asker);
      t0s.set(c.id, t0);
      return reductionRatio(t0);
    },
    { perGroup: perTranscript, groupOf: transcriptOf },
  );
  const picked = sel.picked;
  const questionCount = (c: Case) => loadQuestions(deps.cacheDir, c.id)?.questions ?? [];
  const todo = picked.filter((p) => !cached(p.c));
  const cachedQ = picked.reduce((s, p) => s + questionCount(p.c).length, 0);
  const cachedJudge = picked.reduce((s, p) => s + questionCount(p.c).filter((q) => !tokenKind(q.category)).length, 0);
  const estQ = cachedQ + 20 * todo.length;
  const estJudge = cachedJudge + 10 * todo.length;
  const runL = arms.includes('L');
  const t0Requests = [...t0s.values()].reduce((s, t) => s + t.stats.requests, 0);
  const used = new Set(picked.map((p) => transcriptOf(p.c)));
  deps.print(
    [
      `cases with a built-in summary, under the cap: ${eligible.length}`,
      `T0 run on ${sel.examined} (failed ${sel.failed}; ${t0Requests} Jev requests); under ${MIN_REDUCTION}: ${picked.length}, of ${n} wanted; skipped by the per-transcript cap (${perTranscript}): ${sel.capped}`,
      `transcripts used (${used.size}): ${transcriptsUsed(picked.map((p) => p.c))}`,
      ...(used.size < MIN_TRANSCRIPTS ? [`WARNING: fewer than ${MIN_TRANSCRIPTS} transcripts covered`] : []),
      `selected cases: ${picked.length} (cached questions ${picked.length - todo.length}, to generate ${todo.length})`,
      'live calls still to come:',
      `  Jev: ${(runL ? 3 : 2) * picked.length} scoring rounds (one or more requests each; T0 is already done): per case ${runL ? 'one prose-scoring round for L, ' : ''}one notification-scoring round and one prose-scoring round for N`,
      `  claude -p, question generation: ${todo.length} question, ${15 * todo.length}-${25 * todo.length} answer for the original, up to ${25 * todo.length} judge for generated questions;`,
      `  claude -p, arms: up to ${arms.length * estQ} answer and ${arms.length * estJudge} judge (${arms.join(', ')}) over about ${estQ} questions${arms.includes('O') ? '' : ' (O is not re-answered: the questions already passed it)'}; arm N is ${estQ} answer and ${estJudge} judge of those, and costs nothing when it falls back to the built-in summary`,
    ].join('\n'),
  );
  if (picked.length === 0) {
    deps.print('no case where T0 falls short; nothing to run');
    return 1;
  }
  if (!(await deps.confirm(`Run these live Jev and claude -p calls on ${picked.length} cases?`))) return 1;

  const stats = makeStats();
  const gate = limiter(k * CALLS_PER_CASE);
  const failedCases: string[] = [];
  const out = await mapLimit(picked, k, async ({ c, t0Ratio }): Promise<BenchRow | undefined> => {
    try {
      const messages = deps.messages(c);
      const t0 = t0s.get(c.id)!;
      const qs = await questionsFor(c, deps, stats, gate);
      if (qs.length === 0) throw new Error('no question survived the original');
      const options = resolveOptions({});
      let rescue: ReturnType<typeof ladderRescue>;
      let proseLRequests = 0;
      if (runL) try {
        const scores = await scoreProse(t0.messages, callActions(messages, t0.decisions, options.preserveRecentMessages), asker, options);
        proseLRequests = scores.stats.requests;
        rescue = scores.stats.failed === undefined ? ladderRescue(scores, t0, MIN_REDUCTION) : undefined;
      } catch {
        rescue = undefined;
      }
      const trim = await armN(messages, t0, asker);
      const nRescue = trim?.rescue;
      const bi = c.builtinSummary!;
      const charsBefore = t0.stats.charsBefore;
      // O is scored only on request: the questions already passed the original when they were generated.
      const flags: Partial<Record<Arm, boolean[]>> = {};
      if (arms.includes('O')) flags.O = await scoreArm(renderMessages(messages), qs, deps, stats, gate);
      flags.BI = await scoreArm(bi, qs, deps, stats, gate);
      // With no cut-off or rung the hook hands over to the built-in summary, so that arm is BI and costs no further calls.
      if (runL) flags.L = rescue ? await scoreArm(renderMessages(rescue.result.messages), qs, deps, stats, gate) : flags.BI;
      flags.N = nRescue ? await scoreArm(renderMessages(nRescue.result.messages), qs, deps, stats, gate) : flags.BI;
      const byCategory: NonNullable<BenchRow['byCategory']> = {};
      qs.forEach((q, i) => {
        const e = (byCategory[q.category] ??= { n: 0, pass: Object.fromEntries(ARMS.filter((a) => flags[a]).map((a) => [a, 0])) as ArmCounts });
        e.n++;
        for (const a of ARMS) if (flags[a]) e.pass[a] = (e.pass[a] ?? 0) + (flags[a]![i] ? 1 : 0);
      });
      return {
        id: c.id,
        t0Ratio,
        lRatio: !runL ? NaN : rescue ? reductionRatio(rescue.result) : t0Ratio,
        nRatio: nRescue ? reductionRatio(nRescue.result) : t0Ratio,
        biRatio: charsBefore === 0 ? 0 : (charsBefore - bi.length) / charsBefore,
        cutoff: rescue ? rescue.cutoff : 'none',
        rung: nRescue ? nRescue.rung : 'none',
        questions: qs.length,
        pass: Object.fromEntries(ARMS.filter((a) => flags[a]).map((a) => [a, count(flags[a]!)])) as ArmCounts,
        ...nMetrics(trim),
        requests: { t0: t0.stats.requests, notif: trim?.out.notifications?.stats.requests ?? 0, proseN: trim?.out.prose?.stats.requests ?? 0, proseL: proseLRequests },
        byCategory,
      };
    } catch (e) {
      failedCases.push(c.id);
      deps.print(`${c.id} failed: ${errText(e)}`);
      return undefined;
    }
  });
  const rows = out.filter((r): r is BenchRow => r !== undefined);
  const v = benchVerdict(rows);
  const models = [...new Set(stats.models)];
  const dir = join(deps.outDir, 'bench');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.md'), renderBench(rows, v, models) + (failedCases.length ? `\nfailed cases: ${failedCases.length}\n` : ''));
  writeFileSync(join(dir, 'bench.json'), JSON.stringify({ ...v, models, refusals: stats.refusals, failedCases, rows }, null, 2) + '\n');
  deps.print(
    `bench done: ${v.verdict}; reach ${v.reached}/${v.cases} (${pct(v.reachRate)}); BI reduction ${pct(v.meanBiRatio)}, L ${pct(v.meanLRatio)}, N ${pct(v.meanNRatio)}; recall O ${recallText('O', v.recall.O)} BI ${pct(v.recall.BI)} L ${recallText('L', v.recall.L)} N ${pct(v.recall.N)}; retention N/O ${pct(v.retention)}`,
  );
  return failedCases.length > 0 ? 1 : v.verdict === 'PASS' ? 0 : 1;
}

// ---- Live wiring ----

export const EVAL_DIR = join(homedir(), '.claude', 'fast-jev-eval');

export const hookFetch: HookFetch = async (url, init) => {
  const r = await fetch(url, init as RequestInit);
  const text = await r.text();
  return { status: r.status, ok: r.ok, text, headers: Object.fromEntries(r.headers.entries()) };
};

export function liveDeps(t0Dir = join(EVAL_DIR, 't0')): Deps {
  const outDir = join(EVAL_DIR, 'out');
  let checked: ReturnType<typeof intact> | undefined;
  let loaded: { cases: Case[]; skipped: number } | undefined;
  const transcripts = new Map<string, Message[]>();
  const load = () => (checked ??= intact(JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as Manifest));
  return {
    outDir,
    cacheDir: join(EVAL_DIR, 'cache'),
    cases: () => {
      if (!loaded) {
        const ok = load();
        loaded = {
          cases: loadCases(ok.manifest).filter((c) => c.builtinSummary !== undefined && c.estTokens < EVAL_CAP),
          skipped: ok.skipped,
        };
      }
      return loaded;
    },
    messages: (c) => {
      // Keyed per transcript: cases of different transcripts run at the same time.
      let all = transcripts.get(c.transcript);
      if (!all) {
        const file = load().manifest.files.find((f) => f.path === c.transcript);
        if (!file) throw new Error(`Case ${c.id}: transcript not in the manifest or changed`);
        transcripts.set(c.transcript, (all = loadTranscript(file).messages));
      }
      return all.slice(c.start, c.end);
    },
    makeAsker: () => {
      const key = process.env.TYPESAFE_API_KEY;
      if (!key) throw new Error('TYPESAFE_API_KEY is not set');
      return jevAsker(hookFetch, key, DEFAULT_MODEL);
    },
    savedT0: (c) => {
      const file = join(t0Dir, `t0-${c.id.replace('#', '_')}.json`);
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as SavedT0) : undefined;
    },
    confirm: (q) => confirmFromStream(q),
    print: (m) => console.log(m),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const t0Dir = argv.includes('--t0-dir') ? argv[argv.indexOf('--t0-dir') + 1] : undefined;
  process.exitCode = await main(argv, liveDeps(t0Dir));
}
