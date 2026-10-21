import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SpawnFn } from './claude.js';
import type { Case } from './load.js';
import { saveQuestions, type Question } from './questions.js';
import { main, renderVariants, VARIANTS, type VariantDeps } from './variants.js';
import type { Message } from '../src/types.js';

const root = mkdtempSync(join(tmpdir(), 'variants-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const FACT = 'flamingo-7';
const big = (n: number) => `run ${n}\n${'progress line\n'.repeat(300)}`;
/** Twelve turns; the fact sits in the first result, which the fake Jev drops. */
const history = (): Message[] => [
  { role: 'user', text: 'Fix the loader.', toolUses: [] },
  ...Array.from({ length: 12 }, (_, i): Message[] => {
    const out = i === 0 ? `${big(i)}settled on ${FACT}\n` : big(i);
    return [
      { role: 'user', text: `Step ${i}: go on.`, toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: `t${i}`, tool: 'Bash', input: { command: `step ${i}` }, text: out }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text: out }] },
      { role: 'assistant', text: `Step ${i} done.`, toolUses: [] },
    ];
  }).flat(),
];
const question = (caseId: string): Question => ({ id: `${caseId}:0`, caseId, question: 'What was settled on?', gold: FACT, evidence: FACT, category: 'id', tag: 'tool-result' });

/** Answers FACT when the text holds it; a summary keeps the fact when its input has it. */
const claude = (calls: string[]): SpawnFn => (_argv, { input }) => {
  calls.push(input);
  const text = input.startsWith('Summarize') ? (input.includes(FACT) ? `Summary: ${FACT}.` : 'Summary.') : input.split('QUESTION')[0]!.includes(FACT) ? FACT : 'UNKNOWN';
  return { status: 0, stdout: JSON.stringify({ result: text, modelUsage: { 'claude-sonnet-5-5': {} } }) };
};

const deps = (calls: string[], printed: string[], resultNoul = (k: string) => (k.startsWith('result_') || k.startsWith('err_') || k.startsWith('con_') || k.startsWith('use_') ? 0.01 : 0.9)): VariantDeps => {
  const cacheDir = join(root, `c${calls.length}${printed.length}${Math.random()}`);
  saveQuestions(cacheDir, 'x#1', [question('x#1')], { dropped: 0, model: 'claude-sonnet-5-5' });
  return {
    outDir: join(cacheDir, 'out'),
    cacheDir,
    cases: () => ({ cases: [{ id: 'x#1', transcript: 'x', start: 0, end: 1, chars: 0, estTokens: 1000, builtinSummary: 'S.' } as Case], skipped: 0 }),
    messages: () => history(),
    spawn: claude(calls),
    confirm: async () => true,
    print: (m) => printed.push(m),
    apiKey: () => 'k',
    fetch: async (_url, init) => {
      const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
      const answers = Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: resultNoul(k) }]));
      return { status: 200, ok: true, text: JSON.stringify({ answers }) };
    },
  };
};

describe('variants', () => {
  it('runs every arm through the hook pipeline and writes a report with a verdict per option', async () => {
    const calls: string[] = [];
    const printed: string[] = [];
    const d = deps(calls, printed);
    expect(await main(['--cases', '1'], d)).toBe(0);
    const json = JSON.parse(readFileSync(join(d.outDir, 'variants', 'variants.json'), 'utf8'));
    const arms = json.rows[0].arms;
    expect(Object.keys(arms).sort()).toEqual(['base', 'checks', 'wording', 'hybrid', 'hybrid-orig'].sort().filter((a) => a in arms));
    for (const arm of Object.keys(VARIANTS)) expect(arms[arm].reduction).toBeGreaterThan(0.3);
    // A cut that meets the minimum even without the step and exchange stages runs no hybrid, as in the hook.
    expect(arms.hybrid).toBeUndefined();
    // The checks arm asks five questions per call, so it needs at least as many requests.
    expect(arms.checks.requests).toBeGreaterThanOrEqual(arms.base.requests);
    const report = readFileSync(join(d.outDir, 'variants', 'report.md'), 'utf8');
    expect(report).toMatch(/- stateWording archive: (turn on|keep off) \(recall/);
    expect(report).toMatch(/- resultChecks: (turn on|keep off) \(recall/);
    expect(report).toMatch(/- hybridOriginals: /);
    expect(JSON.stringify(json)).not.toContain('progress line');
  });

  it('measures the hybrid where the cut falls short, and the original older history keeps the dropped fact', async () => {
    const printed: string[] = [];
    // Only the first result goes (it holds the fact): a cut far under the minimum, so the hybrid runs.
    const d = deps([], printed, (k) => (k === 'result_t1' ? 0.01 : 0.9));
    expect(await main(['--cases', '1', '--arms', 'hybrid'], d)).toBe(0);
    const arms = JSON.parse(readFileSync(join(d.outDir, 'variants', 'variants.json'), 'utf8')).rows[0].arms;
    expect(arms.hybrid.pass).toBe(0);
    expect(arms['hybrid-orig'].pass).toBe(1);
    expect(printed.at(-1)).toContain('- hybridOriginals: turn on');
  });

  it('refuses an unknown arm and a missing key', async () => {
    const printed: string[] = [];
    expect(await main(['--arms', 'nope'], deps([], printed))).toBe(2);
    const noKey = { ...deps([], printed), apiKey: () => { throw new Error('TYPESAFE_API_KEY is not set'); } };
    expect(await main([], noKey)).toBe(2);
    expect(printed.at(-1)).toBe('TYPESAFE_API_KEY is not set');
  });

  it('recommends a variant only when it keeps recall and nearly all the reduction', () => {
    const row = (base: number, wording: number, reduction: number) => ({
      id: 'x', questions: 10, arms: { base: { reduction: 0.5, requests: 1, pass: base }, wording: { reduction, requests: 1, pass: wording } },
    });
    expect(renderVariants([row(5, 6, 0.49)])).toContain('- stateWording archive: turn on');
    expect(renderVariants([row(5, 4, 0.6)])).toContain('- stateWording archive: keep off');
    expect(renderVariants([row(5, 6, 0.4)])).toContain('- stateWording archive: keep off');
  });
});
