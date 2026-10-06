import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { trimProse } from '../src/prose.js';
import type { JevAsker, JevQuestions, Message } from '../src/types.js';
import { buildArms, readB } from './arms.js';
import { checkMessages, violations } from './invariants.js';
import type { Case } from './load.js';
import type { Question, Category, Tag } from './questions.js';
import { buildReport, verdict, type Variant } from './report.js';
import type { Metrics, Scored } from './score.js';

const root = mkdtempSync(join(tmpdir(), 'fjev-arms-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const answerAll = (noul: number): JevAsker => ({
  async ask(_state, questions: JevQuestions) {
    return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, noul }])) };
  },
});

const FILLER = 'Sure, I will take a look at this now. Then I will report what I find in detail.';
/** A goal, 8 old turns (filler prose, a Read call with a long result, a Write with a long body), then a short tail. */
function history(): Message[] {
  const out: Message[] = [{ role: 'user', text: 'Fix the parser bug in the config loader.', toolUses: [] }];
  for (let i = 0; i < 8; i++) {
    out.push({
      role: 'assistant',
      text: `${FILLER} Look at \`src/f${i}.ts\` too.`,
      toolUses: [
        { tool_use_id: `t${i}`, tool: 'Read', input: { file_path: `/x/f${i}.ts` } },
        { tool_use_id: `w${i}`, tool: 'Write', input: { file_path: `/x/w${i}.ts`, content: 'const a = 1;\n'.repeat(200) } },
      ],
    });
    out.push({
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [
        { tool_use_id: `t${i}`, text: 'x'.repeat(3000) },
        { tool_use_id: `w${i}`, text: 'ok' },
      ],
    });
  }
  for (let i = 0; i < 6; i++) out.push({ role: i % 2 ? 'assistant' : 'user', text: `tail ${i}`, toolUses: [] });
  return out;
}
const theCase = (builtin?: string): Case => ({
  id: 'c#0-1', transcript: 'x', start: 0, end: 1, chars: 0, estTokens: 1, ...(builtin !== undefined ? { builtinSummary: builtin } : {}),
});

describe('arms', () => {
  it('builds O, T0, BI, S and A; S is T0 when T0 clears 25%; B missing is not covered', async () => {
    const dir = join(root, 'b-empty');
    mkdirSync(dir);
    const a = await buildArms(theCase('BUILTIN SUMMARY'), history(), { asker: answerAll(0) }, dir);
    expect(a.text.O!.length).toBeGreaterThan(a.text.T0!.length);
    expect(a.t0Ratio).toBeGreaterThanOrEqual(0.25);
    expect(a.text.S).toBe(a.text.T0);
    expect(a.text.BI).toBe('BUILTIN SUMMARY');
    expect(a.text.A!.length).toBeLessThan(a.text.T0!.length);
    expect(a.text.B).toBeUndefined();
  });

  it('S is BI when T0 stays under 25%, and O when there is no built-in summary either', async () => {
    const dir = join(root, 'b-empty2');
    mkdirSync(dir);
    const withBi = await buildArms(theCase('BUILTIN SUMMARY'), history(), { asker: answerAll(0.9) }, dir);
    expect(withBi.t0Ratio).toBeLessThan(0.25);
    expect(withBi.text.S).toBe('BUILTIN SUMMARY');
    const without = await buildArms(theCase(), history(), { asker: answerAll(0.9) }, dir);
    expect(without.text.BI).toBeUndefined();
    expect(without.text.S).toBe(without.text.O);
  });

  it('B is the recorded summary, and a missing or malformed file never throws', async () => {
    const dir = join(root, 'b');
    mkdirSync(dir);
    expect(readB(dir, 'nope')).toBeUndefined();
    writeFileSync(join(dir, 'bad.json'), '{not json');
    expect(readB(dir, 'bad')).toBeUndefined();
    writeFileSync(join(dir, 'c#0-1.json'), JSON.stringify({ caseId: 'c#0-1', mode: 'hand', summary: ['line one', 'line two'], keptMessages: 3 }));
    const a = await buildArms(theCase(), history(), { asker: answerAll(0.9) }, dir);
    expect(a.text.B).toBe('line one\nline two');
  });
});

const GOOD: Metrics = { total: 100, recall: 0.97, tokenRecall: 0.99, proseEvidenceRecall: 0.95, inputEvidenceRecall: 0.95, inputByField: {}, wrongRate: 0.01 };
const v = (over: Partial<Metrics> = {}, sRecall = 0.97): Variant => ({ metrics: { ...GOOD, ...over }, sRecall });

