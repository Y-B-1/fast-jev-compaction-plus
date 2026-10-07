// Dev-only (T13): the eval driver. `npx tsx eval/run.ts plan|questions|b|dev|test ...`. Not shipped in dist.
// Data: the frozen manifest, cases under the cap. Outputs: ~/.claude/fast-jev-eval/out/ (injectable). Keys come from
// process.env.TYPESAFE_API_KEY only and are never printed. Output files hold ids, tags, categories, scores, counts and
// model ids, never transcript, question or answer text (that stays in the question cache).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jevAsker, type HookFetch } from '../hooks/fast-jev.js';
import { compact, DEFAULT_OPTIONS, reductionRatio } from '../src/compact.js';
import { callActions, trimProse, type ProseDecision } from '../src/prose.js';
import { DEFAULT_MODEL } from '../src/request.js';
import { goalFromMessages } from '../src/state.js';
import type { JevAsker, Message } from '../src/types.js';
import { ARMS, MIN_REDUCTION, readB, renderMessages, type Arm } from './arms.js';
import { confirmFromStream, runHeadless, type BMode } from './b-runner.js';
import { ask, EVAL_CAP, makeStats, type SpawnFn, type Stats } from './claude.js';
import { cases as loadCases, DEFAULT_SEED, loadTranscript, split as splitCases, type Case, type Manifest } from './load.js';
import {
  cacheFile, dropFailed, loadQuestions, parseQuestions, questionPrompt, saveQuestions, tokenKind,
  type Category, type Question, type Tag,
} from './questions.js';
import { buildReport, renderReport } from './report.js';
import { aggregate, answerPrompt, scoreAnswerAsync, type Outcome, type Scored } from './score.js';

export type SplitName = 'dev' | 'test';
export const THRESHOLDS = [0.05, 0.1, 0.15, 0.25, 0.35];
const DEFAULT_THRESHOLD = 0.15;
const SMALL_WINDOW = 5000;
const MIN_TEST_CASES = 24;
const PINNED_TAIL = DEFAULT_OPTIONS.preserveRecentMessages;
/** Trim runs per dev case beyond T0: the sweep, the 5k window, two flip runs, stale only. */
const DEV_TRIM_RUNS = THRESHOLDS.length + 1 + 2 + 1;
/** Scored dev runs per question: S, the sweep, the 5k window, stale only. */
const DEV_SCORED_ARMS = 1 + THRESHOLDS.length + 1 + 1;
const DEFAULT_CONCURRENCY = 4;
/** Cases run K at a time; each may have this many claude -p calls in flight, so K x 4 is the process limit. */
const CALLS_PER_CASE = 4;

export interface Deps {
  outDir: string;
  /** The question cache (saveQuestions / loadQuestions). */
  cacheDir: string;
  /** Cases of a split that are under the cap. */
  cases(split: SplitName): Case[];
  messages(c: Case): Message[];
  spawn?: SpawnFn;
  makeAsker(): JevAsker;
  hasKey(): boolean;
  runHeadless: typeof runHeadless;
  confirm(question: string): Promise<boolean>;
  print(message: string): void;
}

/** What a score file keeps of a question: ids, tag, category and the outcome. */
interface Row {
  id: string;
  caseId: string;
  category: Category;
  tag: Tag;
  field?: string;
  outcome: Outcome;
}
const toRow = (q: Question, outcome: Outcome): Row => ({ id: q.id, caseId: q.caseId, category: q.category, tag: q.tag, ...(q.field !== undefined ? { field: q.field } : {}), outcome });
const toScored = (r: Row): Scored => ({ question: { id: r.id, caseId: r.caseId, question: '', gold: '', evidence: '', category: r.category, tag: r.tag, ...(r.field !== undefined ? { field: r.field } : {}) }, outcome: r.outcome });
const metricsOf = (rows: Row[]) => aggregate(rows.map(toScored));

const uniq = (xs: string[]): string[] => [...new Set(xs)];
const readJson = <T>(file: string): T | undefined => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : undefined);
const writeJson = (file: string, value: unknown): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const errText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 100);

/** At most `n` tasks run at once; the rest wait their turn. */
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
/** Maps with up to `k` in flight; results keep the input order. */
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

const questionsOf = (deps: Deps, c: Case): Question[] => loadQuestions(deps.cacheDir, c.id)?.questions ?? [];
const hasHeadlessB = (deps: Deps, c: Case): boolean => readB(join(deps.outDir, 'b'), c.id)?.mode === 'headless';

