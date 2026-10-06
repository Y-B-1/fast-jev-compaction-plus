import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { JevAsker, JevQuestions, Message } from '../src/types.js';
import { buildArms, renderMessages } from './arms.js';
import type { BMode } from './b-runner.js';
import type { SpawnFn } from './claude.js';
import type { Case } from './load.js';
import { loadQuestions, saveQuestions, CATEGORIES, type Question } from './questions.js';
import { main, t0Of, trimOf, THRESHOLDS, type Deps } from './run.js';

// Each fake claude -p call makes a temp dir; the 24-case runs make a few thousand.
vi.setConfig({ testTimeout: 60_000 });
const root = mkdtempSync(join(tmpdir(), 'fjev-run-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirN = 0;
const fresh = (): { outDir: string; cacheDir: string } => {
  const d = join(root, `d${dirN++}`);
  return { outDir: join(d, 'out'), cacheDir: join(d, 'cache') };
};

const CANARY = 'CANARY-7f3a9c';
const MODEL = 'claude-sonnet-5-5';
const gold = (i: number): string => `flamingo${String.fromCharCode(97 + i)}`;

/** A goal, then old turns each stating one fact in a sentence (plus a Read call), then a short tail. Text carries the canary. */
function history(n = 20): Message[] {
  const out: Message[] = [{ role: 'user', text: `Fix the loader. ${CANARY}`, toolUses: [] }];
  for (let i = 0; i < n; i++) {
    out.push(
      { role: 'assistant', text: `In the review we settled on ${gold(i)} for the loader. ${CANARY}`, toolUses: [{ tool_use_id: `t${i}`, tool: 'Read', input: { file_path: `/x/f${i}.ts` } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text: 'x'.repeat(3000) }] },
    );
  }
  for (let i = 0; i < 6; i++) out.push({ role: i % 2 ? 'assistant' : 'user', text: `tail ${i}`, toolUses: [] });
  return out;
}
const theCase = (i: number, builtin = 'BUILTIN SUMMARY'): Case => ({ id: `case${i}#0-1`, transcript: 'x', start: 0, end: 1, chars: 0, estTokens: 1000, builtinSummary: builtin });

/** Half the questions carry a prose tag, half an input tag (the fake answerer reads only the arm text). */
function questions(c: Case, n = 20): Question[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${c.id}:${i}`, caseId: c.id, question: `What did we settle on for item ${i}?`, gold: gold(i), evidence: 'x',
    category: CATEGORIES[i % 2 === 0 ? 4 : 0], tag: i % 2 === 0 ? 'assistant-prose' : 'code-body', ...(i % 2 === 0 ? {} : { field: 'Write.content' }),
  } as Question));
}
const cache = (d: { cacheDir: string }, cs: Case[], n = 20) => cs.forEach((c) => saveQuestions(d.cacheDir, c.id, questions(c, n), { dropped: 0, model: MODEL }));

interface Fakes {
  deps: Deps;
  spawnCalls: () => number;
  askerCalls: () => number;
  headlessCalls: () => number;
  confirms: () => number;
  printed: string[];
}
/** Fake claude -p: writes questions, answers with the gold when the arm text holds it, judges by containment. Fake Jev: noul by marker. */
function fakes(d: { outDir: string; cacheDir: string }, cs: Case[], o: { lowNoul?: (text: string) => number; allow?: boolean; failSpawnAfter?: number; headless?: Deps['runHeadless'] } = {}): Fakes {
  let spawns = 0;
  let asks = 0;
  let headless = 0;
  let confirms = 0;
  const printed: string[] = [];
  const spawn: SpawnFn = (_argv, { input }) => {
    spawns++;
    if (o.failSpawnAfter !== undefined && spawns > o.failSpawnAfter) return { status: 1, stdout: '' };
    let result: string;
    if (input.startsWith('Below is a coding-session history')) {
      result = JSON.stringify(questions(cs[0]!).map((q) => ({ question: q.question, gold: q.gold, evidence: q.evidence, category: q.category, tag: q.tag })));
    } else if (input.startsWith('Answer the question')) {
      const text = input.split('\n\nTEXT\n')[1]!.split('\n\nQUESTION\n')[0]!;
      const q = input.split('\n\nQUESTION\n')[1]!;
      const g = gold(Number(/item (\d+)/.exec(q)![1]));
      result = text.includes(g) ? `${g} ${CANARY}` : 'UNKNOWN';
    } else {
      const g = input.split('GOLD\n')[1]!.split('\n\nANSWER\n')[0]!;
      result = input.split('\n\nANSWER\n')[1]!.includes(g) ? 'CORRECT' : 'INCORRECT';
    }
    return { status: 0, stdout: JSON.stringify({ result, modelUsage: { [MODEL]: {} } }) };
  };
  const noul = o.lowNoul ?? (() => 0.9);
  const asker: JevAsker = {
    async ask(state, questions: JevQuestions) {
      asks++;
      const texts = new Map<string, string>();
      const walk = (n: unknown): void => {
        if (n && typeof n === 'object') for (const [k, v] of Object.entries(n)) typeof v === 'string' && /^c\d+$/.test(k) ? texts.set(k, v) : walk(v);
      };
      walk(state);
      return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, noul: /^c\d+$/.test(k) ? noul(texts.get(k) ?? '') : 0.9 }])) };
    },
  };
  const deps: Deps = {
    ...d,
    cases: () => cs,
    messages: () => history(),
    spawn,
    makeAsker: () => asker,
    hasKey: () => true,
    runHeadless: o.headless ?? (async () => { headless++; return { headless: true, evidence: 'ok', forkPath: 'f' } satisfies BMode; }),
    confirm: async () => { confirms++; return o.allow ?? true; },
    print: (m) => printed.push(m),
  };
  if (o.headless) { const inner = o.headless; deps.runHeadless = async (x) => { headless++; return inner(x); }; }
  return { deps, spawnCalls: () => spawns, askerCalls: () => asks, headlessCalls: () => headless, confirms: () => confirms, printed };
}
const writeB = (d: { outDir: string }, c: Case, mode: 'headless' | 'hand') => {
  mkdirSync(join(d.outDir, 'b'), { recursive: true });
  writeFileSync(join(d.outDir, 'b', `${c.id}.json`), JSON.stringify({ caseId: c.id, mode, summary: ['summary line'], keptMessages: 4 }));
};
const many = (n: number) => Array.from({ length: n }, (_, i) => theCase(i));
const rd = (d: { outDir: string }, f: string) => readFileSync(join(d.outDir, f), 'utf8');

describe('run test', () => {
  it('writes the report with six arms, per-tag recall, verdict, model and count; no planted text leaks', async () => {
    const d = fresh();
    const cs = many(24);
    cache(d, cs, 4);
    cs.forEach((c) => writeB(d, c, 'headless'));
    const f = fakes(d, cs);
    expect(renderMessages(history())).toContain(CANARY);
    expect(await main(['test', '--threshold', '0.15'], f.deps)).toBe(0);
    const md = rd(d, 'report.md');
    for (const arm of ['O', 'T0', 'BI', 'S', 'A', 'B']) expect(md).toMatch(new RegExp(`^\\| ${arm} \\| \\d+ \\|`, 'm'));
    expect(md).toContain('Recall by tag');
    expect(md).toContain('assistant-prose');
    expect(md).toMatch(/^Verdict: /m);
    expect(md).toContain(`model: ${MODEL}`);
    expect(md).toContain('scored test cases: 24');
    const json = JSON.parse(rd(d, 'test.json'));
    expect(json.models).toEqual([MODEL]);
    expect(json.rows.O[0]).toEqual({ id: 'case0#0-1:0', caseId: 'case0#0-1', category: 'error', tag: 'assistant-prose', outcome: 'pass' });
    for (const text of [md, rd(d, 'test.json'), ...readdirSync(join(d.outDir, 'run-cache', 'test')).map((n) => readFileSync(join(d.outDir, 'run-cache', 'test', n), 'utf8'))]) {
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain('flamingo');
      expect(text).not.toContain('settled');
    }
  });

  it('exits 1 below 24 scored test cases and still writes the report', async () => {
    const d = fresh();
    const cs = many(3);
    cache(d, cs);
    const f = fakes(d, cs);
    expect(await main(['test', '--threshold', '0.15'], f.deps)).toBe(1);
    expect(rd(d, 'report.md')).toContain('scored test cases: 3');
  });

  it('ignores a hand B result for the B arm and counts it', async () => {
    const d = fresh();
    const cs = many(24);
    cache(d, cs, 4);
    cs.forEach((c) => writeB(d, c, 'headless'));
    writeB(d, cs[5]!, 'hand');
    const f = fakes(d, cs);
    await main(['test', '--threshold', '0.15'], f.deps);
    expect(rd(d, 'report.md')).toContain('hand-mode B results ignored: 1');
    const json = JSON.parse(rd(d, 'test.json'));
    expect(json.rows.B).toHaveLength(23 * 4);
    expect(json.rows.B.some((r: { caseId: string }) => r.caseId === cs[5]!.id)).toBe(false);
  });

  it('A at the default threshold equals buildArms A (arms.ts takes no threshold, so run.ts mirrors it)', async () => {
    const d = fresh();
    const c = theCase(0);
    const f = fakes(d, [c], { lowNoul: (t) => (t.includes('flamingoc') ? 0.1 : 0.9) });
    const asker = f.deps.makeAsker();
    const bDir = join(d.outDir, 'b');
    mkdirSync(bDir, { recursive: true });
    const viaBuild = await buildArms(c, history(), { asker }, bDir);
    const t0 = await t0Of(history(), asker);
    const mine = await trimOf(history(), t0, asker, { threshold: 0.15 });
    expect(renderMessages(mine.messages)).toBe(viaBuild.text.A);
    expect(viaBuild.text.A).not.toContain('flamingoc');
    expect(renderMessages((await trimOf(history(), t0, asker, { threshold: 0.05 })).messages)).toContain('flamingoc');
  });
});

describe('run confirm and resume', () => {
  it('a refused confirm makes no live call in questions, b, dev and test', async () => {
    for (const argv of [['questions', '--split', 'test'], ['b', '--split', 'test'], ['dev'], ['test', '--threshold', '0.15']]) {
      const d = fresh();
      const cs = many(3);
      cache(d, cs);
      const f = fakes(d, cs, { allow: false });
      expect(await main(argv, f.deps)).toBe(1);
      expect([argv[0], f.confirms(), f.spawnCalls(), f.askerCalls(), f.headlessCalls()]).toEqual([argv[0], 1, 0, 0, 0]);
    }
  });

  it('plan prints counts and makes no call', async () => {
    const d = fresh();
    const cs = many(4);
    cache(d, cs.slice(0, 2));
    writeB(d, cs[0]!, 'headless');
    const f = fakes(d, cs);
    expect(await main(['plan', '--split', 'test'], f.deps)).toBe(0);
    const out = f.printed.join('\n');
    expect(out).toContain('cases under the cap: 4');
    expect(out).toContain('cases with cached questions: 2');
    expect(out).toContain('cases with a headless B result: 1');
    expect([f.spawnCalls(), f.askerCalls(), f.headlessCalls(), f.confirms()]).toEqual([0, 0, 0, 0]);
  });

  it('resumes test after a crash without repeating finished cases', async () => {
    const d = fresh();
    const cs = many(6);
    cache(d, cs, 4);
    const clean = fakes(fresh(), cs);
    cache(clean.deps, cs, 4);
    await main(['test', '--threshold', '0.15'], clean.deps);
    const perCase = clean.spawnCalls() / 6;
    const crash = fakes(d, cs, { failSpawnAfter: Math.floor(perCase * 3.5) });
    expect(await main(['test', '--threshold', '0.15'], crash.deps)).toBe(1);
    const finished = readdirSync(join(d.outDir, 'run-cache', 'test')).length;
    expect(finished).toBe(3);
    const again = fakes(d, cs);
    await main(['test', '--threshold', '0.15'], again.deps);
    expect(again.spawnCalls()).toBe(perCase * (6 - finished));
    expect(again.askerCalls()).toBe((clean.askerCalls() / 6) * (6 - finished));
    expect(rd(d, 'report.md')).toContain('scored test cases: 6');
  });

  it('resumes questions without repeating cached cases', async () => {
    const d = fresh();
    const cs = many(3);
    saveQuestions(d.cacheDir, cs[0]!.id, questions(cs[0]!), { dropped: 0, model: MODEL });
    const f = fakes(d, cs);
    expect(await main(['questions', '--split', 'test'], f.deps)).toBe(0);
    expect(f.spawnCalls()).toBe(2 * (1 + 20 + 10));
    expect(loadQuestions(d.cacheDir, cs[2]!.id)?.questions).toHaveLength(20);
    expect(loadQuestions(d.cacheDir, cs[2]!.id)?.model).toBe(MODEL);
  });
});

describe('run b', () => {
  it('asks one confirm for N cases, records a throwing case and a non-headless case, and runs the rest', async () => {
    const d = fresh();
    const cs = many(4);
    const f = fakes(d, cs, {
      headless: async ({ case: c }) => {
        const id = (c as Case).id;
        if (id === cs[1]!.id) throw new Error('boom');
        if (id === cs[2]!.id) { writeB(d, cs[2]!, 'headless'); return { headless: false, evidence: 'no hook marker', forkPath: 'f' }; }
        writeB(d, c as Case, 'headless');
        return { headless: true, evidence: 'marker and boundary', forkPath: 'f' };
      },
    });
    expect(await main(['b', '--split', 'test'], f.deps)).toBe(0);
    expect([f.confirms(), f.headlessCalls()]).toEqual([1, 4]);
    expect(f.printed.join('\n')).toContain('4 cases');
    const batch = JSON.parse(rd(d, 'b-batch-test.json'));
    expect(batch.results.map((r: { id: string; headless: boolean }) => [r.id, r.headless])).toEqual([[cs[0]!.id, true], [cs[1]!.id, false], [cs[2]!.id, false], [cs[3]!.id, true]]);
    expect(batch.results[1].evidence).toContain('boom');
    expect(Object.keys(batch.results[0]).sort()).toEqual(['evidence', 'headless', 'id']);
    expect(existsSync(join(d.outDir, 'b', `${cs[2]!.id}.json`))).toBe(false);
    expect(existsSync(join(d.outDir, 'b', `${cs[3]!.id}.json`))).toBe(true);
  });
});

describe('run dev', () => {
  /** Two facts score 0.2, so the 0.25 and 0.35 thresholds drop them (recall 0.90 < 0.95); 0.05 to 0.15 keep all. */
  it('picks the highest threshold that meets the bar and writes the four dev files', async () => {
    const d = fresh();
    const cs = many(2);
    cache(d, cs);
    const f = fakes(d, cs, { lowNoul: (t) => (t.includes('flamingoc') || t.includes('flamingod') ? 0.2 : 0.9) });
    expect(await main(['dev'], f.deps)).toBe(0);
    expect(f.confirms()).toBe(1);
    const sweep = JSON.parse(rd(d, 'dev-sweep.json'));
    expect(sweep.thresholds.map((t: { threshold: number; pass: boolean }) => [t.threshold, t.pass])).toEqual(THRESHOLDS.map((t) => [t, t <= 0.15]));
    expect(sweep.picked).toBe(0.15);
    for (const file of ['dev-sweep.json', 'dev-windows.json', 'dev-flip.json', 'dev-stale.json']) {
      const j = JSON.parse(rd(d, file));
      expect(j.models).toEqual([MODEL]);
      expect(j.chosenThreshold).toBe(0.15);
      expect(rd(d, file)).not.toContain('flamingo');
      expect(rd(d, file)).not.toContain(CANARY);
    }
    expect(JSON.parse(rd(d, 'dev-windows.json')).windows['5000'].total).toBe(40);
    expect(JSON.parse(rd(d, 'dev-flip.json')).compared).toBeGreaterThan(0);
  });

  it('records none when no threshold meets the bar, and runs the extras at 0.15', async () => {
    const d = fresh();
    const cs = many(2);
    cache(d, cs);
    const f = fakes(d, cs, { lowNoul: () => 0.02 });
    expect(await main(['dev'], f.deps)).toBe(0);
    const sweep = JSON.parse(rd(d, 'dev-sweep.json'));
    expect(sweep.picked).toBe('none');
    expect(sweep.chosenThreshold).toBe(0.15);
    expect(sweep.thresholds.every((t: { pass: boolean }) => !t.pass)).toBe(true);
    expect(existsSync(join(d.outDir, 'dev-stale.json'))).toBe(true);
  });
});
