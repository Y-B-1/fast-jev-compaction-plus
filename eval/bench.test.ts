import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import type { JevAsker, JevQuestions, Message } from '../src/types.js';
import { benchVerdict, confirmFromStream, main, orderCandidates, orderForSelection, selectShortfalls, transcriptsUsed, type BenchRow, type Deps, type SavedT0 } from './bench.js';
import type { SpawnFn } from './claude.js';
import type { Case } from './load.js';
import { saveQuestions, type Question } from './questions.js';

const root = mkdtempSync(join(tmpdir(), 'fjev-bench-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** `reach` is the rung N reached (and the cut-off L reached unless `l` says otherwise). */
const row = (id: string, reach: BenchRow['rung'], pass: Partial<BenchRow['pass']> & Pick<BenchRow['pass'], 'O' | 'BI'>, questions = 10, l: BenchRow['cutoff'] = reach === 'all' ? 'none' : reach): BenchRow => ({
  id, t0Ratio: 0.1, lRatio: l === 'none' ? 0.1 : 0.4, nRatio: reach === 'none' ? 0.1 : 0.4, biRatio: 0.9, cutoff: l, rung: reach, questions, pass: { L: pass.BI, N: pass.BI, ...pass },
});

describe('orderCandidates', () => {
  it('puts cached cases first and keeps each group in order', () => {
    expect(orderCandidates(['a', 'b', 'c', 'd'], (x) => x === 'b' || x === 'd')).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('selectShortfalls', () => {
  const ratios: Record<string, number> = { a: 0.5, b: 0.1, c: 0.25, d: 0.0, e: 0.2, f: 0.1 };
  it('keeps cases strictly under 0.25 up to n, in order, and stops looking once it has them', async () => {
    const seen: string[] = [];
    const r = await selectShortfalls(['a', 'b', 'c', 'd', 'e', 'f'], 2, 2, async (c) => (seen.push(c), ratios[c]!));
    expect(r.picked).toEqual([{ c: 'b', t0Ratio: 0.1 }, { c: 'd', t0Ratio: 0 }]);
    expect(seen).toEqual(['a', 'b', 'c', 'd']);
    expect(r.examined).toBe(4);
  });
  it('counts a case whose T0 throws as failed and moves on', async () => {
    const r = await selectShortfalls(['a', 'b', 'e'], 5, 3, async (c) => {
      if (c === 'b') throw new Error('jev down');
      return ratios[c]!;
    });
    expect(r.picked.map((p) => p.c)).toEqual(['e']);
    expect(r.failed).toBe(1);
  });
});

describe('benchVerdict', () => {
  it('PASSes when pooled N recall is at least BI and half the cases reach', () => {
    const v = benchVerdict([row('a', 0.15, { O: 10, BI: 6, N: 6 }), row('b', 'none', { O: 10, BI: 5, N: 5 })]);
    expect(v).toMatchObject({ verdict: 'PASS', reached: 1, reachRate: 0.5, questions: 20 });
    expect(v.recall).toEqual({ O: 1, BI: 0.55, L: 0.55, N: 0.55 });
  });
  it('FAILs when pooled N recall is below BI even if every case reaches', () => {
    const v = benchVerdict([row('a', 0.05, { O: 10, BI: 8, N: 7 }), row('b', 0.35, { O: 10, BI: 8, N: 8 })]);
    expect(v.verdict).toBe('FAIL');
    expect(v.reasons).toEqual(['pooled N recall is below pooled BI recall']);
  });
  it('FAILs when fewer than half the cases reach even if N recall wins', () => {
    const v = benchVerdict([row('a', 0.15, { O: 10, BI: 5, N: 9 }), row('b', 'none', { O: 10, BI: 5, N: 5 }), row('c', 'none', { O: 10, BI: 5, N: 5 })]);
    expect(v.verdict).toBe('FAIL');
    expect(v.reasons).toEqual(['fewer than half the cases reached 0.25']);
  });
  it('counts a case as reached by the rung "all", which L has no cut-off for', () => {
    const v = benchVerdict([row('a', 'all', { O: 10, BI: 5, N: 8 }, 10, 'none'), row('b', 'none', { O: 10, BI: 5, N: 5 })]);
    expect(v).toMatchObject({ verdict: 'PASS', reached: 1, reachedL: 0 });
  });
  it('pools recall by question count, not by case', () => {
    const v = benchVerdict([row('a', 0.15, { O: 2, BI: 2, N: 0 }, 2), row('b', 0.15, { O: 18, BI: 10, N: 18 }, 18)]);
    expect(v.recall.N).toBe(0.9);
    expect(v.recall.BI).toBe(0.6);
    expect(v.verdict).toBe('PASS');
  });
  it('does not let arm L decide the verdict, and reports N/O retention', () => {
    const v = benchVerdict([row('a', 0.15, { O: 10, BI: 6, L: 0, N: 5 })]);
    expect(v.verdict).toBe('FAIL');
    const w = benchVerdict([row('a', 0.15, { O: 10, BI: 2, L: 0, N: 5 })]);
    expect(w.verdict).toBe('PASS');
    expect(w.retention).toBe(0.5);
  });
  it('FAILs with no rows', () => {
    expect(benchVerdict([]).verdict).toBe('FAIL');
  });
});

describe('per-transcript selection', () => {
  const ids = ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'c1'];
  const groupOf = (c: string) => c[0]!;
  it('keeps no transcript above the cap, skipping a full transcript without asking', async () => {
    const seen: string[] = [];
    const r = await selectShortfalls(ids, 10, 2, async (c) => (seen.push(c), 0.1), { perGroup: 2, groupOf });
    expect(r.picked.map((p) => p.c)).toEqual(['a1', 'a2', 'b1', 'b2', 'c1']);
    expect(r.capped).toBe(2);
    expect(seen).not.toContain('a4');
  });
  it('orders preferred transcripts in turns, cached first inside each, then the spare', () => {
    const cases = ['6d4b468e#1', '0602b6ea#1', '0602b6ea#2', '551e8c37#1', '551e8c37#2', '80c24e5f#1', 'zzzz#1'];
    const cached = (c: string) => c === '551e8c37#2';
    const g = (c: string) => c.split('#')[0]!;
    expect(orderForSelection(cases, g, cached)).toEqual(['551e8c37#2', '80c24e5f#1', '0602b6ea#1', '551e8c37#1', '0602b6ea#2', '6d4b468e#1', 'zzzz#1']);
  });
  it('falls back to cached-first when no preferred transcript is present', () => {
    expect(orderForSelection(['x#1', 'y#1', 'z#1'], (c) => c.split('#')[0]!, (c) => c === 'z#1')).toEqual(['z#1', 'x#1', 'y#1']);
  });
  it('prints the transcripts used with their counts', () => {
    expect(transcriptsUsed([{ id: '551e8c37-aaaa#1-2' }, { id: '551e8c37-aaaa#2-3' }, { id: '0602b6ea-bbbb#0-1' }])).toBe('551e8c37 (2), 0602b6ea (1)');
  });
});

describe('confirmFromStream', () => {
  const answer = async (text: string | null) => {
    const input = new PassThrough();
    const p = confirmFromStream('go?', input, new PassThrough());
    if (text === null) input.end();
    else input.end(text + '\n');
    return p;
  };
  it('is true only for y or yes, and false for n or a closed stream', async () => {
    expect(await answer('y')).toBe(true);
    expect(await answer('YES')).toBe(true);
    expect(await answer('n')).toBe(false);
    expect(await answer(null)).toBe(false);
  });
});

// ---- main, end to end on fakes ----

const FACT = 'flamingo-7';
const FLUFF = 'Let me have a good look at the layout of this module now.';
const history = (): Message[] => [
  { role: 'user', text: 'Fix the loader.', toolUses: [] },
  { role: 'assistant', text: `${Array(12).fill(FLUFF).join(' ')} We settled on ${FACT} for the loader.`, toolUses: [] },
  ...Array.from({ length: 8 }, (_, i): Message => ({ role: i % 2 ? 'assistant' : 'user', text: `tail ${i}`, toolUses: [] })),
];
const theCase = (id: string): Case => ({ id, transcript: 'x', start: 0, end: 1, chars: 0, estTokens: 1000, builtinSummary: 'A short summary.' });
const question = (caseId: string): Question => ({ id: `${caseId}:0`, caseId, question: 'What was settled on?', gold: FACT, evidence: FACT, category: 'id', tag: 'assistant-prose' });

/** Prose parts (`c<n>`) get `proseNoul`, notifications (`n<n>`) `notifNoul`; anything else 0.9 (keep). */
const asker = (proseNoul: number, notifNoul = 0.9): JevAsker => ({
  async ask(_state, questions: JevQuestions) {
    const noul = (k: string) => (/^c\d+$/.test(k) ? proseNoul : /^n\d+$/.test(k) ? notifNoul : 0.9);
    return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, noul: noul(k) }])) };
  },
});