// ---- Claude answering and scoring ----

/** Answers every question from the arm text and scores it; a refused (over-cap) answer or judge call is unknown. Rows keep question order. */
function scoreArm(text: string, qs: Question[], stats: Stats, deps: Deps, gate: Gate): Promise<Row[]> {
  return Promise.all(qs.map(async (q) => {
    let judgeRefused = false;
    const judge = async (prompt: string): Promise<string> => {
      const j = await gate(() => ask(prompt, stats, deps.spawn));
      if (!j) judgeRefused = true;
      return j?.text ?? '';
    };
    const a = await gate(() => ask(answerPrompt(text, q), stats, deps.spawn));
    const outcome = a ? (await scoreAnswerAsync(q, a.text, judge)).outcome : 'unknown';
    return toRow(q, judgeRefused ? 'unknown' : outcome);
  }));
}

// ---- Arms at a given threshold (arms.ts buildArms takes no threshold, so its steps are mirrored here) ----

export type T0 = Awaited<ReturnType<typeof compact>>;
export async function t0Of(messages: Message[], asker: JevAsker): Promise<T0> {
  const t0 = await compact(messages, asker, {});
  if (t0.stats.requests > 0 && t0.stats.failedRequests === t0.stats.requests) throw new Error('every Jev request failed in T0');
  return t0;
}
export async function trimOf(messages: Message[], t0: T0, asker: JevAsker, o: { threshold: number; windowTokens?: number; staleOnly?: boolean }) {
  const options = { ...DEFAULT_OPTIONS, goal: goalFromMessages(messages), proseKeepThreshold: o.threshold, ...(o.windowTokens !== undefined ? { windowTokens: o.windowTokens } : {}) };
  let actions = callActions(messages, t0.decisions, options.preserveRecentMessages);
  if (o.staleOnly) actions = new Map([...actions].filter(([, d]) => d.action === 'drop_result'));
  const r = await trimProse(t0.messages, actions, asker, options);
  if (r.stats.failed !== undefined) throw new Error(`trim failed: ${r.stats.failed.slice(0, 60)}`);
  return r;
}
/** S as shipped: T0 at or above the gate, else the built-in summary; with none, the original. */
export const sTextOf = (c: Case, messages: Message[], t0: T0): string =>
  reductionRatio(t0) >= MIN_REDUCTION ? renderMessages(t0.messages) : (c.builtinSummary ?? renderMessages(messages));

function flipOf(a: ProseDecision[], b: ProseDecision[]): { compared: number; flips: number } {
  const second = new Map(b.map((d) => [d.id, d]));
  let compared = 0;
  let flips = 0;
  for (const d of a) {
    const other = second.get(d.id);
    if (!other) continue;
    compared++;
    if (d.kept !== other.kept) flips++;
  }
  return { compared, flips };
}

// ---- Plan counts ----

function planLines(deps: Deps, split: SplitName, cmd: 'all' | 'questions' | 'b' | 'dev' | 'test'): string[] {
  const cs = deps.cases(split);
  const withQs = cs.filter((c) => questionsOf(deps, c).length > 0);
  const withB = cs.filter((c) => hasHeadlessB(deps, c));
  const nQ = (list: Case[]) => list.reduce((n, c) => n + questionsOf(deps, c).length, 0);
  const nJudge = (list: Case[]) => list.reduce((n, c) => n + questionsOf(deps, c).filter((q) => !tokenKind(q.category)).length, 0);
  const armsOf = (c: Case) => 4 + (c.builtinSummary !== undefined ? 1 : 0) + (hasHeadlessB(deps, c) ? 1 : 0);
  const testAnswers = withQs.reduce((n, c) => n + questionsOf(deps, c).length * armsOf(c), 0);
  const testJudge = withQs.reduce((n, c) => n + questionsOf(deps, c).filter((q) => !tokenKind(q.category)).length * armsOf(c), 0);
  const todoQ = cs.length - cs.filter((c) => loadQuestions(deps.cacheDir, c.id)).length;
  const lines: string[] = [];
  if (cmd === 'all') {
    lines.push(`split ${split}`, `cases under the cap: ${cs.length}`, `cases with cached questions: ${withQs.length}`, `cases with a headless B result: ${withB.length}`, 'live calls per command:');
  }
  if (cmd === 'all' || cmd === 'questions') lines.push(`  questions: ${todoQ} cases to do; claude -p calls: ${todoQ} question, ${15 * todoQ}-${25 * todoQ} answer, up to ${25 * todoQ} judge`);
  if (cmd === 'all' || cmd === 'b') lines.push(`  b: ${cs.length - withB.length} cases to do; headless /compact runs: ${cs.length - withB.length}`);
  if (cmd === 'all' || cmd === 'dev') lines.push(`  dev: ${withQs.length} cases; Jev runs for A: ${withQs.length} T0 + ${withQs.length * DEV_TRIM_RUNS} trim; claude -p calls: ${nQ(withQs) * DEV_SCORED_ARMS} answer, up to ${nJudge(withQs) * DEV_SCORED_ARMS} judge`);
  if (cmd === 'all' || cmd === 'test') lines.push(`  test: ${withQs.length} cases; Jev runs for A: ${withQs.length} T0 + ${withQs.length} trim; claude -p calls: ${testAnswers} answer, up to ${testJudge} judge`);
  return lines;
}

