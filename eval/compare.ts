// Dev-only (T15): the same compact() with TypeSafe Jev and with OpenAI's Decisions API as the decider, on the same messages.
// `npx tsx eval/compare.ts --split dev --cases 6 [--concurrency K]`. Keys come from process.env.TYPESAFE_API_KEY and
// process.env.OPENAI_API_KEY only and are never printed. Output files (~/.claude/fast-jev-eval/out/compare/) hold ids,
// counts, token numbers, scores and error classes, never transcript, question or answer text.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jevAsker, type HookFetch } from '../hooks/fast-jev.js';
import { compact } from '../src/compact.js';
import { redactText } from '../src/redact.js';
import { DEFAULT_MODEL } from '../src/request.js';
import { estimateTokens } from '../src/state.js';
import type { CallAction, JevAsker, JevQuestions, JevState, Message } from '../src/types.js';
import { renderMessages } from './arms.js';
import { confirmFromStream } from './b-runner.js';
import { ask, EVAL_CAP, makeStats, type SpawnFn, type Stats } from './claude.js';
import { cases as loadCases, DEFAULT_SEED, loadTranscript, split as splitCases, type Case, type Manifest } from './load.js';
import { DecisionsError, openaiAsker } from './openai-asker.js';
import { cacheFile, loadQuestions, tokenKind, type Category, type Question } from './questions.js';
import { answerPrompt, scoreAnswerAsync, type Outcome } from './score.js';

export type Decider = 'jev' | 'openai';
const DECIDERS: Decider[] = ['jev', 'openai'];
const DEFAULT_CONCURRENCY = 4;
/** Each case may have this many claude -p calls in flight, so K x 4 is the process limit (as in run.ts). */
const CALLS_PER_CASE = 4;
/** gpt-6-luna on /v1/decisions: input only, USD per million tokens. */
const OPENAI_USD_PER_M = 0.1;
const RECALL_KINDS = ['path', 'number', 'id', 'error'] as const;

export interface Deps {
  outDir: string;
  /** The question cache (loadQuestions). */
  cacheDir: string;
  cases(split: 'dev' | 'test'): Case[];
  messages(c: Case): Message[];
  spawn?: SpawnFn;
  jevFetch: HookFetch;
  openaiFetch: HookFetch;
  env: Record<string, string | undefined>;
  confirm(question: string): Promise<boolean>;
  print(message: string): void;
}

interface ReqRow {
  caseId: string;
  decider: Decider;
  index: number;
  questions: number;
  /** Input tokens the API reported; null when it reported none. */
  inputReported: number | null;
  /** estimateTokens of the decoded text the model sees (modelText), the same basis for both deciders. */
  inputEstimated: number;
  outputReported: number | null;
  ms: number;
  /** HTTP status of the last attempt; 0 when the fetch itself failed. */
  status: number;
  error: string | null;
  /** A price the response reported, when it did. */
  price: number | null;
}
interface Counts { pass: number; total: number }
interface CaseRow {
  caseId: string;
  decider: Decider;
  contextBefore: number;
  contextAfter: number;
  reductionPct: number;
  kept: number;
  dropped: number;
  trimmed: number;
  requests: number;
  failedRequests: number;
  inputReported: number | null;
  inputEstimated: number;
  /** Sum of request latencies. */
  requestMs: number;
  wallMs: number;
  costUsd: number | null;
  costBasis: 'reported' | 'estimated' | 'mixed' | 'jev-price' | null;
  /** Share of items on which both deciders chose the same action; null when there are none. */
  agreement: number | null;
  /** Null when the case has no cached questions. */
  recall: Record<'overall' | (typeof RECALL_KINDS)[number], Counts> | null;
}
interface Entry {
  row: CaseRow;
  requests: ReqRow[];
  /** Action per unpinned call id, for agreement. */
  actions: Record<string, CallAction>;
  models: string[];
}