describe('verdict', () => {
  const edges: [keyof Metrics, number, number][] = [
    ['recall', 0.95, 0.9499],
    ['tokenRecall', 0.98, 0.9799],
    ['proseEvidenceRecall', 0.9, 0.8999],
    ['inputEvidenceRecall', 0.9, 0.8999],
    ['wrongRate', 0.02, 0.0201],
  ];
  for (const [key, at, under] of edges) {
    it(`${key}: exactly at the bar passes, just under fails`, () => {
      const s = key === 'recall' ? 0.5 : 0.97;
      expect(verdict(v({ [key]: at }, s), undefined).default).toBe('trim');
      const r = verdict(v({ [key]: under }, s), undefined);
      expect(r.default).toBe('off');
      expect(r.reasons.join(' ')).toContain(key);
    });
  }

  it('recall must be at least S minus 0.01: exactly at passes, just under fails', () => {
    expect(verdict(v({ recall: 0.96 }, 0.97), undefined).default).toBe('trim');
    const r = verdict(v({ recall: 0.9599 }, 0.97), undefined);
    expect(r.default).toBe('off');
    expect(r.reasons.join(' ')).toContain('S');
  });

  it('both pass: A wins when B beats it by at most 0.02, B wins by more, the higher recall wins', () => {
    expect(verdict(v({ recall: 0.96 }), v({ recall: 0.98 })).default).toBe('trim');
    expect(verdict(v({ recall: 0.96 }), v({ recall: 0.9801 })).default).toBe('tidy');
    expect(verdict(v({ recall: 0.98 }), v({ recall: 0.96 })).default).toBe('trim');
    expect(verdict(v({ recall: 0.96 }), v({ recall: 0.96 })).default).toBe('trim');
  });

  it('the tie rule uses the shared-case recalls when given', () => {
    expect(verdict(v({ recall: 0.96 }), v({ recall: 0.99 }), { a: 0.96, b: 0.97 }).default).toBe('trim');
    expect(verdict(v({ recall: 0.96 }), v({ recall: 0.97 }), { a: 0.9, b: 0.97 }).default).toBe('tidy');
  });

  it('only one passes: that one wins, however its recall compares', () => {
    expect(verdict(v({ recall: 0.9 }, 0.5), v({ recall: 0.99 })).default).toBe('tidy');
    expect(verdict(v({ recall: 0.96 }), v({ recall: 0.99, wrongRate: 0.05 })).default).toBe('trim');
    expect(verdict(v({ recall: 0.96 }), undefined).default).toBe('trim');
    expect(verdict(undefined, v()).default).toBe('tidy');
  });

  it('neither passes (or nothing was scored): off, with reasons', () => {
    const r = verdict(v({ recall: 0.5 }), v({ wrongRate: 0.2 }));
    expect(r.default).toBe('off');
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(verdict(undefined, undefined).default).toBe('off');
    expect(verdict(v({ recall: NaN }), undefined).default).toBe('off');
  });
});

let qn = 0;
const row = (caseId: string, outcome: Scored['outcome'], tag: Tag = 'assistant-prose', category: Category = 'decision'): Scored => {
  const question: Question = { id: `q${qn++}`, caseId, question: 'q', gold: 'g', evidence: 'e', category, tag };
  return { question, outcome };
};
const rows = (caseId: string, passes: number, wrongs = 0, tag: Tag = 'assistant-prose', category: Category = 'decision'): Scored[] => [
  ...Array.from({ length: passes }, () => row(caseId, 'pass', tag, category)),
  ...Array.from({ length: wrongs }, () => row(caseId, 'wrong', tag, category)),
];

describe('report', () => {
  it('compares A and B on the shared cases only and states the count', () => {
    const r = buildReport({
      S: [...rows('c1', 10), ...rows('c2', 10), ...rows('c3', 10), ...rows('c4', 10)],
      A: [...rows('c1', 10), ...rows('c2', 10), ...rows('c3', 5, 5), ...rows('c4', 10)],
      B: [...rows('c3', 10), ...rows('c4', 10), ...rows('c9', 0, 10)],
    });
    expect(r.comparison?.sharedCases).toBe(2);
    expect(r.comparison?.b.total).toBe(20);
    expect(r.comparison?.a.total).toBe(20);
    expect(r.comparison?.a.recall).toBeCloseTo(0.75);
    expect(r.comparison?.b.recall).toBeCloseTo(1);
    expect(r.arms.A?.metrics.total).toBe(40);
  });

  it('per-tag and per-category metrics come from the arm rows', () => {
    const r = buildReport({ O: [...rows('c1', 3, 1, 'code-body', 'path'), ...rows('c1', 2, 0, 'assistant-prose', 'decision')] });
    expect(r.arms.O?.byTag['code-body']?.recall).toBeCloseTo(0.75);
    expect(r.arms.O?.byTag['assistant-prose']?.total).toBe(2);
    expect(r.arms.O?.byCategory['path']?.total).toBe(4);
  });

  it('without B, the verdict rests on A alone and the report says B is not covered', () => {
    const base = [...rows('c1', 100)];
    const r = buildReport({ S: base, A: base });
    expect(r.comparison).toBeUndefined();
    expect(r.arms.B).toBeUndefined();
    expect(r.verdict.reasons.join(' ')).toMatch(/B/);
  });
});