// ---- Commands ----

async function questionsCmd(deps: Deps, split: SplitName, k: number): Promise<number> {
  const todo = deps.cases(split).filter((c) => !loadQuestions(deps.cacheDir, c.id));
  planLines(deps, split, 'questions').forEach(deps.print);
  if (!(await deps.confirm(`Run these live claude -p calls for ${todo.length} cases?`))) return 1;
  const stats = makeStats();
  const gate = limiter(k * CALLS_PER_CASE);
  const failures = await mapLimit(todo, k, async (c) => {
    try {
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
      deps.print(`${c.id} kept ${kept.length} dropped ${dropped} invalid ${parsed.invalid}`);
      return 0;
    } catch (e) {
      deps.print(`${c.id} failed: ${errText(e)}`);
      return 1;
    }
  });
  const failed = failures.reduce((n: number, f) => n + f, 0);
  deps.print(`questions done: ${todo.length - failed} cached, ${failed} failed, ${stats.refusals} refused`);
  return failed > 0 ? 1 : 0;
}

async function bCmd(deps: Deps, split: SplitName): Promise<number> {
  const bDir = join(deps.outDir, 'b');
  const todo = deps.cases(split).filter((c) => !hasHeadlessB(deps, c));
  planLines(deps, split, 'b').forEach(deps.print);
  if (todo.length > 0 && !deps.hasKey()) {
    deps.print('TYPESAFE_API_KEY is not set');
    return 2;
  }
  if (!(await deps.confirm(`Run headless /compact on ${todo.length} cases (one confirm covers all)?`))) return 1;
  const file = join(deps.outDir, `b-batch-${split}.json`);
  const prior = readJson<{ results: { id: string; headless: boolean; evidence: string }[] }>(file)?.results ?? [];
  const results = new Map(prior.map((r) => [r.id, r]));
  for (const c of todo) {
    let rec: { id: string; headless: boolean; evidence: string };
    const bFile = join(bDir, `${c.id}.json`);
    const earlier = existsSync(bFile) ? readFileSync(bFile) : undefined;
    try {
      const r: 'refused' | BMode = await deps.runHeadless({ case: c, outDir: deps.outDir, confirm: async () => true, print: deps.print });
      rec = r === 'refused' ? { id: c.id, headless: false, evidence: 'refused' } : { id: c.id, headless: r.headless, evidence: r.evidence };
    } catch (e) {
      rec = { id: c.id, headless: false, evidence: `threw: ${errText(e)}` };
    }
    // A fork without the hook marker still leaves a b/<id>.json; it is not a tidy result, so it must not feed the B arm.
    // Put back what was there before the run (a hand result), or remove the file when there was none.
    if (!rec.headless) {
      if (earlier) writeFileSync(bFile, earlier);
      else rmSync(bFile, { force: true });
    }
    results.set(c.id, rec);
    writeJson(file, { split, results: [...results.values()] });
    deps.print(`${c.id} headless ${rec.headless}`);
  }
  const bad = todo.filter((c) => !results.get(c.id)?.headless).length;
  deps.print(`b done: ${todo.length - bad} headless, ${bad} not`);
  return 0;
}