/** A short history whose bulk is one finished-worker report; its head holds no fact. */
const notifHistory = (): Message[] => [
  { role: 'user', text: 'Fix the loader.', toolUses: [] },
  { role: 'assistant', text: `We settled on ${FACT} for the loader.`, toolUses: [] },
  {
    role: 'user',
    text: `<task-notification>\n<task-id>w1</task-id>\n<status>completed</status>\n<summary>Audit done</summary>\n<result>${'The worker read the module and found nothing of note. '.repeat(80)}</result>\n<usage><total_tokens>1</total_tokens></usage>\n</task-notification>`,
    toolUses: [],
  },
  ...Array.from({ length: 8 }, (_, i): Message => ({ role: i % 2 ? 'assistant' : 'user', text: `tail ${i}`, toolUses: [] })),
];

/** Answers FACT when the text holds it, else UNKNOWN. Every call is logged. */
function claude(calls: string[]): SpawnFn {
  return (_argv, { input }) => {
    calls.push(input);
    const text = input.split('QUESTION')[0]!.includes(FACT) ? FACT : 'UNKNOWN';
    return { status: 0, stdout: JSON.stringify({ result: text, modelUsage: { 'claude-sonnet-5-5': {} } }) };
  };
}

let n = 0;
function setup(proseNoul: number, ids: string[], cachedIds: string[], confirm: boolean, extra: { notifNoul?: number; messages?: () => Message[]; saved?: SavedT0 } = {}) {
  const base = join(root, `r${n++}`);
  const printed: string[] = [];
  const calls: string[] = [];
  const cacheDir = join(base, 'cache');
  for (const id of cachedIds) saveQuestions(cacheDir, id, [question(id)], { dropped: 0, model: 'claude-sonnet-5-5' });
  const deps: Deps = {
    outDir: join(base, 'out'),
    cacheDir,
    cases: () => ({ cases: ids.map(theCase), skipped: 3 }),
    messages: extra.messages ?? (() => history()),
    spawn: claude(calls),
    makeAsker: () => asker(proseNoul, extra.notifNoul),
    ...(extra.saved ? { savedT0: () => extra.saved } : {}),
    confirm: async () => confirm,
    print: (m) => printed.push(m),
  };
  return { deps, printed, calls, report: join(base, 'out', 'bench', 'report.md'), json: join(base, 'out', 'bench', 'bench.json') };
}