const readJson = <T>(file: string): T | undefined => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : undefined);
const writeText = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
/** The sum, or null unless every entry is a number: a partial total would undercount. */
const reportedSum = (xs: (number | null)[]): number | null => (xs.length === 0 || xs.some((x) => x === null) ? null : sum(xs as number[]));

/** At most `n` tasks run at once; the rest wait their turn (as in run.ts). */
const limiter = (n: number) => {
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
type Gate = ReturnType<typeof limiter>;
const mapLimit = async <T, R>(items: T[], k: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
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

const errorClass = (e: unknown, status: number): string => {
  if (e instanceof DecisionsError) return e.kind === 'http' ? `http_${e.status}` : e.kind;
  if (e instanceof Error && e.name === 'TimeoutError') return 'timeout';
  return status >= 400 ? `http_${status}` : status === 0 ? 'network' : 'error';
};
const numberOr = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The text the model reads, decoded: the state as one string (what Jev nests as `state` and OpenAI sends as `input`)
 * plus the questions' instruction and criteria text. Counting the raw HTTP body instead would bill OpenAI's
 * string-in-JSON `input` for a second round of quote and backslash escaping that Jev's nested object does not pay.
 */
export function modelText(state: JevState, questions: JevQuestions): string {
  const parts: string[] = [typeof state === 'string' ? state : JSON.stringify(state)];
  for (const q of Object.values(questions)) {
    parts.push(q.instructions);
    if (q.type === 'noul') parts.push(q.criteria?.true ?? '', q.criteria?.false ?? '');
    else if (q.type === 'choice') parts.push(...Object.entries(q.criteria).flatMap(([k, v]) => [k, v ?? '']));
    else parts.push(...q.criteria);
  }
  return parts.join('\n');
}

/** Logs one row per asker call: the decoded model text's estimate, last status, latency, reported usage, error class. */
function instrument(make: (f: HookFetch) => JevAsker, base: HookFetch, caseId: string, decider: Decider, log: ReqRow[]): JevAsker {
  let next = 0;
  return {
    async ask(state, questions) {
      const index = next++;
      let status = 0;
      const f: HookFetch = async (url, init) => {
        status = 0;
        const r = await base(url, init);
        status = r.status;
        return r;
      };
      const row = { caseId, decider, index, questions: Object.keys(questions).length };
      const estimated = estimateTokens(modelText(state, questions));
      const started = Date.now();
      try {
        const res = await make(f).ask(state, questions);
        const price = numberOr((res as { price?: unknown }).price) ?? numberOr((res as { cost?: unknown }).cost);
        log.push({ ...row, inputReported: numberOr(res.usage?.input_tokens), inputEstimated: estimated, outputReported: numberOr(res.usage?.output_tokens), ms: Date.now() - started, status, error: null, price });
        return res;
      } catch (e) {
        log.push({ ...row, inputReported: null, inputEstimated: estimated, outputReported: null, ms: Date.now() - started, status, error: errorClass(e, status), price: null });
        throw e;
      }
    },
  };
}

const questionsOf = (deps: Deps, c: Case): Question[] => loadQuestions(deps.cacheDir, c.id)?.questions ?? [];

/** Answers every question from the compacted text and scores it (as run.ts scoreArm does); a refused call is unknown. */
function scoreText(text: string, qs: Question[], stats: Stats, deps: Deps, gate: Gate): Promise<{ category: Category; outcome: Outcome }[]> {
  return Promise.all(qs.map(async (q) => {
    let judgeRefused = false;
    const judge = async (prompt: string): Promise<string> => {
      const j = await gate(() => ask(prompt, stats, deps.spawn));
      if (!j) judgeRefused = true;
      return j?.text ?? '';
    };
    const a = await gate(() => ask(answerPrompt(text, q), stats, deps.spawn));
    const outcome = a ? (await scoreAnswerAsync(q, a.text, judge)).outcome : 'unknown';
    return { category: q.category, outcome: judgeRefused ? 'unknown' : outcome };
  }));
}

const countsOf = (rows: { category: Category; outcome: Outcome }[]): NonNullable<CaseRow['recall']> => {
  const of = (keep: (c: Category) => boolean): Counts => {
    const own = rows.filter((r) => keep(r.category));
    return { pass: own.filter((r) => r.outcome === 'pass').length, total: own.length };
  };
  return { overall: of(() => true), path: of((c) => c === 'path'), number: of((c) => c === 'number'), id: of((c) => c === 'id'), error: of((c) => c === 'error') };
};

/** `log` is filled as the asker is called, so a failed run still leaves its request rows. */
async function runDecider(deps: Deps, c: Case, decider: Decider, keys: { jev: string; openai: string }, gate: Gate, log: ReqRow[]): Promise<Entry> {
  const messages = deps.messages(c);
  const asker = decider === 'jev'
    ? instrument((f) => jevAsker(f, keys.jev, DEFAULT_MODEL), deps.jevFetch, c.id, decider, log)
    : instrument((f) => openaiAsker(f, keys.openai), deps.openaiFetch, c.id, decider, log);
  const result = await compact(messages, asker, {});
  // A failed call leaves its calls defaulted to keep; such a run would skew size and agreement, so it is not a result.
  if (result.stats.failedRequests > 0) throw new Error(`${result.stats.failedRequests} of ${result.stats.requests} ${decider} requests failed`);
  const stats = makeStats();
  const qs = questionsOf(deps, c);
  const recall = qs.length > 0 ? countsOf(await scoreText(renderMessages(result.messages), qs, stats, deps, gate)) : null;
  const before = estimateTokens(renderMessages(messages));
  const after = estimateTokens(renderMessages(result.messages));
  const reported = reportedSum(log.map((r) => r.inputReported));
  const estimated = sum(log.map((r) => r.inputEstimated));
  const prices = log.map((r) => r.price);
  const jevPrice = decider === 'jev' && prices.length > 0 && prices.every((p) => p !== null) ? sum(prices as number[]) : null;
  const tokens = sum(log.map((r) => r.inputReported ?? r.inputEstimated));
  const nReported = log.filter((r) => r.inputReported !== null).length;
  const basis: CaseRow['costBasis'] = nReported === log.length ? 'reported' : nReported === 0 ? 'estimated' : 'mixed';
  const cost = decider === 'openai'
    ? { costUsd: (tokens / 1e6) * OPENAI_USD_PER_M, costBasis: basis }
    : { costUsd: jevPrice, costBasis: (jevPrice === null ? null : 'jev-price') as CaseRow['costBasis'] };
  return {
    row: {
      caseId: c.id, decider, contextBefore: before, contextAfter: after, reductionPct: before === 0 ? 0 : ((before - after) / before) * 100,
      kept: result.stats.kept, dropped: result.stats.callsDropped, trimmed: result.stats.resultsDropped,
      requests: result.stats.requests, failedRequests: result.stats.failedRequests, inputReported: reported, inputEstimated: estimated,
      requestMs: sum(log.map((r) => r.ms)), wallMs: result.stats.ms, ...cost, agreement: null, recall,
    },
    requests: log,
    actions: Object.fromEntries(result.decisions.filter((d) => d.reason !== 'pinned').map((d) => [d.id, d.action])),
    models: [...new Set(stats.models)],
  };
}

/** Items on which both deciders chose the same action. */
const agreementOf = (a: Entry, b: Entry): { agree: number; items: number } => {
  const ids = Object.keys(a.actions).filter((id) => id in b.actions);
  return { agree: ids.filter((id) => a.actions[id] === b.actions[id]).length, items: ids.length };
};

// ---- Report ----

const fmt = (n: number | null, digits = 0): string => (n === null ? 'n/a' : n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }));
interface Line { label: string; jev: number | null; openai: number | null; digits?: number; points?: boolean }
const diff = (l: Line): string => {
  if (l.jev === null || l.openai === null) return 'n/a';
  const d = l.openai - l.jev;
  const sign = (n: number, digits: number) => `${n > 0 ? '+' : ''}${fmt(n, digits)}`;
  if (l.points) return `${sign(d, 1)} pts`;
  return l.jev === 0 ? sign(d, l.digits ?? 0) : `${sign(d, l.digits ?? 0)} (${sign((d / l.jev) * 100, 1)}%)`;
};
const table = (lines: Line[]): string =>
  ['| Metric | Jev | OpenAI | OpenAI - Jev |', '| --- | ---: | ---: | ---: |', ...lines.map((l) => `| ${l.label} | ${fmt(l.jev, l.digits ?? 0)} | ${fmt(l.openai, l.digits ?? 0)} | ${diff(l)} |`)].join('\n');

