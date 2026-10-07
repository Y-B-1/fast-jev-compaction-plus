import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { HookFetch } from '../hooks/fast-jev.js';
import { estimateTokens } from '../src/state.js';
import type { Message } from '../src/types.js';
import type { SpawnFn } from './claude.js';
import { main, type Deps } from './compare.js';
import type { Case } from './load.js';
import { saveQuestions, type Question } from './questions.js';

vi.setConfig({ testTimeout: 60_000 });
const root = mkdtempSync(join(tmpdir(), 'fjev-compare-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirN = 0;
const fresh = () => {
  const d = join(root, `d${dirN++}`);
  return { outDir: join(d, 'out'), cacheDir: join(d, 'cache') };
};

const CANARY = 'CANARY-7f3a9c';
const MODEL = 'claude-sonnet-5-5';
const JEV_KEY = 'jev-canary-key-1111';
const OAI_KEY = 'sk-canary-key-2222';
const JEV_TOKENS = 1000;
const OAI_TOKENS = 400;
const gold = (i: number): string => `flamingo${String.fromCharCode(97 + i)}`;

/** A goal, then old turns each stating one fact (plus a Read call), then a short tail. Everything carries the canary. */
function history(n = 20): Message[] {
  const out: Message[] = [{ role: 'user', text: `Fix the loader. ${CANARY}`, toolUses: [] }];
  for (let i = 0; i < n; i++) {
    out.push(
      { role: 'assistant', text: `In the review we settled on ${gold(i)} for the loader. ${CANARY}`, toolUses: [{ tool_use_id: `t${i}`, tool: 'Read', input: { file_path: `/x/f${i}.ts` } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text: `${CANARY} ${'x'.repeat(3000)}` }] },
    );
  }
  for (let i = 0; i < 6; i++) out.push({ role: i % 2 ? 'assistant' : 'user', text: `tail ${i} ${CANARY}`, toolUses: [] });
  return out;
}
const theCase = (i: number): Case => ({ id: `case${i}#0-1`, transcript: 'x', start: 0, end: 1, chars: 0, estTokens: 1000 });
const questions = (c: Case, n = 4): Question[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${c.id}:${i}`, caseId: c.id, question: `What did we settle on for item ${i}?`, gold: gold(i), evidence: 'x',
    category: i % 2 === 0 ? 'path' : 'decision', tag: 'assistant-prose',
  } as Question));

interface Fakes {
  deps: Deps;
  jevBodies: string[];
  openaiBodies: string[];
  spawns: () => number;
  confirms: () => number;
  printed: string[];
}
/** Fake Jev drops everything (noul 0.01); fake OpenAI keeps the calls and results of t1..t3 and drops the rest. Both report usage. */
function fakes(d: { outDir: string; cacheDir: string }, cs: Case[], o: { allow?: boolean; env?: Deps['env']; openaiUsage?: boolean } = {}): Fakes {
  const jevBodies: string[] = [];
  const openaiBodies: string[] = [];
  const printed: string[] = [];
  let spawns = 0;
  let confirms = 0;
  const jevFetch: HookFetch = async (_url, init) => {
    jevBodies.push(init!.body!);
    const names = Object.keys(JSON.parse(init!.body!).questions);
    const text = JSON.stringify({ answers: Object.fromEntries(names.map((n) => [n, { type: 'noul', noul: 0.01 }])), usage: { input_tokens: JEV_TOKENS, output_tokens: 3 } });
    return { status: 200, ok: true, text };
  };
  const openaiFetch: HookFetch = async (_url, init) => {
    openaiBodies.push(init!.body!);
    const qs = JSON.parse(init!.body!).questions as { name: string }[];
    const answers = qs.map((q) => ({ type: 'predicate', name: q.name, probability: /_t[123]$/.test(q.name) ? 0.9 : 0.01 }));
    return { status: 200, ok: true, text: JSON.stringify({ answers, ...(o.openaiUsage === false ? {} : { usage: { input_tokens: OAI_TOKENS } }) }) };
  };
  const spawn: SpawnFn = async (_argv, { input }) => {
    spawns++;
    let result: string;
    if (input.startsWith('Answer the question')) {
      const text = input.split('\n\nTEXT\n')[1]!.split('\n\nQUESTION\n')[0]!;
      const g = gold(Number(/item (\d+)/.exec(input.split('\n\nQUESTION\n')[1]!)![1]));
      result = text.includes(g) ? g : 'UNKNOWN';
    } else {
      const g = input.split('GOLD\n')[1]!.split('\n\nANSWER\n')[0]!;
      result = input.split('\n\nANSWER\n')[1]!.includes(g) ? 'CORRECT' : 'INCORRECT';
    }
    return { status: 0, stdout: JSON.stringify({ result, modelUsage: { [MODEL]: {} } }) };
  };
  const deps: Deps = {
    ...d, cases: () => cs, messages: () => history(), spawn, jevFetch, openaiFetch,
    env: o.env ?? { TYPESAFE_API_KEY: JEV_KEY, OPENAI_API_KEY: OAI_KEY },
    confirm: async () => { confirms++; return o.allow ?? true; },
    print: (m) => printed.push(m),
  };
  return { deps, jevBodies, openaiBodies, spawns: () => spawns, confirms: () => confirms, printed };
}
const cache = (d: { cacheDir: string }, cs: Case[]) => cs.forEach((c) => saveQuestions(d.cacheDir, c.id, questions(c), { dropped: 0, model: MODEL }));
const out = (d: { outDir: string }, f: string) => readFileSync(join(d.outDir, 'compare', f), 'utf8');
const jsonl = (text: string) => text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>);
const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? filesUnder(join(dir, n)) : [join(dir, n)]));
const ARGS = ['--split', 'dev', '--cases', '2'];

describe('compare', () => {
  it('logs every request, one row per case and decider, and the side-by-side report; reported and estimated tokens and their difference are right', async () => {
    const d = fresh();
    const cs = [theCase(0), theCase(1), theCase(2)];
    cache(d, cs);
    const f = fakes(d, cs);
    expect(await main(ARGS, f.deps)).toBe(0);

    const reqs = jsonl(out(d, 'requests.jsonl'));
    const jev = reqs.filter((r) => r.decider === 'jev');
    const oai = reqs.filter((r) => r.decider === 'openai');
    // --cases 2: the first two cases only; every fake fetch is one request row.
    expect(new Set(reqs.map((r) => r.caseId))).toEqual(new Set([cs[0]!.id, cs[1]!.id]));
    expect(jev).toHaveLength(f.jevBodies.length);
    expect(oai).toHaveLength(f.openaiBodies.length);
    expect(jev.every((r) => r.inputReported === JEV_TOKENS && r.status === 200 && r.error === null && r.questions > 0 && r.ms >= 0)).toBe(true);
    expect(oai.every((r) => r.inputReported === OAI_TOKENS && r.outputReported === null)).toBe(true);
    expect(jev.reduce((n, r) => n + r.inputEstimated, 0)).toBe(f.jevBodies.reduce((n, b) => n + estimateTokens(b), 0));
    expect(oai.reduce((n, r) => n + r.inputEstimated, 0)).toBe(f.openaiBodies.reduce((n, b) => n + estimateTokens(b), 0));

    const rows = jsonl(out(d, 'cases.jsonl'));
    expect(rows).toHaveLength(4);
    const first = (decider: string) => rows.find((r) => r.caseId === cs[0]!.id && r.decider === decider)!;
    const j = first('jev');
    const o = first('openai');
    const perCase = (decider: string) => reqs.filter((r) => r.caseId === cs[0]!.id && r.decider === decider).length;
    expect(j.inputReported).toBe(JEV_TOKENS * perCase('jev'));
    expect(o.inputReported).toBe(OAI_TOKENS * perCase('openai'));
    expect(j.requests).toBe(perCase('jev'));
    expect(j.contextAfter).toBeLessThan(j.contextBefore);
    expect(j.contextBefore).toBe(o.contextBefore);
    expect(j.kept).toBe(0);
    expect(o.kept).toBe(3);
    // Unpinned calls: those Jev decided on. OpenAI differs on exactly the three it kept.
    const items = j.kept + j.dropped + j.trimmed;
    expect(items).toBeGreaterThan(3);
    expect(j.agreement).toBeCloseTo((items - 3) / items, 10);
    expect(o.agreement).toBe(j.agreement);
    expect(j.recall.overall).toEqual({ pass: 4, total: 4 });
    expect(o.costUsd).toBeCloseTo((OAI_TOKENS * perCase('openai') / 1e6) * 0.1, 12);
    expect(j.costUsd).toBeNull();

    const md = out(d, 'report.md');
    const diffTokens = (OAI_TOKENS * perCase('openai')) - (JEV_TOKENS * perCase('jev'));
    const pct = (diffTokens / (JEV_TOKENS * perCase('jev'))) * 100;
    const fmt = (n: number, dp: number) => n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    const line = `| Input tokens, reported by the API | ${fmt(JEV_TOKENS * perCase('jev'), 0)} | ${fmt(OAI_TOKENS * perCase('openai'), 0)} | ${fmt(diffTokens, 0)} (${fmt(pct, 1)}%) |`;
    expect(md).toContain(line);
    expect(md).toContain('## Totals');
    expect(md).toContain(`## ${cs[0]!.id}`);
    expect(md).toContain(`## ${cs[1]!.id}`);
    expect(md).not.toContain(cs[2]!.id);
    expect(md).toContain('Jev cost is n/a');
    expect(md).toMatch(/\| Cost USD \| n\/a \|/);
  });

  it('reports n/a for reported tokens when the API reports none, and costs OpenAI from the estimate', async () => {
    const d = fresh();
    const cs = [theCase(0)];
    cache(d, cs);
    const f = fakes(d, cs, { openaiUsage: false });
    expect(await main(['--split', 'dev'], f.deps)).toBe(0);
    const o = jsonl(out(d, 'cases.jsonl')).find((r) => r.decider === 'openai')!;
    expect(o.inputReported).toBeNull();
    expect(o.costBasis).toBe('estimated');
    expect(o.costUsd).toBeCloseTo((o.inputEstimated / 1e6) * 0.1, 12);
    expect(jsonl(out(d, 'requests.jsonl')).filter((r) => r.decider === 'openai').every((r) => r.inputReported === null)).toBe(true);
    expect(out(d, 'report.md')).toMatch(/\| Input tokens, reported by the API \| [\d,]+ \| n\/a \| n\/a \|/);
  });

  it('writes no transcript text and no key to any output, cache or printed line', async () => {
    const d = fresh();
    const cs = [theCase(0), theCase(1)];
    cache(d, cs);
    const f = fakes(d, cs);
    expect(await main(['--split', 'dev'], f.deps)).toBe(0);
    expect(f.jevBodies.join('')).toContain(CANARY);
    const files = filesUnder(join(d.outDir, 'compare'));
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const secret of [CANARY, 'flamingo', JEV_KEY, OAI_KEY, 'What did we settle']) expect(`${file} ${text.includes(secret)}`).toBe(`${file} false`);
    }
    expect(f.printed.join('\n')).not.toContain(CANARY);
  });

  it('prints the planned counts and asks once; a refusal makes zero asker and zero claude calls', async () => {
    const d = fresh();
    const cs = [theCase(0), theCase(1)];
    cache(d, cs);
    const f = fakes(d, cs, { allow: false });
    expect(await main(['--split', 'dev'], f.deps)).toBe(1);
    expect(f.confirms()).toBe(1);
    expect(f.jevBodies).toHaveLength(0);
    expect(f.openaiBodies).toHaveLength(0);
    expect(f.spawns()).toBe(0);
    const plan = f.printed.join('\n');
    expect(plan).toContain('2 cases');
    expect(plan).toMatch(/expected asker calls: jev (\d+), openai \1;/);
    expect(plan).toContain('claude -p calls: 16 answer, up to 8 judge');
  });

  it('the printed asker count equals the calls the run then makes', async () => {
    const d = fresh();
    const cs = [theCase(0), theCase(1)];
    cache(d, cs);
    const f = fakes(d, cs);
    await main(['--split', 'dev'], f.deps);
    const [, jevN, oaiN] = /expected asker calls: jev (\d+), openai (\d+)/.exec(f.printed.join('\n'))!;
    expect(f.jevBodies).toHaveLength(Number(jevN));
    expect(f.openaiBodies).toHaveLength(Number(oaiN));
    expect(f.spawns()).toBeGreaterThanOrEqual(16);
  });

  it.each([
    ['OPENAI_API_KEY', { TYPESAFE_API_KEY: JEV_KEY }],
    ['TYPESAFE_API_KEY', { OPENAI_API_KEY: OAI_KEY }],
  ])('exits 2 before any call when %s is unset, and names it', async (name, env) => {
    const d = fresh();
    const cs = [theCase(0)];
    cache(d, cs);
    const f = fakes(d, cs, { env });
    expect(await main(['--split', 'dev'], f.deps)).toBe(2);
    expect(f.printed.join('\n')).toContain(name);
    expect(f.confirms()).toBe(0);
    expect(f.jevBodies.length + f.openaiBodies.length + f.spawns()).toBe(0);
  });

  it('a second run with a full cache makes zero calls and writes the same files', async () => {
    const d = fresh();
    const cs = [theCase(0), theCase(1)];
    cache(d, cs);
    const first = fakes(d, cs);
    expect(await main(['--split', 'dev'], first.deps)).toBe(0);
    const report = out(d, 'report.md');
    const second = fakes(d, cs);
    expect(await main(['--split', 'dev'], second.deps)).toBe(0);
    expect(second.jevBodies.length + second.openaiBodies.length + second.spawns() + second.confirms()).toBe(0);
    expect(out(d, 'report.md')).toBe(report);
    expect(jsonl(out(d, 'requests.jsonl')).length).toBe(first.jevBodies.length + first.openaiBodies.length);
  });

  it('a decider that fails every request fails its case, is not cached, and the key never reaches the output', async () => {
    const d = fresh();
    const cs = [theCase(0)];
    cache(d, cs);
    const f = fakes(d, cs);
    f.deps.openaiFetch = async (_u, init) => ({ status: 401, ok: false, text: `bad key ${OAI_KEY} ${init!.headers!.authorization}` });
    expect(await main(['--split', 'dev'], f.deps)).toBe(1);
    const text = f.printed.join('\n');
    expect(text).toContain('failed');
    expect(text).not.toContain(OAI_KEY);
    expect(out(d, 'report.md')).toContain('failed cases');
    // The Jev half stays cached; a rerun repeats only the failed OpenAI half.
    const again = fakes(d, cs);
    expect(await main(['--split', 'dev'], again.deps)).toBe(0);
    expect(again.jevBodies).toHaveLength(0);
    expect(again.openaiBodies.length).toBeGreaterThan(0);
  });

  it('rejects a bad flag', async () => {
    const d = fresh();
    const f = fakes(d, []);
    expect(await main(['--split', 'dev', '--cases', '0'], f.deps)).toBe(2);
    expect(await main([], f.deps)).toBe(2);
  });
});