describe('main', () => {
  it('prints the plan with the skipped count and makes no claude -p call when declined', async () => {
    const s = setup(0.01, ['c1', 'c2'], ['c1'], false);
    expect(await main(['--cases', '2', '--arms', 'O,BI,L,N'], s.deps)).toBe(1);
    const plan = s.printed.join('\n');
    expect(plan).toContain('transcripts skipped (changed since the freeze): 3');
    expect(plan).toContain('selected cases: 2 (cached questions 1, to generate 1)');
    expect(plan).toContain('transcripts used (2): c1 (1), c2 (1)');
    expect(plan).toContain('6 scoring rounds');
    expect(plan).toContain('up to 84 answer and 40 judge (O, BI, L, N) over about 21 questions; arm N is 21 answer and 10 judge');
    expect(s.calls).toHaveLength(0);
    expect(existsSync(s.report)).toBe(false);
  });

  it('PASSes when the ladder reaches 0.25 and keeps the fact the built-in summary lost', async () => {
    const s = setup(0.01, ['c1'], ['c1'], true);
    expect(await main(['--cases', '1', '--arms', 'O,BI,L,N'], s.deps)).toBe(0);
    const out = JSON.parse(readFileSync(s.json, 'utf8'));
    expect(out.verdict).toBe('PASS');
    expect(out.rows[0]).toMatchObject({ id: 'c1', cutoff: 0.05, pass: { O: 1, BI: 0, L: 1 } });
    expect(out.rows[0].lRatio).toBeGreaterThanOrEqual(0.25);
    expect(readFileSync(s.report, 'utf8')).toContain('Verdict: **PASS**');
    expect(JSON.stringify(out)).not.toContain(FACT);
  });

  it('FAILs, with L equal to BI and no extra calls for L, when no cut-off reaches 0.25', async () => {
    const s = setup(0.9, ['c1'], ['c1'], true);
    expect(await main(['--cases', '1', '--arms', 'O,BI,L,N'], s.deps)).toBe(1);
    const out = JSON.parse(readFileSync(s.json, 'utf8'));
    expect(out.verdict).toBe('FAIL');
    expect(out.rows[0]).toMatchObject({ cutoff: 'none', pass: { O: 1, BI: 0, L: 0 } });
    expect(s.calls).toHaveLength(2);
  });

  it('generates and caches questions for an uncached case, dropping those the original cannot answer', async () => {
    const s = setup(0.01, ['c9'], [], true);
    const gen = JSON.stringify([
      { question: 'What was settled on?', gold: FACT, evidence: FACT, category: 'id', tag: 'assistant-prose' },
      { question: 'Which port?', gold: 'port-4', evidence: 'x', category: 'id', tag: 'assistant-prose' },
    ]);
    const spawn: SpawnFn = (argv, o) => (o.input.startsWith('Below is a coding-session history') ? { status: 0, stdout: JSON.stringify({ result: gen, modelUsage: { 'claude-sonnet-5-5': {} } }) } : claude(s.calls)(argv, o));
    s.deps.spawn = spawn;
    await main(['--cases', '1', '--arms', 'O,BI,L,N'], s.deps);
    const out = JSON.parse(readFileSync(s.json, 'utf8'));
    expect(out.rows[0].questions).toBe(1);
    expect(existsSync(join(s.deps.cacheDir, 'c9.json'))).toBe(true);
  });

  it('falls back to the built-in summary for arm N, with no calls for it, when no rung reaches 0.25', async () => {
    const s = setup(0.9, ['c1'], ['c1'], true);
    await main(['--cases', '1', '--arms', 'O,BI,L,N'], s.deps);
    const out = JSON.parse(readFileSync(s.json, 'utf8'));
    expect(out.rows[0]).toMatchObject({ rung: 'none', nRatio: out.rows[0].t0Ratio, pass: { N: 0, BI: 0 } });
    expect(out.reached).toBe(0);
    expect(out.verdict).toBe('FAIL');
  });

  it('PASSes on N when folding the worker report reaches 0.25 and keeps the fact the built-in summary lost, while L cannot', async () => {
    const s = setup(0.9, ['c1'], ['c1'], true, { notifNoul: 0.01, messages: notifHistory });
    expect(await main(['--cases', '1', '--arms', 'O,BI,L,N'], s.deps)).toBe(0);
    const out = JSON.parse(readFileSync(s.json, 'utf8'));
    expect(out.verdict).toBe('PASS');
    expect(out.rows[0]).toMatchObject({ cutoff: 'none', rung: 0.05, pass: { O: 1, BI: 0, L: 0, N: 1 } });
    expect(out.rows[0].nRatio).toBeGreaterThanOrEqual(0.25);
    expect(out.rows[0].foldChars).toBeGreaterThan(0);
    expect(out.rows[0].foldedChars / out.rows[0].notifChars).toBeGreaterThan(0.9);
    expect(out.rows[0].requests).toMatchObject({ t0: 0, notif: 1 });
    expect(out.rows[0].byCategory).toEqual({ id: { n: 1, pass: { O: 1, BI: 0, L: 0, N: 1 } } });
    expect(readFileSync(s.report, 'utf8')).toContain('Recall by question category');
  });
});