const rate = (c: Counts): number | null => (c.total === 0 ? null : (c.pass / c.total) * 100);
const addCounts = (xs: (Counts | undefined)[]): Counts => ({ pass: sum(xs.map((x) => x?.pass ?? 0)), total: sum(xs.map((x) => x?.total ?? 0)) });

function lines(j: CaseRow[], o: CaseRow[], agreement: { agree: number; items: number }): Line[] {
  const pair = (f: (r: CaseRow) => number | null, digits = 0) => ({ jev: reportedSum(j.map(f)), openai: reportedSum(o.map(f)), digits });
  const recall = (kind: 'overall' | (typeof RECALL_KINDS)[number]) => ({ jev: rate(addCounts(j.map((r) => r.recall?.[kind]))), openai: rate(addCounts(o.map((r) => r.recall?.[kind]))), digits: 1, points: true });
  const before = (rows: CaseRow[]) => sum(rows.map((r) => r.contextBefore));
  const after = (rows: CaseRow[]) => sum(rows.map((r) => r.contextAfter));
  const reduction = (rows: CaseRow[]) => (before(rows) === 0 ? null : ((before(rows) - after(rows)) / before(rows)) * 100);
  const agreementPct = agreement.items === 0 ? null : (agreement.agree / agreement.items) * 100;
  return [
    { label: 'Asker calls', jev: sum(j.map((r) => r.requests)), openai: sum(o.map((r) => r.requests)) },
    { label: 'Failed calls', jev: sum(j.map((r) => r.failedRequests)), openai: sum(o.map((r) => r.failedRequests)) },
    { label: 'Input tokens, reported by the API', ...pair((r) => r.inputReported) },
    { label: 'Input tokens, estimated from the request body', ...pair((r) => r.inputEstimated) },
    { label: 'Context tokens before', jev: before(j), openai: before(o) },
    { label: 'Context tokens after', jev: after(j), openai: after(o) },
    { label: 'Reduction %', jev: reduction(j), openai: reduction(o), digits: 1, points: true },
    { label: 'Recall % (overall)', ...recall('overall') },
    { label: 'Recall % (paths)', ...recall('path') },
    { label: 'Recall % (numbers)', ...recall('number') },
    { label: 'Recall % (IDs)', ...recall('id') },
    { label: 'Recall % (errors)', ...recall('error') },
    { label: 'Kept calls', jev: sum(j.map((r) => r.kept)), openai: sum(o.map((r) => r.kept)) },
    { label: 'Dropped calls', jev: sum(j.map((r) => r.dropped)), openai: sum(o.map((r) => r.dropped)) },
    { label: 'Trimmed results', jev: sum(j.map((r) => r.trimmed)), openai: sum(o.map((r) => r.trimmed)) },
    { label: 'Label agreement %', jev: agreementPct, openai: agreementPct, digits: 1, points: true },
    { label: 'Wall latency ms', ...pair((r) => r.wallMs) },
    { label: 'Sum of request latencies ms', ...pair((r) => r.requestMs) },
    { label: 'Cost USD', ...pair((r) => r.costUsd, 6) },
  ];
}