/** Per-case resume cache under out/run-cache/<kind>/. A hit costs no call; its model ids still count. Each miss gets its own Stats, so parallel cases never mix model ids; refusals fold into the shared stats. */
function memoFor(deps: Deps, kind: string, stats: Stats, models: Set<string>) {
  const dir = join(deps.outDir, 'run-cache', kind);
  return async <T extends object>(key: string, fn: (own: Stats) => Promise<T>): Promise<T & { models: string[] }> => {
    const file = cacheFile(dir, key);
    let entry = readJson<T & { models: string[] }>(file);
    if (!entry) {
      const own = makeStats();
      let value: T;
      try {
        value = await fn(own);
      } finally {
        stats.refusals += own.refusals;
      }
      entry = { ...value, models: uniq(own.models) };
      writeJson(file, entry);
    }
    entry.models.forEach((m) => models.add(m));
    return entry;
  };
}

/** T0 once per case and process; an entry already cached never reaches it. */
const lazyT0 = (deps: Deps, asker: JevAsker) => {
  const held = new Map<string, T0>();
  return async (c: Case, messages: Message[]): Promise<T0> => {
    let t0 = held.get(c.id);
    if (!t0) held.set(c.id, (t0 = await t0Of(messages, asker)));
    return t0;
  };
};

async function devCmd(deps: Deps, k: number): Promise<number> {
  const ready = deps.cases('dev').filter((c) => questionsOf(deps, c).length > 0);
  planLines(deps, 'dev', 'all').forEach(deps.print);
  if (ready.length === 0) {
    deps.print('no dev case has cached questions; run questions --split dev first');
    return 1;
  }
  let asker: JevAsker;
  try {
    asker = deps.makeAsker();
  } catch (e) {
    deps.print(errText(e));
    return 2;
  }
  if (!(await deps.confirm(`Run these live Jev and claude -p calls on ${ready.length} dev cases?`))) return 1;
  const stats = makeStats();
  const models = new Set<string>();
  const memo = memoFor(deps, 'dev', stats, models);
  const t0Of_ = lazyT0(deps, asker);
  const gate = limiter(k * CALLS_PER_CASE);
  const rowsOf = async (c: Case, key: string, text: (messages: Message[], t0: T0) => Promise<string>) =>
    (await memo(key, async (own) => {
      const messages = deps.messages(c);
      return { rows: await scoreArm(await text(messages, await t0Of_(c, messages)), questionsOf(deps, c), own, deps, gate) };
    })).rows;
  const failedCases = new Set<string>();
  const guard = async <T>(c: Case, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      failedCases.add(c.id);
      deps.print(`${c.id} failed: ${errText(e)}`);
      return undefined;
    }
  };

  const S: Row[] = [];
  const A = new Map<number, Row[]>(THRESHOLDS.map((t) => [t, []]));
  const sweepRows = await mapLimit(ready, k, (c) => guard(c, async () => {
    const s = await rowsOf(c, `${c.id}.S`, async (m, t0) => sTextOf(c, m, t0));
    const as = new Map<number, Row[]>();
    for (const t of THRESHOLDS) {
      as.set(t, await rowsOf(c, `${c.id}.t${t}`, async (m, t0) => renderMessages((await trimOf(m, t0, asker, { threshold: t })).messages)));
    }
    return { s, as };
  }));
  for (const r of sweepRows) {
    if (!r) continue;
    S.push(...r.s);
    for (const [t, rows] of r.as) A.get(t)!.push(...rows);
  }
  if (failedCases.size > 0) {
    deps.print(`dev stopped: ${failedCases.size} cases failed; finished work is cached, rerun to resume`);
    return 1;
  }

  const sweep = THRESHOLDS.map((threshold) => {
    const rows = A.get(threshold)!;
    const v = buildReport({ A: rows.map(toScored), S: S.map(toScored) }).verdict;
    return { threshold, pass: v.default === 'trim', reason: v.reasons[0], metrics: metricsOf(rows), sRecall: metricsOf(S).recall };
  });
  const passing = sweep.filter((s) => s.pass).map((s) => s.threshold);
  const picked: number | 'none' = passing.length > 0 ? Math.max(...passing) : 'none';
  const chosen = picked === 'none' ? DEFAULT_THRESHOLD : picked;
  const common = { split: 'dev', cases: ready.map((c) => c.id), chosenThreshold: chosen };

  const big: Row[] = [];
  const small: Row[] = [];
  const stale: Row[] = [];
  const flips: { id: string; compared: number; flips: number }[] = [];
  const extras = await mapLimit(ready, k, (c) => guard(c, async () => {
    const w = await rowsOf(c, `${c.id}.t${chosen}.w${SMALL_WINDOW}`, async (m, t0) => renderMessages((await trimOf(m, t0, asker, { threshold: chosen, windowTokens: SMALL_WINDOW })).messages));
    const st = await rowsOf(c, `${c.id}.t${chosen}.stale`, async (m, t0) => renderMessages((await trimOf(m, t0, asker, { threshold: chosen, staleOnly: true })).messages));
    const f = await memo(`${c.id}.t${chosen}.flip`, async () => {
      const messages = deps.messages(c);
      const t0 = await t0Of_(c, messages);
      const first = await trimOf(messages, t0, asker, { threshold: chosen });
      const second = await trimOf(messages, t0, asker, { threshold: chosen });
      return flipOf(first.decisions, second.decisions);
    });
    return { c, w, st, f };
  }));
  for (const r of extras) {
    if (!r) continue;
    small.push(...r.w);
    stale.push(...r.st);
    big.push(...A.get(chosen)!.filter((row) => row.caseId === r.c.id));
    flips.push({ id: r.c.id, compared: r.f.compared, flips: r.f.flips });
  }
  if (failedCases.size > 0) {
    deps.print(`dev stopped: ${failedCases.size} cases failed; finished work is cached, rerun to resume`);
    return 1;
  }
  const modelIds = [...models];
  const meta = { ...common, models: modelIds, refusals: stats.refusals };
  writeJson(join(deps.outDir, 'dev-sweep.json'), { ...meta, picked, thresholds: sweep });
  writeJson(join(deps.outDir, 'dev-windows.json'), { ...meta, windows: { [SMALL_WINDOW]: metricsOf(small), 20000: metricsOf(big) } });
  const compared = flips.reduce((n, f) => n + f.compared, 0);
  const flipped = flips.reduce((n, f) => n + f.flips, 0);
  writeJson(join(deps.outDir, 'dev-flip.json'), { ...meta, compared, flips: flipped, rate: compared === 0 ? 0 : flipped / compared, perCase: flips });
  writeJson(join(deps.outDir, 'dev-stale.json'), { ...meta, informational: true, staleOnly: metricsOf(stale), allKept: metricsOf(big) });
  deps.print(`dev done: picked ${picked}, chosen ${chosen}, models ${modelIds.join(',')}`);
  return 0;
}