describe('--arms', () => {
  const run = async (args: string[], proseNoul = 0.01) => {
    const s = setup(proseNoul, ['c1'], ['c1'], true);
    const code = await main(['--cases', '1', ...args], s.deps);
    return { s, code, out: existsSync(s.json) ? JSON.parse(readFileSync(s.json, 'utf8')) : undefined };
  };
  it('by default answers only BI and N: no call for O or L, and the plan counts two arms', async () => {
    const { s, out } = await run([]);
    expect(s.calls).toHaveLength(2);
    expect(out.rows[0].pass).toEqual({ BI: 0, N: 1 });
    const decline = setup(0.01, ['c1', 'c2'], ['c1'], false);
    await main(['--cases', '2'], decline.deps);
    const plan = decline.printed.join('\n');
    expect(plan).toContain('up to 42 answer and 20 judge (BI, N) over about 21 questions');
    expect(plan).toContain('4 scoring rounds');
    expect(decline.calls).toHaveLength(0);
  });
  it('--arms O,BI,L,N restores all four arms', async () => {
    const { s, out } = await run(['--arms', 'O,BI,L,N']);
    expect(s.calls).toHaveLength(4);
    expect(out.rows[0].pass).toEqual({ O: 1, BI: 0, L: 1, N: 1 });
  });
  it('always adds BI and N, and rejects an unknown arm', async () => {
    const { s, out } = await run(['--arms', 'O']);
    expect(s.calls).toHaveLength(3);
    expect(out.rows[0].pass).toEqual({ O: 1, BI: 0, N: 1 });
    const bad = setup(0.01, ['c1'], ['c1'], true);
    expect(await main(['--cases', '1', '--arms', 'X,BI'], bad.deps)).toBe(2);
    expect(bad.calls).toHaveLength(0);
  });
  it('leaves the verdict unchanged against the four-arm run', async () => {
    for (const noul of [0.01, 0.9]) {
      const small = await run([], noul);
      const full = await run(['--arms', 'O,BI,L,N'], noul);
      expect(small.code).toBe(full.code);
      expect(small.out.verdict).toBe(full.out.verdict);
      expect(small.out.reasons).toEqual(full.out.reasons);
      expect(small.out.reached).toBe(full.out.reached);
      expect(small.out.recall.BI).toBe(full.out.recall.BI);
      expect(small.out.recall.N).toBe(full.out.recall.N);
    }
  });
  it('reports O recall as filtered when O did not run', async () => {
    const { s } = await run([]);
    expect(readFileSync(s.report, 'utf8')).toContain('O filtered');
    expect(s.printed.join('\n')).toContain('recall O filtered');
  });
  it('benchVerdict ignores a missing O and L', () => {
    const v = benchVerdict([{ ...row('a', 0.15, { O: 0, BI: 6, N: 6 }), pass: { BI: 6, N: 6 } }]);
    expect(v).toMatchObject({ verdict: 'PASS', reached: 1 });
    expect(v.recall.N).toBe(0.6);
    expect(v.recall.O).toBeNaN();
  });
});