function renderCompare(split: string, pairs: { id: string; jev: Entry; openai: Entry }[], models: string[], failed: string[]): string {
  const per = pairs.map((p) => {
    const a = agreementOf(p.jev, p.openai);
    return `## ${p.id}\n\n${table(lines([p.jev.row], [p.openai.row], a))}\n`;
  });
  const total = pairs.reduce((t, p) => {
    const a = agreementOf(p.jev, p.openai);
    return { agree: t.agree + a.agree, items: t.items + a.items };
  }, { agree: 0, items: 0 });
  const basis = pairs.some((p) => p.openai.row.costBasis === 'estimated' || p.openai.row.costBasis === 'mixed') ? '\nOpenAI cost uses estimated input tokens for each call where the API reported none ($0.10 per 1M input tokens). Jev cost is n/a unless its response reports a price.\n' : '\nOpenAI cost is $0.10 per 1M input tokens. Jev cost is n/a unless its response reports a price.\n';
  return [
    `# Jev vs OpenAI Decisions, split ${split}, ${pairs.length} cases\n`,
    `## Totals\n\n${table(lines(pairs.map((p) => p.jev.row), pairs.map((p) => p.openai.row), total))}\n${basis}`,
    ...per,
    `recall model: ${models.length > 0 ? models.join(', ') : 'none'}`,
    failed.length > 0 ? `failed cases (not in the tables): ${failed.length}` : '',
    '',
  ].join('\n');
}