const user = (text: string): Message => ({ role: 'user', text, toolUses: [] });
const assistantProse: Message = {
  role: 'assistant',
  text: `Okay, let me take a look at this now, and see what I can figure out. Edit \`src/app.ts\` at /x/app.ts for v0.6.1. ${FILLER}`,
  toolUses: [{ tool_use_id: 'e1', tool: 'Write', input: { file_path: '/x/app.ts', content: 'let a = 1;\n'.repeat(100) } }],
};
function inv(): Message[] {
  return [
    user('Please fix the parser. Do not touch `main.ts`.'),
    assistantProse,
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'e1', text: 'ok' }] },
    user('Thanks, okay, sure, whatever you think is right.'),
    { ...assistantProse, toolUses: [{ tool_use_id: 'e2', tool: 'Write', input: { file_path: '/x/b.ts', content: 'let b = 2;\n'.repeat(100) } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'e2', text: 'ok' }] },
    ...Array.from({ length: 6 }, (_, i) => user(`tail ${i}`)),
  ];
}

describe('invariants', () => {
  it('the real trim with a drop-everything asker violates nothing, and does trim', async () => {
    const r = await checkMessages(inv());
    expect(r.violations).toEqual([]);
    expect(r.units).toBeGreaterThan(0);
    expect(r.changed).toBe(true);
  });

  it('catches a trim that alters user text', async () => {
    const r = await checkMessages(inv(), async (...args) => {
      const out = await trimProse(...args);
      out.messages[3] = { ...(out.messages[3] as Message), text: 'Thanks, okay.' };
      return out;
    });
    expect(r.violations.join(' ')).toContain('user');
  });

  it('catches a trim that alters a protected span', async () => {
    const r = await checkMessages(inv(), async (...args) => {
      const out = await trimProse(...args);
      const i = out.messages.findIndex((m) => m.role === 'assistant');
      const m = out.messages[i] as Message;
      out.messages[i] = { ...m, text: m.text.replace('`src/app.ts`', '`src/other.ts`') };
      return out;
    });
    expect(r.violations.join(' ')).toContain('protected');
  });

  it('catches a changed tool id, a dropped input key and a changed non-body field', () => {
    const before = inv();
    const edit = (f: (m: Message) => Message): Message[] => before.map((m, i) => (i === 1 ? f(m) : m));
    const tool = (patch: object) => (m: Message): Message => ({ ...m, toolUses: [{ ...(m.toolUses[0] as object), ...patch } as never] });
    expect(violations(before, edit(tool({ tool_use_id: 'zz' })), 6).join(' ')).toContain('tool');
    expect(violations(before, edit(tool({ input: { content: 'x' } })), 6).join(' ')).toContain('key');
    expect(violations(before, edit(tool({ input: { file_path: '/other.ts', content: 'x' } })), 6).join(' ')).toContain('file_path');
  });

  it('catches an altered pinned message and an altered tool result', () => {
    const before = inv();
    const pinnedEdit = before.map((m, i) => (i === before.length - 1 ? { ...m, text: 'changed' } : m));
    expect(violations(before, pinnedEdit, 6).join(' ')).toContain('pinned');
    const resultEdit = before.map((m, i) => (i === 2 ? { ...m, toolResults: [{ tool_use_id: 'e1', text: 'changed' }] } : m));
    expect(violations(before, resultEdit, 6).join(' ')).toContain('result');
  });

  it('accepts the end mark a cut gives a kept unit that ended in a comma or semicolon (ruling 9)', () => {
    const mk = (text: string): Message[] => [user('q'), { role: 'assistant', text, toolUses: [{ tool_use_id: 'k', tool: 'Read', input: { file_path: '/x' } }] }, ...Array.from({ length: 6 }, (_, i) => user(`t${i}`))];
    expect(violations(mk('Check `a.ts` first;\nsure whatever you like now.'), mk('Check `a.ts` first.'), 6)).toEqual([]);
    expect(violations(mk('Check `a.ts` first;\nsure whatever you like now.'), mk('Check `b.ts` first.'), 6).join(' ')).toContain('protected');
  });

  it('accepts a message removed because all its text was dropped', () => {
    const before = [user('q'), { role: 'assistant' as const, text: FILLER, toolUses: [] }, ...Array.from({ length: 7 }, (_, i) => user(`t${i}`))];
    expect(violations(before, before.filter((_, i) => i !== 1), 6)).toEqual([]);
    expect(violations(before, before.filter((_, i) => i !== 0), 6).length).toBeGreaterThan(0);
  });
});