describe('--dry-run', () => {
  const saved: SavedT0 = { decisions: [] };
  it('replays T0 from saved decisions, prints the rung and folded fraction per case, and makes no live call', async () => {
    const s = setup(0.9, ['c1', 'c2'], ['c1'], true, { notifNoul: 0.9, messages: notifHistory, saved });
    s.deps.makeAsker = () => {
      throw new Error('the dry run must not build the Jev asker');
    };
    let confirmed = 0;
    s.deps.confirm = async () => (confirmed++, true);
    expect(await main(['--cases', '2', '--dry-run'], s.deps)).toBe(0);
    const text = s.printed.join('\n');
    expect(s.calls).toHaveLength(0);
    expect(confirmed).toBe(0);
    expect(existsSync(s.report)).toBe(false);
    // The fake answers 0.1 for the notification: below the 0.15 rung, above the 0.05 rung.
    expect(text).toContain('c1: T0 0.0%; rung 0.15, N ');
    expect(text).toMatch(/folded 100\.0% of \d+ notification chars/);
    expect(text).toContain('N would reach 0.25 on 2/2 selected cases');
  });
  it('says selection needs live T0 for cases with no saved decisions, and still exits 0', async () => {
    const s = setup(0.9, ['c1'], [], true, { messages: notifHistory });
    expect(await main(['--cases', '1', '--dry-run'], s.deps)).toBe(0);
    expect(s.printed.join('\n')).toContain('cases with no saved T0 (selection needs live T0): 1');
    expect(s.calls).toHaveLength(0);
  });
});