// ---- Command ----

const USAGE = 'usage: compare.ts --split dev|test [--cases <N>] [--concurrency <K>]';

export async function main(argv: string[], deps: Deps): Promise<number> {
  const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const posInt = (name: string): number | undefined => {
    const v = flag(name);
    return v === undefined ? undefined : /^[1-9]\d*$/.test(v) ? Number(v) : NaN;
  };
  const cases = posInt('--cases');
  const k = posInt('--concurrency') ?? DEFAULT_CONCURRENCY;
  const split = flag('--split');
  if (Number.isNaN(cases) || Number.isNaN(k) || (split !== 'dev' && split !== 'test')) {
    deps.print(USAGE);
    return 2;
  }
  const keys = { jev: deps.env.TYPESAFE_API_KEY ?? '', openai: deps.env.OPENAI_API_KEY ?? '' };
  const missing = [...(keys.jev ? [] : ['TYPESAFE_API_KEY']), ...(keys.openai ? [] : ['OPENAI_API_KEY'])];
  if (missing.length > 0) {
    deps.print(`${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set`);
    return 2;
  }
  const clean = (text: string) => redactText(redactText(text, keys.jev), keys.openai);
  const errText = (e: unknown): string => clean(e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 100);

  const all = deps.cases(split);
  const chosen = cases === undefined ? all : all.slice(0, cases);
  const cacheDir = join(deps.outDir, 'compare', 'cache');
  const fileOf = (c: Case, d: Decider) => cacheFile(cacheDir, `${c.id}.${d}`);
  const todo = chosen.flatMap((c) => DECIDERS.filter((d) => !existsSync(fileOf(c, d))).map((d) => ({ c, d })));

  // Expected asker calls: batching depends only on the state and the candidates, so a keep-everything fake counts them.
  const expected = new Map<string, number>();
  for (const c of new Set(todo.map((t) => t.c))) {
    const fake: JevAsker = { ask: async (_s, qs) => ({ answers: Object.fromEntries(Object.keys(qs).map((n) => [n, { type: 'noul' as const, noul: 0.9 }])) }) };
    expected.set(c.id, (await compact(deps.messages(c), fake, {})).stats.requests);
  }
  const perDecider = (d: Decider) => sum(todo.filter((t) => t.d === d).map((t) => expected.get(t.c.id) ?? 0));
  const qsOf = (c: Case) => questionsOf(deps, c);
  const answers = sum(todo.map((t) => qsOf(t.c).length));
  const judges = sum(todo.map((t) => qsOf(t.c).filter((q) => !tokenKind(q.category)).length));
  deps.print(`split ${split}: ${chosen.length} cases, ${todo.length} case-decider runs to do (${chosen.length * DECIDERS.length - todo.length} cached)`);
  deps.print(`expected asker calls: jev ${perDecider('jev')}, openai ${perDecider('openai')}; claude -p calls: ${answers} answer, up to ${judges} judge`);
  const noQs = chosen.filter((c) => qsOf(c).length === 0).length;
  if (noQs > 0) deps.print(`${noQs} cases have no cached questions; their recall is n/a`);
  if (todo.length > 0 && !(await deps.confirm(`Run these live Jev, OpenAI and claude -p calls on ${chosen.length} cases?`))) return 1;

  const gate = limiter(k * CALLS_PER_CASE);
  const failed = new Set<string>();
  const failedRows: ReqRow[] = [];
  const entries = await mapLimit(chosen, k, async (c) => {
    const out: Partial<Record<Decider, Entry>> = {};
    for (const d of DECIDERS) {
      const file = fileOf(c, d);
      let entry = readJson<Entry>(file);
      if (!entry) {
        const log: ReqRow[] = [];
        try {
          entry = await runDecider(deps, c, d, keys, gate, log);
        } catch (e) {
          failed.add(c.id);
          failedRows.push(...log);
          deps.print(`${c.id} ${d} failed: ${errText(e)}`);
          continue;
        }
        writeText(file, JSON.stringify(entry, null, 2) + '\n');
      }
      out[d] = entry;
    }
    return out;
  });

  const pairs = chosen.flatMap((c, i) => (entries[i]!.jev && entries[i]!.openai ? [{ id: c.id, jev: entries[i]!.jev!, openai: entries[i]!.openai! }] : []));
  const dir = join(deps.outDir, 'compare');
  const withAgreement = (e: Entry, other: Entry): CaseRow => {
    const a = agreementOf(e, other);
    return { ...e.row, agreement: a.items === 0 ? null : a.agree / a.items };
  };
  const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '');
  writeText(join(dir, 'requests.jsonl'), jsonl([...pairs.flatMap((p) => [...p.jev.requests, ...p.openai.requests]), ...failedRows]));
  writeText(join(dir, 'cases.jsonl'), jsonl(pairs.flatMap((p) => [withAgreement(p.jev, p.openai), withAgreement(p.openai, p.jev)])));
  writeText(join(dir, 'report.md'), renderCompare(split, pairs, [...new Set(pairs.flatMap((p) => [...p.jev.models, ...p.openai.models]))], [...failed]));
  deps.print(`compare done: ${pairs.length} cases reported, ${failed.size} failed; report at ${join(dir, 'report.md')}`);
  return failed.size > 0 ? 1 : 0;
}