async function testCmd(deps: Deps, threshold: number, k: number): Promise<number> {
  const ready = deps.cases('test').filter((c) => questionsOf(deps, c).length > 0);
  planLines(deps, 'test', 'all').forEach(deps.print);
  let asker: JevAsker;
  try {
    asker = deps.makeAsker();
  } catch (e) {
    deps.print(errText(e));
    return 2;
  }
  if (!(await deps.confirm(`Run these live Jev and claude -p calls on ${ready.length} test cases at threshold ${threshold}?`))) return 1;
  const stats = makeStats();
  const models = new Set<string>();
  const memo = memoFor(deps, 'test', stats, models);
  const bDir = join(deps.outDir, 'b');
  const rows: Partial<Record<Arm, Row[]>> = {};
  const failedCases: string[] = [];
  let scored = 0;
  let handIgnored = 0;
  const gate = limiter(k * CALLS_PER_CASE);
  const entries = await mapLimit(ready, k, async (c) => {
    try {
      return await memo(`${c.id}.t${threshold}`, async (own) => {
        const messages = deps.messages(c);
        const t0 = await t0Of(messages, asker);
        const trimmed = await trimOf(messages, t0, asker, { threshold });
        const text: Partial<Record<Arm, string>> = { O: renderMessages(messages), T0: renderMessages(t0.messages), A: renderMessages(trimmed.messages), S: sTextOf(c, messages, t0) };
        if (c.builtinSummary !== undefined) text.BI = c.builtinSummary;
        const b = readB(bDir, c.id);
        if (b?.mode === 'headless') text.B = b.summary.join('\n');
        const qs = questionsOf(deps, c);
        const byArm: Partial<Record<Arm, Row[]>> = {};
        for (const arm of ARMS) if (text[arm] !== undefined) byArm[arm] = await scoreArm(text[arm] as string, qs, own, deps, gate);
        return { rows: byArm, handIgnored: b?.mode === 'hand' };
      });
    } catch (err) {
      deps.print(`${c.id} failed: ${errText(err)}`);
      return undefined;
    }
  });
  ready.forEach((c, i) => {
    const e = entries[i];
    if (!e) {
      failedCases.push(c.id);
      return;
    }
    scored++;
    if (e.handIgnored) handIgnored++;
    for (const arm of ARMS) if (e.rows[arm]) (rows[arm] ??= []).push(...(e.rows[arm] as Row[]));
  });
  const report = buildReport(Object.fromEntries(ARMS.filter((a) => rows[a]).map((a) => [a, (rows[a] as Row[]).map(toScored)])));
  const modelIds = [...models];
  const md =
    renderReport(report) +
    `\nmodel: ${modelIds.length > 0 ? modelIds.join(', ') : 'none'}\nscored test cases: ${scored}\nhand-mode B results ignored: ${handIgnored}\n` +
    (failedCases.length > 0 ? `failed test cases: ${failedCases.length}\n` : '');
  mkdirSync(deps.outDir, { recursive: true });
  writeFileSync(join(deps.outDir, 'report.md'), md);
  writeJson(join(deps.outDir, 'test.json'), {
    split: 'test', threshold, scoredCases: scored, ids: ready.filter((c) => !failedCases.includes(c.id)).map((c) => c.id),
    models: modelIds, refusals: stats.refusals, handBIgnored: handIgnored, failedCases, verdict: report.verdict, rows,
  });
  deps.print(`test done: ${scored} scored, ${failedCases.length} failed, verdict ${report.verdict.default}`);
  if (scored < MIN_TEST_CASES) deps.print(`fewer than ${MIN_TEST_CASES} scored test cases`);
  return scored < MIN_TEST_CASES || failedCases.length > 0 ? 1 : 0;
}