// ---- Live wiring ----

const EVAL_DIR = join(homedir(), '.claude', 'fast-jev-eval');

const hookFetch: HookFetch = async (url, init) => {
  const r = await fetch(url, init as RequestInit);
  const text = await r.text();
  return { status: r.status, ok: r.ok, text, headers: Object.fromEntries(r.headers.entries()) };
};

export function liveDeps(): Deps {
  const outDir = join(EVAL_DIR, 'out');
  let manifest: Manifest | undefined;
  let split: ReturnType<typeof splitCases> | undefined;
  const loaded = new Map<string, Message[]>();
  const load = () => {
    manifest ??= JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as Manifest;
    split ??= splitCases(loadCases(manifest), EVAL_CAP, DEFAULT_SEED);
    return { manifest, split };
  };
  return {
    outDir,
    cacheDir: join(EVAL_DIR, 'cache'),
    // The same cases, in the same order, as run.ts uses.
    cases: (name) => load().split[name].filter((c) => c.estTokens < EVAL_CAP),
    messages: (c) => {
      let all = loaded.get(c.transcript);
      if (!all) {
        const file = load().manifest.files.find((f) => f.path === c.transcript);
        if (!file) throw new Error(`Case ${c.id}: transcript not in the manifest`);
        loaded.set(c.transcript, (all = loadTranscript(file).messages));
      }
      return all.slice(c.start, c.end);
    },
    jevFetch: hookFetch,
    openaiFetch: hookFetch,
    env: process.env,
    confirm: (q) => confirmFromStream(q),
    print: (m) => console.log(m),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), liveDeps());
}