const USAGE = 'usage: run.ts plan --split dev|test | questions --split dev|test | b --split dev|test | dev | test --threshold <t>  [--cases <N>] [--concurrency <K>]';

export async function main(argv: string[], deps: Deps): Promise<number> {
  const [cmd] = argv;
  const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const posInt = (name: string): number | undefined => {
    const v = flag(name);
    return v === undefined ? undefined : /^[1-9]\d*$/.test(v) ? Number(v) : NaN;
  };
  const cases = posInt('--cases');
  const concurrency = posInt('--concurrency') ?? DEFAULT_CONCURRENCY;
  if (Number.isNaN(cases) || Number.isNaN(concurrency)) {
    deps.print(USAGE);
    return 2;
  }
  // --cases keeps the first N cases of a split, in the split's own (seeded) order.
  if (cases !== undefined) {
    const all = deps.cases;
    deps = { ...deps, cases: (name) => all(name).slice(0, cases) };
  }
  const splitArg = flag('--split');
  const split = splitArg === 'dev' || splitArg === 'test' ? splitArg : undefined;
  if ((cmd === 'plan' || cmd === 'questions' || cmd === 'b') && split) {
    if (cmd === 'plan') {
      planLines(deps, split, 'all').forEach(deps.print);
      return 0;
    }
    return cmd === 'questions' ? questionsCmd(deps, split, concurrency) : bCmd(deps, split);
  }
  if (cmd === 'dev') return devCmd(deps, concurrency);
  if (cmd === 'test') {
    const t = Number(flag('--threshold'));
    if (flag('--threshold') !== undefined && t > 0 && t <= 1) return testCmd(deps, t, concurrency);
  }
  deps.print(USAGE);
  return 2;
}

// ---- Live wiring (type-checked only by the tests; run by the CLI below) ----

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
    cases: (name) => load().split[name].filter((c) => c.estTokens < EVAL_CAP),
    messages: (c) => {
      // Keyed per transcript: cases of different transcripts run at the same time.
      let all = loaded.get(c.transcript);
      if (!all) {
        const file = load().manifest.files.find((f) => f.path === c.transcript);
        if (!file) throw new Error(`Case ${c.id}: transcript not in the manifest`);
        loaded.set(c.transcript, (all = loadTranscript(file).messages));
      }
      return all.slice(c.start, c.end);
    },
    makeAsker: () => {
      const key = process.env.TYPESAFE_API_KEY;
      if (!key) throw new Error('TYPESAFE_API_KEY is not set');
      return jevAsker(hookFetch, key, DEFAULT_MODEL);
    },
    hasKey: () => !!process.env.TYPESAFE_API_KEY,
    runHeadless,
    confirm: (q) => confirmFromStream(q),
    print: (m) => console.log(m),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), liveDeps());
}
